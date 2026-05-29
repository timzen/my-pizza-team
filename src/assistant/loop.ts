// Assistant work loop: poll queue → claim → execute → report
//
// The assistant polls the leader's queue for pending items, claims them,
// sends the prompt as a user message (triggering Pi's agent loop), then
// reports the result back when the agent finishes.
//
// Unlike the teammate work loop, the assistant:
// - Processes free-form prompts (not structured task descriptions)
// - Has access to leader tools (create stories, tasks, etc.)
// - Can save memories via the API
// - Doesn't follow story/task workflow states
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantClient } from "./client.js";

const POLL_INTERVAL_MS = 5000; // 5 seconds between polls
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

export class AssistantLoop {
  private pi: ExtensionAPI;
  private client: AssistantClient;
  private running = false;
  private currentItemId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pi: ExtensionAPI, client: AssistantClient) {
    this.pi = pi;
    this.client = client;
  }

  get isWorking(): boolean {
    return this.currentItemId !== null;
  }

  get currentItem(): string | null {
    return this.currentItemId;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startHeartbeat();
    this.pollForWork();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const status = this.currentItemId ? "working" : "idle";
      this.client.heartbeat(status).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async pollForWork(): Promise<void> {
    if (!this.running || this.currentItemId) {
      this.schedulePoll();
      return;
    }

    try {
      const response = await this.client.getNextItem();

      if (response.item) {
        const claim = await this.client.claimItem(response.item.id);
        if (claim.success) {
          this.currentItemId = response.item.id;
          this.client.heartbeat("working").catch(() => {});
          await this.executeItem(response.item);
        } else {
          // Already claimed by something else (shouldn't happen for single assistant)
          this.schedulePoll();
        }
      } else {
        this.schedulePoll();
      }
    } catch {
      // Server unreachable, retry later
      this.schedulePoll();
    }
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.pollForWork(), POLL_INTERVAL_MS);
  }

  private async executeItem(item: { id: string; prompt: string }): Promise<void> {
    const prompt = `## Assistant Request\n\n${item.prompt}\n\n---\nYou are the team assistant. Execute this request using your available tools (create stories, add tasks, edit stories, spawn teammates, save memories, etc.). When done, provide a brief summary of what you accomplished.`;

    this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    // The agent_end event handler (registered in index.ts) will call handleAgentComplete
  }

  /** Called by the agent_end handler when the agent finishes processing */
  async handleAgentComplete(lastMessage: string): Promise<void> {
    if (!this.currentItemId) return;

    const itemId = this.currentItemId;
    const summary = lastMessage.slice(0, 1000);

    try {
      await this.client.completeItem(itemId, summary, false);
    } catch {
      // If reporting fails, still move on
    }

    this.currentItemId = null;
    this.client.heartbeat("idle").catch(() => {});
    this.schedulePoll();
  }

  /** Called if the agent fails/errors */
  async handleAgentError(error: string): Promise<void> {
    if (!this.currentItemId) return;

    const itemId = this.currentItemId;
    try {
      await this.client.completeItem(itemId, error, true);
    } catch {
      // Move on
    }

    this.currentItemId = null;
    this.client.heartbeat("idle").catch(() => {});
    this.schedulePoll();
  }
}
