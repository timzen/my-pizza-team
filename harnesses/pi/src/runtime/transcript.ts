// Transcript mirror: stream a teammate's Pi session to the daemon — only while watched
//
// Backs the web UI's teammate view (/teammates/:id; my-pizza-team
// docs/TEAMMATE_CHAT.md §3): a live, CLI-ish rendering of what this teammate is
// doing. Watch-only — nothing here ever feeds input *into* Pi.
//
// **Only while watched.** The daemon knows when a browser has the view open; the
// mirror polls that bit (GET /api/agents/:id/transcript/watch) and forwards
// events only while it's set. An unwatched teammate costs nothing. There's no
// backfill — the view starts where watching started.
//
// **Upserts, coalesced.** Streaming prose and tool calls evolve, so entries carry
// a stable key (`msg:<instance>:<n>`, `tool:<toolCallId>`) and the daemon merges
// into the existing entry. Pi's message_update is *cumulative per message*, so
// each update carries the whole message so far — which is exactly what lets a
// viewer who opens mid-reply see all of it. Updates fire per token; they're
// coalesced per key and flushed on a short timer.
//
// Event wiring lives in index.ts (it owns the pi.on registrations); this class
// owns the watch state, buffering, and daemon calls.

/** The slice of DaemonClient this mirror needs (kept narrow so tests can fake it). */
export interface TranscriptClient {
  isTranscriptWatched(): Promise<boolean>;
  postTranscript(entries: Record<string, unknown>[]): Promise<{ watched: boolean }>;
}

type Entry = Record<string, unknown> & { kind: string; key?: string };

/** Pi content parts, loosely typed (AgentMessage content is a union). */
interface ContentPart { type: string; text?: string; thinking?: string }
interface MessageLike { role?: string; content?: ContentPart[] | string }

const WATCH_POLL_MS = 2000;
const FLUSH_MS = 150;
/** Tool output shown in the view is a preview; the full thing lives in the session. */
const MAX_RESULT_CHARS = 4000;
/** Per string arg (e.g. a `write` tool's file content). */
const MAX_ARG_CHARS = 1000;
/** The work prompt can be long; the view collapses it anyway. */
const MAX_USER_CHARS = 20_000;

export class TranscriptMirror {
  private client: TranscriptClient;
  private watched = false;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pending entries in order; keyed ones are merged in place (see push). */
  private pending: Entry[] = [];
  private pendingByKey = new Map<string, Entry>();

  /** Distinguishes message keys across the fresh session each work item gets. */
  private instance: string;
  private messageCount = 0;
  private currentMessageKey: string | null = null;
  /**
   * Texts handed to Pi from the web composer, awaiting their `input` event.
   * Pi reports those as source "extension" — the same as the work prompt — so
   * this is how the view can label them as yours.
   */
  private expectedWebInputs: string[] = [];

  private pollMs: number;
  private flushMs: number;

  constructor(client: TranscriptClient, opts: { pollMs?: number; flushMs?: number; instance?: string } = {}) {
    this.client = client;
    this.pollMs = opts.pollMs ?? WATCH_POLL_MS;
    this.flushMs = opts.flushMs ?? FLUSH_MS;
    this.instance = opts.instance ?? Date.now().toString(36);
  }

  get isWatched(): boolean {
    return this.watched;
  }

  /**
   * Start polling the watch bit. A fresh extension instance means a fresh Pi
   * session (teammates take one per work item), so if someone is already
   * watching, the view gets a session divider.
   */
  async start(): Promise<void> {
    this.running = true;
    await this.pollWatched();
    this.push({ kind: "session" });
    this.schedulePoll();
  }

