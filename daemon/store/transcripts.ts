/**
 * daemon/store/transcripts.ts — Live teammate transcripts (watch-only).
 *
 * Backs the teammate view (`/teammates/:id`, docs/DESIGN.md "Watching and Pairing with a Teammate"): a
 * CLI-ish, live rendering of what a teammate's Pi session is doing. Purely
 * in-memory — it's a live view, not a record (the WorkItem thread is the
 * record), so a daemon restart simply starts it over.
 *
 * **Streams only while watched.** Opening the view subscribes to the SSE
 * stream, which registers a *viewer*. A member with ≥1 viewer — or whose last
 * viewer left less than `WATCH_GRACE_MS` ago, so hopping between pages doesn't
 * flap — is *watched*; the extension polls that bit and only mirrors events
 * while it's set. An unwatched teammate costs nothing. A `watch` marker
 * records where each watching period begins.
 *
 * **Backfill replaces the buffer.** When a watching period starts, an agent
 * that can (the Pi extension; the watch poll advertises `backfill: true`) reads
 * its current session and posts it as one backfill batch. That batch *is* the
 * session so far, so it replaces the buffer — the `watch` marker and any stale
 * entries from earlier watching periods — and viewers get a fresh `hello`. A
 * capped backfill opens with a `backfill` marker counting what was left out. An
 * older agent never sends one, so its view keeps the `watch` marker.
 *
 * **Entries are upserts.** Streaming prose and tool calls change over time, so
 * the agent sends entries with a stable `key` (`msg:…`, `tool:…`) and the
 * buffer shallow-merges into the existing entry, keeping its `seq` (its place
 * in the transcript). That's what lets a viewer who opens mid-reply see the
 * whole message on the next update (Pi's updates are cumulative per message),
 * and a tool end whose start was missed still lands as a standalone entry.
 *
 * The buffer is a per-member ring (capped by entry count, with long strings
 * clipped), kept across viewer disconnects so navigating away and back doesn't
 * blank the view.
 */

// ─── Types ──────────────────────────────────────────────────────────

// The wire shapes live in shared/protocol.ts (the UI reads them too).
import type { TranscriptEntry, TranscriptEntryBody, TranscriptInputOrigin } from "../../shared/protocol.ts";

export type { TranscriptEntry, TranscriptEntryBody, TranscriptInputOrigin };

/** What the agent posts: an entry body, optionally keyed for upsert. */
export type TranscriptInput = TranscriptEntryBody & { key?: string };

/**
 * Pushed to stream subscribers for a member: an upsert, or (after a backfill)
 * the whole replaced buffer.
 */
export type TranscriptEvent =
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "hello"; entries: TranscriptEntry[] };

// ─── Limits ─────────────────────────────────────────────────────────

/** Entries kept per member; the oldest fall off first. */
const MAX_ENTRIES = 500;
/** Any single string field longer than this is clipped (defense in depth — the
 *  extension clips tool output far shorter). */
const MAX_FIELD_CHARS = 64_000;
/** A member stays "watched" this long after its last viewer leaves. */
export const WATCH_GRACE_MS = 30_000;

const KINDS = new Set(["session", "user", "run", "message", "tool", "watch", "backfill"]);
/** Kinds only the daemon inserts; an agent can't forge them. */
const DAEMON_KINDS = new Set(["watch", "backfill"]);

// ─── Store ──────────────────────────────────────────────────────────

interface MemberTranscript {
  entries: TranscriptEntry[];
  viewers: Set<(event: TranscriptEvent) => void>;
  /** When the last viewer left (0 = never had one). */
  lastViewerLeftAt: number;
}

export class TeammateTranscripts {
  private members = new Map<string, MemberTranscript>();
  private seq = 0;

  private now: () => number;

  /** Injectable clock, so the watch grace is testable. */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private get(memberId: string): MemberTranscript {
    let t = this.members.get(memberId);
    if (!t) {
      t = { entries: [], viewers: new Set(), lastViewerLeftAt: 0 };
      this.members.set(memberId, t);
    }
    return t;
  }

  /** Is anyone watching this member (or did they just leave)? */
  isWatched(memberId: string): boolean {
    const t = this.members.get(memberId);
    if (!t) return false;
    if (t.viewers.size > 0) return true;
    return t.lastViewerLeftAt > 0 && this.now() - t.lastViewerLeftAt < WATCH_GRACE_MS;
  }

