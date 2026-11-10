// Transcript mirror: stream an agent's Pi session to the daemon — only while watched
//
// Backs the web UI's teammate view (/teammates/:id; my-pizza-team
// docs/DESIGN.md "Watching and Pairing with a Teammate"): a live, CLI-ish rendering of what this teammate is
// doing. Watch-only — nothing here ever feeds input *into* Pi.
//
// **Only while watched.** The daemon knows when a browser has the view open; the
// mirror polls that bit (GET /api/agents/:id/transcript/watch) and forwards
// events only while it's set. An unwatched teammate costs nothing.
//
// **Backfill when watching starts.** Given a history source (`setHistory`; the
// Pi wiring reads the session manager's current branch, which Pi already holds
// in memory), the mirror sends the session so far as one backfill batch the
// moment a watching period starts — and only then, so an unwatched agent still
// costs nothing — then resumes live streaming. Past messages go through the
// same entry builders as live events (one mapping), and keep the same keys
// (`msg:` keys come from the message's timestamp, `tool:` keys from the call
// id), so the daemon merges the seam instead of duplicating it. A short tail
// of what happened while unwatched covers the moment between a Pi event and
// its message landing in the session. The backfill is capped
// (MAX_BACKFILL_ENTRIES / MAX_BACKFILL_CHARS) and says how much it left out. A
// daemon too old to take one (its watch poll doesn't say `backfill: true`)
// gets today's live-only stream.
//
// **Upserts, coalesced.** Streaming prose and tool calls evolve, so entries carry
// a stable key (`msg:<instance>:t<timestamp>`, or a counter for a message with
// no timestamp; `tool:<toolCallId>`) and the daemon merges
// into the existing entry. Pi's message_update is *cumulative per message*, so
// each update carries the whole message so far — which is exactly what lets a
// viewer who opens mid-reply see all of it. Updates fire per token; they're
// coalesced per key and flushed on a short timer.
//
// Event wiring lives in ../session-transcript.ts — one function shared by the
// teammate and the leader (the assistant's terminal mode), so both views are fed
// identically; this class owns the watch state, buffering, and daemon calls.

import type { TranscriptBackfill, TranscriptWatchResponse } from "../shared/agent-protocol.ts";

/** The slice of DaemonClient this mirror needs (kept narrow so tests can fake it). */
export interface TranscriptClient {
  getTranscriptWatch(): Promise<TranscriptWatchResponse>;
  postTranscript(entries: Record<string, unknown>[], backfill?: TranscriptBackfill): Promise<{ watched: boolean }>;
}

type Entry = Record<string, unknown> & { kind: string; key?: string };

/** Pi content parts, loosely typed (AgentMessage content is a union; `toolCall` parts carry id/name/arguments). */
interface ContentPart { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }

/**
 * A Pi message, loosely typed: what live events carry and what the session
 * history holds (user, assistant, and toolResult roles; others are skipped).
 */
export interface MessageLike {
  role?: string;
  content?: ContentPart[] | string;
  /** Epoch ms; an assistant message's is set when its request starts, so it's stable while it streams. */
  timestamp?: number;
  /** toolResult only. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

const WATCH_POLL_MS = 2000;
const FLUSH_MS = 150;
/** Tool output shown in the view is a preview; the full thing lives in the session. */
const MAX_RESULT_CHARS = 4000;
/** Per string arg (e.g. a `write` tool's file content). */
const MAX_ARG_CHARS = 1000;
/** The work prompt can be long; the view collapses it anyway. */
const MAX_USER_CHARS = 20_000;
/** A backfill sends at most the newest this many entries of the session… */
export const MAX_BACKFILL_ENTRIES = 200;
/** …and at most this much JSON, so a session of huge messages stays one sane POST. */
export const MAX_BACKFILL_CHARS = 400_000;
/** Entries remembered while unwatched, to cover the seam (see remember). */
const RECENT_MAX = 8;

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

  /** The session so far, when this harness can provide it (setHistory). */
  private history: (() => readonly MessageLike[]) | null = null;
  /** The daemon's last watch poll said it accepts a backfill. */
  private canBackfill = false;
  /** A run is in flight (tracked watched or not, so a backfill can say so). */
  private agentRunning = false;
  /** The last few entries built while unwatched (see remember). */
  private recent: Entry[] = [];
  /** Posts go out one at a time, so a backfill always lands before what follows it. */
  private sendChain: Promise<unknown> = Promise.resolve();

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
   * Where the session so far comes from, for the backfill a watching period
   * starts with. Read only then. Without one (e.g. a harness with no session
   * history) the view is live-only from the "watching from" marker.
   */
  setHistory(source: () => readonly MessageLike[]): void {
    this.history = source;
  }