  /** Stop polling; best-effort flush of anything pending. */
  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    this.flush();
  }

  // ─── Pi events → entries ───────────────────────────────────────────

  /** A web-composer message is about to be handed to Pi (see expectedWebInputs). */
  expectWebInput(text: string): void {
    this.expectedWebInputs.push(text);
    if (this.expectedWebInputs.length > 20) this.expectedWebInputs.shift();
  }

  /**
   * User input: the work prompt (extension), someone typing in tmux
   * (interactive), or a web-composer message (extension, but expected).
   * `streamingBehavior` is set when it arrived mid-run (queued / steer).
   */
  onInput(text: string, source: string, streamingBehavior?: string): void {
    let origin = source === "interactive" ? "tui" : "extension";
    const i = this.expectedWebInputs.indexOf(text);
    if (origin === "extension" && i !== -1) {
      this.expectedWebInputs.splice(i, 1);
      origin = "web";
    }
    const entry: Entry = { kind: "user", text: clip(text, MAX_USER_CHARS), origin };
    if (streamingBehavior === "steer" || streamingBehavior === "followUp") entry.delivery = streamingBehavior;
    this.push(entry);
  }

  onAgentStart(): void {
    this.push({ kind: "run", state: "start" });
  }

  onAgentEnd(): void {
    this.push({ kind: "run", state: "end" });
    this.flushSoon(0);
  }

  /**
   * A message began. Assistant messages get a key even while unwatched, so a
   * viewer who arrives mid-message still upserts into one entry.
   */
  onMessageStart(message: MessageLike): void {
    if (message?.role !== "assistant") return;
    this.currentMessageKey = `msg:${this.instance}:${++this.messageCount}`;
  }

  /** Streaming update (cumulative) or the final message — same handling. */
  onMessageUpdate(message: MessageLike): void {
    if (message?.role !== "assistant") return;
    if (!this.currentMessageKey) this.onMessageStart(message);
    const { text, thinking } = splitContent(message);
    this.push({ kind: "message", key: this.currentMessageKey!, text, thinking });
  }

  onMessageEnd(message: MessageLike): void {
    if (message?.role !== "assistant") return;
    this.onMessageUpdate(message);
    this.currentMessageKey = null;
  }

  onToolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.push({ kind: "tool", key: `tool:${toolCallId}`, name: toolName, args: clipArgs(args), state: "running" });
  }

  onToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    this.push({
      kind: "tool",
      key: `tool:${toolCallId}`,
      name: toolName,
      state: isError ? "error" : "done",
      result: clip(resultText(result), MAX_RESULT_CHARS),
    });
  }

  // ─── Buffering + transport ─────────────────────────────────────────

  /**
   * Queue an entry (dropped when unwatched). A keyed entry already pending is
   * merged in place — a tool's start and end in one flush window keep the args,
   * and a burst of token updates collapses to the latest text.
   */
  private push(entry: Entry): void {
    if (!this.watched) return;
    const existing = entry.key ? this.pendingByKey.get(entry.key) : undefined;
    if (existing) {
      Object.assign(existing, entry);
    } else {
      this.pending.push(entry);
      if (entry.key) this.pendingByKey.set(entry.key, entry);
    }
    this.flushSoon(this.flushMs);
  }

  private flushSoon(ms: number): void {
    if (this.flushTimer && ms > 0) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, ms);
  }

  private flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const batch = this.pending;
    this.pending = [];
    this.pendingByKey.clear();
    if (batch.length === 0 || !this.watched) return;
    this.client.postTranscript(batch)
      .then((res) => { this.watched = res.watched; })
      // A live view: a lost batch isn't worth retrying (the next update of a
      // keyed entry carries its full content anyway).
      .catch(() => {});
  }

  private async pollWatched(): Promise<void> {
    try {
      this.watched = await this.client.isTranscriptWatched();
    } catch {
      this.watched = false; // daemon unreachable — don't buffer toward nobody
    }
    if (!this.watched) { this.pending = []; this.pendingByKey.clear(); }
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      await this.pollWatched();
      this.schedulePoll();
    }, this.pollMs);
  }
}

// ─── Helpers (exported for tests) ────────────────────────────────────

/** Split an assistant message into its prose and its reasoning. */
export function splitContent(message: MessageLike): { text: string; thinking: string } {
  if (typeof message.content === "string") return { text: message.content, thinking: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const part of message.content || []) {
    if (part.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (part.type === "thinking" && typeof part.thinking === "string") thinking.push(part.thinking);
  }
  return { text: text.join("\n\n"), thinking: thinking.join("\n\n") };
}

/** A tool result's human-readable text (Pi results are `{ content: [...] }`). */
export function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((p: ContentPart) => (p?.type === "text" && typeof p.text === "string" ? p.text : p?.type ? `[${p.type}]` : ""))
      .filter(Boolean)
      .join("\n");
  }
  try { return JSON.stringify(result); } catch { return String(result); }
}

/** Clip long top-level string args (a `write` tool's content, a huge `edit`). */
export function clipArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? clip(v, MAX_ARG_CHARS) : v;
  }
  return out;
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}