  /** The buffered transcript, oldest first. */
  getEntries(memberId: string): TranscriptEntry[] {
    return [...(this.members.get(memberId)?.entries ?? [])];
  }

  /**
   * Start watching a member. A watching period that begins from "unwatched"
   * (not a page hop inside the grace window) drops a `watch` marker, so the
   * view shows where live coverage starts. Returns the unsubscribe function.
   */
  watch(memberId: string, fn: (event: TranscriptEvent) => void): () => void {
    const wasWatched = this.isWatched(memberId);
    const t = this.get(memberId);
    t.viewers.add(fn);
    if (!wasWatched) this.append(memberId, { kind: "watch" });
    return () => {
      t.viewers.delete(fn);
      if (t.viewers.size === 0) t.lastViewerLeftAt = this.now();
    };
  }

  /**
   * Record entries from the agent. Ignored unless the member is watched (the
   * extension shouldn't send them otherwise, but a stale poll can race). Invalid
   * entries are dropped rather than failing the batch.
   */
  record(memberId: string, inputs: unknown[]): number {
    if (!this.isWatched(memberId)) return 0;
    let n = 0;
    for (const input of inputs) {
      const body = sanitize(input);
      if (!body) continue;
      this.append(memberId, body);
      n++;
    }
    return n;
  }

  /**
   * Replace the member's buffer with a backfill: the agent's current session so
   * far (oldest first), led by a `backfill` marker when the agent capped it
   * (`omitted` > 0). Viewers get the new buffer as a `hello`. Ignored unless
   * watched, like `record`. Returns how many entries were kept.
   */
  backfill(memberId: string, inputs: unknown[], omitted: number): number {
    if (!this.isWatched(memberId)) return 0;
    const t = this.get(memberId);
    const entries: TranscriptEntry[] = [];
    const byKey = new Map<string, TranscriptEntry>();
    const add = (input: TranscriptInput) => {
      const existing = input.key ? byKey.get(input.key) : undefined;
      if (existing) { Object.assign(existing, input); return; }
      const entry = { ...input, seq: ++this.seq, at: this.now() } as TranscriptEntry;
      entries.push(entry);
      if (entry.key) byKey.set(entry.key, entry);
    };
    if (Number.isFinite(omitted) && omitted > 0) add({ kind: "backfill", omitted: Math.floor(omitted) });
    for (const input of inputs) {
      const body = sanitize(input);
      if (body) add(body);
    }
    t.entries = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    const snapshot = [...t.entries];
    for (const fn of t.viewers) {
      try { fn({ type: "hello", entries: snapshot }); } catch { /* ignore */ }
    }
    return t.entries.filter((e) => e.kind !== "backfill").length;
  }

  /** Drop a member's transcript (dismissed / deregistered). */
  forget(memberId: string): void {
    const t = this.members.get(memberId);
    // Keep the record while someone is looking at it — the view would blank.
    if (t && t.viewers.size === 0) this.members.delete(memberId);
  }

  private append(memberId: string, input: TranscriptInput): void {
    const t = this.get(memberId);
    let entry: TranscriptEntry;
    const existing = input.key ? t.entries.find((e) => e.key === input.key) : undefined;
    if (existing) {
      // Upsert: merge in place so the entry keeps its position.
      Object.assign(existing, input);
      entry = existing;
    } else {
      entry = { ...input, seq: ++this.seq, at: this.now() } as TranscriptEntry;
      t.entries.push(entry);
      if (t.entries.length > MAX_ENTRIES) t.entries.splice(0, t.entries.length - MAX_ENTRIES);
    }
    for (const fn of t.viewers) {
      // A broken subscriber (closed SSE socket) must never break recording.
      try { fn({ type: "entry", entry }); } catch { /* ignore */ }
    }
  }
}

/** Validate an agent-supplied entry and clip oversized strings. */
function sanitize(input: unknown): TranscriptInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind) || DAEMON_KINDS.has(raw.kind)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "seq" || k === "at") continue; // daemon-owned
    out[k] = typeof v === "string" && v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) + "\n… (clipped)" : v;
  }
  if (out.key !== undefined && typeof out.key !== "string") delete out.key;
  return out as TranscriptInput;
}