  /**
   * Start polling the watch bit. A fresh extension instance means a fresh Pi
   * session (teammates take one per work item), so if someone is already
   * watching, the view gets a session divider — or, for a session that already
   * has history (a resumed one), its backfill.
   */
  async start(): Promise<void> {
    this.running = true;
    await this.pollWatched(true);
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
    this.push(userEntry(text, origin, streamingBehavior));
  }

  onAgentStart(): void {
    this.agentRunning = true;
    this.push({ kind: "run", state: "start" });
  }

  onAgentEnd(): void {
    this.agentRunning = false;
    this.push({ kind: "run", state: "end" });
    this.flushSoon(0);
  }

  /**
   * A message began. Assistant messages get a key even while unwatched, so a
   * viewer who arrives mid-message still upserts into one entry.
   */
  onMessageStart(message: MessageLike): void {
    if (message?.role !== "assistant") return;
    this.currentMessageKey = this.messageKey(message);
  }

  /** Streaming update (cumulative) or the final message — same handling. */
  onMessageUpdate(message: MessageLike): void {
    if (message?.role !== "assistant") return;
    if (!this.currentMessageKey) this.onMessageStart(message);
    this.push(messageEntry(this.currentMessageKey!, message));
  }

  onMessageEnd(message: MessageLike): void {
    if (message?.role !== "assistant") return;
    this.onMessageUpdate(message);
    this.currentMessageKey = null;
  }

  onToolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.push(toolStartEntry(toolCallId, toolName, args));
  }

  onToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    this.push(toolEndEntry(toolCallId, toolName, result, isError));
  }

  /**
   * An assistant message's upsert key. From its timestamp when it has one, so a
   * message seen live and the same message read back from the session get the
   * same key (the backfill seam); else a per-instance counter.
   */
  private messageKey(message: MessageLike): string {
    return typeof message.timestamp === "number"
      ? `msg:${this.instance}:t${message.timestamp}`
      : `msg:${this.instance}:${++this.messageCount}`;
  }

  // ─── Session history → entries (the backfill) ──────────────────────

  /**
   * Past session messages as transcript entries, through the same builders the
   * live events use: a user message is a `user` entry, an assistant message its
   * `message` entry plus a running `tool` entry per tool call, and a tool
   * result completes that entry by key. Other roles (system, custom, bash) have
   * no live counterpart, so they're skipped. Origin isn't recorded in the
   * session, so past input carries none (no `[you]` / `[terminal]` tag).
   */
  historyEntries(messages: readonly MessageLike[]): Entry[] {
    const list: Entry[] = [];
    const byKey = new Map<string, Entry>();
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "user") {
        const text = userText(m);
        if (text) mergeEntry(list, byKey, userEntry(text, "extension"));
      } else if (m.role === "assistant") {
        mergeEntry(list, byKey, messageEntry(this.messageKey(m), m));
        for (const part of Array.isArray(m.content) ? m.content : []) {
          if (part?.type === "toolCall" && typeof part.id === "string") {
            mergeEntry(list, byKey, toolStartEntry(part.id, part.name ?? "tool", part.arguments));
          }
        }
      } else if (m.role === "toolResult" && typeof m.toolCallId === "string") {
        mergeEntry(list, byKey, toolEndEntry(m.toolCallId, m.toolName ?? "tool", m, m.isError === true));
      }
    }
    return list;
  }

  /**
   * The backfill for a watching period starting now: the session so far, then
   * what the session doesn't hold yet (the `recent` tail — a message whose
   * message_end fired but isn't persisted, a tool result in flight, input not
   * yet turned into a user message), then a run marker if one is in flight —
   * capped to the newest entries. Null when there's no history source or it fails.
   */
  buildBackfill(): { entries: Entry[]; omitted: number } | null {
    if (!this.history) return null;
    let messages: readonly MessageLike[];
    try { messages = this.history(); } catch { return null; }
    const entries = this.historyEntries(messages);
    const byKey = new Map<string, Entry>();
    for (const e of entries) if (e.key) byKey.set(e.key, e);
    for (const e of this.recent) {
      if (e.key) { mergeEntry(entries, byKey, { ...e }); continue; }
      // Unkeyed input: already in the session if a user entry has its text
      // (the live one wins — it knows the origin and delivery).
      let same: Entry | undefined;
      for (let i = entries.length - 1; i >= 0 && !same; i--) {
        if (entries[i]!.kind === "user" && entries[i]!.text === e.text) same = entries[i];
      }
      if (same) Object.assign(same, e);
      else entries.push({ ...e });
    }
    // A tool-call-only message renders nothing; don't let it count toward the cap.
    const visible = entries.filter((e) => e.kind !== "message" || e.text || e.thinking);
    if (this.agentRunning) visible.push({ kind: "run", state: "start" });
    return capBackfill(visible);
  }

  // ─── Buffering + transport ─────────────────────────────────────────

  /**
   * Queue an entry (unwatched, only remembered for the seam). A keyed entry
   * already pending is merged in place — a tool's start and end in one flush
   * window keep the args, and a burst of token updates collapses to the latest text.
   */
  private push(entry: Entry): void {
    if (!this.watched) { this.remember(entry); return; }
    mergeEntry(this.pending, this.pendingByKey, entry);
    this.flushSoon(this.flushMs);
  }

  /**
   * Keep the last few entries built while unwatched (only when a backfill is
   * possible). Pi fires an event before the message lands in the session, so a
   * watch that starts in between would otherwise miss it: the backfill adds
   * these where the session lacks them. A handful of in-memory merges — still
   * nothing sent, nothing read.
   */
  private remember(entry: Entry): void {
    if (!this.history || entry.kind === "run" || entry.kind === "session") return;
    const existing = entry.key ? this.recent.find((e) => e.key === entry.key) : undefined;
    if (existing) { Object.assign(existing, entry); return; }
    this.recent.push({ ...entry });
    if (this.recent.length > RECENT_MAX) this.recent.shift();
  }

  /**
   * A watching period began: send the backfill (where the daemon takes one and
   * there's a history source), else — at start — the session divider. At start,
   * an empty session sends a divider rather than an empty backfill, which would
   * blank a view that's still showing the previous session.
   */
  private beginWatching(atStart: boolean): void {
    const backfill = this.canBackfill ? this.buildBackfill() : null;
    this.recent = [];
    if (backfill && !(atStart && backfill.entries.length === 0)) {
      this.send(backfill.entries, { omitted: backfill.omitted });
    } else if (atStart) {
      this.push({ kind: "session" });
    }
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
    this.send(batch);
  }

  /** Post a batch after any still in flight (a backfill must land before the live entries after it). */
  private send(batch: Entry[], backfill?: TranscriptBackfill): void {
    this.sendChain = this.sendChain
      .then(() => this.client.postTranscript(batch, backfill))
      .then((res) => { this.watched = res.watched; })
      // A live view: a lost batch isn't worth retrying (the next update of a
      // keyed entry carries its full content anyway).
      .catch(() => {});
  }

  private async pollWatched(atStart = false): Promise<void> {
    const was = this.watched;
    try {
      const res = await this.client.getTranscriptWatch();
      this.watched = !!res.watched;
      this.canBackfill = res.backfill === true;
    } catch {
      this.watched = false; // daemon unreachable — don't buffer toward nobody
    }
    if (!this.watched) { this.pending = []; this.pendingByKey.clear(); return; }
    if (!was) this.beginWatching(atStart);
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      await this.pollWatched();
      this.schedulePoll();
    }, this.pollMs);
  }
}

