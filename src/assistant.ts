// Assistant work loop: answer pending conversation turns
//
// The assistant is a dedicated Pi instance that answers messages in the
// daemon's assistant conversation. It operates as a pure daemon client — no
// local store, no filesystem state.
//
// Lifecycle:
// 1. Register with daemon as { role: "assistant" } via POST /api/agents/register
// 2. Poll GET /api/assistant/next for the next pending assistant turn
// 3. Claim with POST /api/assistant/messages/:id/claim
// 4. Execute the request via pi.sendUserMessage() (triggers Pi agent loop)
// 5. On agent_end, complete with POST /api/assistant/messages/:id/complete
// 6. Send heartbeats via POST /api/agents/heartbeat (every 30s)
// 7. On shutdown, deregister via DELETE /api/agents/:id
//
// The persistent Pi session retains conversation context across turns, so each
// turn only needs the latest user message as its prompt.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./client.js";

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

export class AssistantLoop {
  private pi: ExtensionAPI;
  private client: DaemonClient;
  private running = false;
  private currentItemId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Active persona's system-prompt text (null = default assistant). */
  private personaContent: string | null = null;

  /** Callback invoked when an item is completed (for widget updates) */
  public onItemComplete: ((itemId: string, summary: string) => void) | null = null;

  constructor(pi: ExtensionAPI, client: DaemonClient) {
    this.pi = pi;
    this.client = client;
  }

  /** Whether the assistant is currently processing a queue item */
  get isWorking(): boolean {
    return this.currentItemId !== null;
  }

  /** The ID of the currently processing queue item (null if idle) */
  get currentItem(): string | null {
    return this.currentItemId;
  }

  /**
   * The active persona's system-prompt text, or null for the default assistant.
   * Read by the `before_agent_start` hook to inject the persona each turn.
   */
  get persona(): string | null {
    return this.personaContent;
  }

  /** Refresh the cached persona from the daemon (best-effort). */
  private async refreshPersona(): Promise<void> {
    try {
      const res = await this.client.getPersona();
      // `systemPrompt` is the effective prompt: the selected persona's body, or
      // the daemon's default assistant persona when none is selected.
      this.personaContent = res.systemPrompt || null;
    } catch {
      // Keep the last known persona if the daemon is briefly unreachable.
    }
  }

  /** Start the poll loop and heartbeat */
  async start(): Promise<void> {
    this.running = true;
    this.startHeartbeat();
    this.pollForWork();
  }

  /** Stop the poll loop and heartbeat */
  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const status = this.currentItemId ? "working" : "idle";
      this.client.heartbeat(status).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ─── Poll → Claim → Execute ───────────────────────────────────────

  private async pollForWork(): Promise<void> {
    if (!this.running || this.currentItemId) {
      this.schedulePoll();
      return;
    }

    try {
      const response = await this.client.getNextQueueItem();

      if (response.item) {
        const claim = await this.client.claimQueueItem(response.item.id);
        if (claim.success) {
          this.currentItemId = response.item.id;
          this.client.heartbeat("working").catch(() => {});
          await this.executeItem(response.item);
        } else {
          // Already claimed (shouldn't happen for single assistant, but handle gracefully)
          this.schedulePoll();
        }
      } else {
        // Queue is empty — keep polling
        this.schedulePoll();
      }
    } catch {
      // Daemon unreachable — retry on next poll
      this.schedulePoll();
    }
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.pollForWork(), POLL_INTERVAL_MS);
  }

  /**
   * Execute a queue item by sending the user's message to the Pi agent. The
   * assistant's role framing comes from its persona (injected as the system
   * prompt by the before_agent_start hook), so the message is sent verbatim.
   * The agent_end event handler (registered in index.ts) will call
   * handleAgentComplete when the agent finishes.
   */
  private async executeItem(item: { id: string; prompt: string }): Promise<void> {
    // Refresh the persona so the before_agent_start hook injects the current one.
    await this.refreshPersona();
    this.pi.sendUserMessage(item.prompt, { deliverAs: "followUp" });
  }

  // ─── Completion Handlers ───────────────────────────────────────────

  /**
   * Called by the agent_end handler when the Pi agent finishes processing.
   * Reports the result back to the daemon and resumes polling.
   */
  async handleAgentComplete(lastMessage: string): Promise<void> {
    if (!this.currentItemId) return;

    const itemId = this.currentItemId;
    const summary = lastMessage.slice(0, 1000);

    try {
      await this.client.completeQueueItem(itemId, summary, false);
    } catch {
      // If reporting fails, still move on — item will time out on daemon side
    }

    this.currentItemId = null;
    this.client.heartbeat("idle").catch(() => {});
    this.onItemComplete?.(itemId, summary);
    this.schedulePoll();
  }

  /**
   * Called if the agent encounters an unrecoverable error.
   * Marks the item as failed so it doesn't block the queue.
   */
  async handleAgentError(error: string): Promise<void> {
    if (!this.currentItemId) return;

    const itemId = this.currentItemId;
    try {
      await this.client.completeQueueItem(itemId, error, true);
    } catch {
      // Move on regardless
    }

    this.currentItemId = null;
    this.client.heartbeat("idle").catch(() => {});
    this.schedulePoll();
  }
}
