// Chat mirror: keep the daemon's chat and this Pi session in sync
//
// The leader is the agent you talk to. There is no separate "assistant" process:
// a leader already runs per host to realize tmux spawns, nobody types in its
// session, and this mirror is role-agnostic — so it doubles as the team's chat
// participant (see my-pizza-team/docs/ASSISTANT_CHAT_V2.md and DESIGN.md "One
// agent to talk to").
//
// Chat v2 inverts the old model: the **Pi session is the conversation**, and the
// daemon is a mirror of it. There are no response turns to claim, no composer
// lock, and no `send_message` tool — the agent just talks.
//
// Only the *designated* chat agent mirrors: the daemon answers `chat: true/false`
// on every inbox poll, so a multi-host team (several leaders) can't double-answer.
//
// Two directions:
//
//   Inbound  daemon → Pi   Poll GET /api/assistant/inbox for queued user
//                          messages, hand each to Pi via sendUserMessage()
//                          (`steer` when mid-run so it lands after the current
//                          tool batch), then ack `delivered`; ack `read` when a
//                          run actually starts.
//
//   Outbound Pi → daemon   Mirror the agent's own output: assistant prose is
//                          split on blank lines into chat bubbles, reasoning
//                          deltas feed the ephemeral "peek behind the …"
//                          buffer, and messages typed in this agent's terminal
//                          are mirrored in as user messages (tmux parity).
//
// The event wiring lives in index.ts (it owns the `pi.on(...)` registrations);
// this class owns the state, throttling, and daemon calls.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "./client.js";
import { splitIntoBubbles } from "./bubbles.js";

const INBOX_POLL_INTERVAL_MS = 1000;
/** Reasoning deltas are coalesced into one POST per window to spare the daemon. */
const THOUGHT_FLUSH_MS = 250;

export class ChatMirror {
  private pi: ExtensionAPI;
  private client: DaemonClient;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  /** Active persona's system-prompt text (null = fall back to Pi's own prompt). */
  private personaContent: string | null = null;

  /** Whether the daemon has designated us as the chat agent. */
  private isChatAgent = false;

  /**
   * True while a session directive is being realized. The replacement session
   * re-registers under the same name moments later, so the caller skips
   * deregistration and the member never flickers offline (which would also let
   * the chat-agent designation hop to another host mid-conversation).
   */
  private rollingSession = false;

  /** Ids handed to Pi but not yet marked read (promoted when a run starts). */
  private delivered = new Set<string>();
  /** True while an agent run is in flight — decides `steer` vs plain delivery. */
  private agentRunning = false;

  /** Pending reasoning text, flushed on a timer. */
  private thoughtBuffer = "";
  private thoughtTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * How much of the *current message's* reasoning has been mirrored.
   *
   * `message_update` carries a cumulative snapshot **per assistant message**, not
   * per run. A run with tool calls produces several messages, and each one's
   * thinking restarts at zero — so this must reset per message. Tracking it per
   * run silently dropped all reasoning after the first tool call (a later, shorter
   * snapshot never exceeded the high-water mark).
   */
  private thoughtSent = 0;

  /** Bubbles already mirrored for the in-flight assistant message. */
  private mirroredParagraphs = new Set<string>();

  /** Callback invoked after a reply is mirrored (for widget updates). */
  public onReplyMirrored: ((bubbles: number) => void) | null = null;

  /**
   * Callback to realize a session directive (`new-session` / `resume-session`).
   * Set by index.ts, which owns the command context needed for Pi's session
   * APIs. Returns the new Pi session path when it can be determined.
   */
  public onSessionDirective: ((action: string, params: Record<string, unknown>) => Promise<void>) | null = null;

  constructor(pi: ExtensionAPI, client: DaemonClient) {
    this.pi = pi;
    this.client = client;
  }

  /** See `rollingSession`: skip deregistration during a chat-driven session roll. */
  get isRollingSession(): boolean {
    return this.rollingSession;
  }

  /**
   * The active persona's system-prompt text, or null when unknown.
   * Read by the `before_agent_start` hook to inject the persona each run.
   */
  get persona(): string | null {
    return this.personaContent;
  }

  /** Refresh the cached persona from the daemon (best-effort). */
  private async refreshPersona(): Promise<void> {
    try {
      const res = await this.client.getPersona();
      // `systemPrompt` is the effective prompt: chat framing + the selected
      // persona's body (or the daemon's default assistant persona).
      this.personaContent = res.systemPrompt || null;
    } catch {
      // Keep the last known persona if the daemon is briefly unreachable.
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    await this.refreshPersona();
    this.pollForWork();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.thoughtTimer) { clearTimeout(this.thoughtTimer); this.thoughtTimer = null; }
  }

  /** Tell the daemon which Pi session backs this chat (enables resume). */
  async reportSession(piSessionPath: string | null): Promise<void> {
    if (!piSessionPath) return;
    await this.client.reportPiSession(piSessionPath).catch(() => {});
  }

  // ─── Inbound: daemon → Pi ──────────────────────────────────────────