// ─── Entry builders: the one mapping, for live events and history alike ─

function userEntry(text: string, origin: string, streamingBehavior?: string): Entry {
  const entry: Entry = { kind: "user", text: clip(text, MAX_USER_CHARS), origin };
  if (streamingBehavior === "steer" || streamingBehavior === "followUp") entry.delivery = streamingBehavior;
  return entry;
}

function messageEntry(key: string, message: MessageLike): Entry {
  const { text, thinking } = splitContent(message);
  return { kind: "message", key, text, thinking };
}

function toolStartEntry(toolCallId: string, toolName: string, args: unknown): Entry {
  return { kind: "tool", key: `tool:${toolCallId}`, name: toolName, args: clipArgs(args), state: "running" };
}

function toolEndEntry(toolCallId: string, toolName: string, result: unknown, isError: boolean): Entry {
  return {
    kind: "tool",
    key: `tool:${toolCallId}`,
    name: toolName,
    state: isError ? "error" : "done",
    result: clip(resultText(result), MAX_RESULT_CHARS),
  };
}

/** Append an entry, or merge it into the one with its key (a tool's end into its start). */
function mergeEntry(list: Entry[], byKey: Map<string, Entry>, entry: Entry): void {
  const existing = entry.key ? byKey.get(entry.key) : undefined;
  if (existing) {
    Object.assign(existing, entry);
  } else {
    list.push(entry);
    if (entry.key) byKey.set(entry.key, entry);
  }
}

// ─── Helpers (exported for tests) ────────────────────────────────────

/**
 * Keep the newest entries within MAX_BACKFILL_ENTRIES and MAX_BACKFILL_CHARS
 * (always at least the newest one); `omitted` counts the rest.
 */
export function capBackfill(
  entries: Entry[],
  maxEntries = MAX_BACKFILL_ENTRIES,
  maxChars = MAX_BACKFILL_CHARS,
): { entries: Entry[]; omitted: number } {
  let start = entries.length;
  let chars = 0;
  while (start > 0 && entries.length - start < maxEntries) {
    const size = JSON.stringify(entries[start - 1]).length;
    if (start < entries.length && chars + size > maxChars) break;
    chars += size;
    start--;
  }
  return { entries: entries.slice(start), omitted: start };
}

/** A user message's text (its text parts; an image is a placeholder). */
export function userText(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  return (message.content || [])
    .map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : p?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

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