  /**
   * Poll the inbox and hand each queued message to Pi. Mid-run messages are
   * delivered as `steer` so they land after the current tool batch instead of
   * being dropped or waiting for the whole run to finish — this is what lets the
   * user interrupt at will (the daemon no longer debounces anything).
   */
  private async pollForWork(): Promise<void> {
    if (!this.running) return;
    try {
      const { chat, messages } = await this.client.getInbox();
      // A non-designated leader stays silent: it neither pulls nor mirrors.
      this.isChatAgent = chat;
      for (const item of messages) {
        const prompt = item.quoted
          ? `> ${item.quoted.replace(/\n/g, "\n> ")}\n\n${item.content}`
          : item.content;
        this.pi.sendUserMessage(prompt, this.agentRunning ? { deliverAs: "steer" } : undefined);
        this.delivered.add(item.id);
      }
      if (messages.length > 0) {
        await this.client.ackInbox(messages.map((m) => m.id), "delivered").catch(() => {});
      }
      // Also pick up session asks (new chat / resume) targeted at this agent.
      await this.pollSessionDirectives();
    } catch {
      // Daemon unreachable — retry on the next tick.
    }
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.pollForWork(), INBOX_POLL_INTERVAL_MS);
  }

  /**
   * Realize session directives the daemon addressed to us. These can't be
   * delivered as tmux keystrokes because they need Pi's in-process session APIs
   * (`ctx.newSession()` / `ctx.switchSession()`).
   */
  private async pollSessionDirectives(): Promise<void> {
    if (!this.onSessionDirective) return;
    const { directives } = await this.client.getSelfDirectives();
    for (const directive of directives) {
      try {
        // Set before queueing the command: the session can be replaced before the
        // next await resumes, and session_shutdown must see the flag.
        this.rollingSession = true;
        await this.onSessionDirective(directive.action, directive.params || {});
        await this.client.completeSelfDirective(directive.id).catch(() => {});
      } catch {
        this.rollingSession = false;
        // A directive we can't realize must leave the queue, or it retries forever.
        await this.client.completeSelfDirective(directive.id, "failed").catch(() => {});
      }
    }
  }

  // ─── Outbound: Pi → daemon ─────────────────────────────────────────

  /**
   * A run started: everything already delivered is now genuinely read, and the
   * reasoning peek buffer belongs to this run.
   */
  async handleAgentStart(): Promise<void> {
    this.agentRunning = true;
    if (!this.isChatAgent) return;
    this.thoughtSent = 0;
    this.mirroredParagraphs.clear();
    await this.refreshPersona();
    await this.client.postThought({ clear: true, thinking: true }).catch(() => {});
    if (this.delivered.size > 0) {
      await this.client.ackInbox([...this.delivered], "read").catch(() => {});
      this.delivered.clear();
    }
  }

  /** The run settled: drop the `…`. The thought buffer is left for peeking. */
  async handleAgentSettled(): Promise<void> {
    this.agentRunning = false;
    if (!this.isChatAgent) return;
    this.flushThoughts();
    await this.client.postThought({ thinking: false }).catch(() => {});
  }

  /**
   * Mirror a reasoning update. Pi streams cumulative snapshots per message, so
   * only the new tail is sent; chunks are coalesced on a short timer.
   */
  handleReasoning(fullText: string): void {
    if (!this.isChatAgent) return;
    if (fullText.length <= this.thoughtSent) return;
    this.thoughtBuffer += fullText.slice(this.thoughtSent);
    this.thoughtSent = fullText.length;
    if (this.thoughtTimer) return;
    this.thoughtTimer = setTimeout(() => {
      this.thoughtTimer = null;
      this.flushThoughts();
    }, THOUGHT_FLUSH_MS);
  }

  private flushThoughts(): void {
    const chunk = this.thoughtBuffer;
    this.thoughtBuffer = "";
    if (!chunk) return;
    this.client.postThought({ chunk }).catch(() => {});
  }

  /**
   * Handle one finished assistant message.
   *
   * Called for **every** assistant message, including ones that are only thinking
   * plus tool calls: the per-message reasoning offset has to reset on the message
   * boundary, and a text-only condition would miss exactly the tool-call messages
   * whose reasoning matters most.
   *
   * Its prose is mirrored as chat bubbles, split on blank lines so a normal
   * markdown reply arrives as a few short messages instead of one wall of text.
   * Paragraphs already mirrored are skipped, so intermediate prose (emitted before
   * tool calls) isn't duplicated when the run continues.
   */
  async handleAssistantMessageEnd(text: string): Promise<void> {
    this.thoughtSent = 0;
    if (!this.isChatAgent || !text.trim()) return;
    const bubbles = splitIntoBubbles(text);
    let sent = 0;
    for (const bubble of bubbles) {
      if (this.mirroredParagraphs.has(bubble)) continue;
      this.mirroredParagraphs.add(bubble);
      const res = await this.client.postBubble(bubble).catch(() => ({ success: false }));
      if (res.success) sent++;
    }
    if (sent > 0) this.onReplyMirrored?.(sent);
  }

  /**
   * Mirror a message the user typed in this agent's terminal into the web chat.
   * This is what makes the tmux pane and the web UI the same conversation.
   */
  async mirrorTerminalInput(text: string): Promise<void> {
    if (!this.isChatAgent) return;
    const trimmed = text.trim();
    // Slash commands are harness control, not conversation.
    if (!trimmed || trimmed.startsWith("/")) return;
    await this.client.mirrorUserMessage(trimmed).catch(() => {});
  }

  /** Report an unrecoverable agent error as a failed bubble. */
  async mirrorError(error: string): Promise<void> {
    this.agentRunning = false;
    if (!this.isChatAgent) return;
    await this.client.postThought({ thinking: false }).catch(() => {});
    await this.client.postBubble(error || "The assistant hit an error.", true).catch(() => {});
  }
}
