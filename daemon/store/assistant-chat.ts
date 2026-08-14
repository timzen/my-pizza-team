/**
 * daemon/store/assistant-chat.ts — The assistant conversation (chat v2).
 *
 * Owns everything about the assistant chat: sessions, messages, delivery
 * receipts, the agent-facing inbox, the ephemeral "thoughts" peek buffer, and
 * the SSE event stream. The Store delegates its assistant methods here.
 *
 * The model (see docs/ASSISTANT_CHAT_V2.md):
 *
 * - **The Pi session is the conversation; this is a mirror of it.** The user's
 *   messages are queued here and pulled by the extension, which hands them to
 *   Pi (`sendUserMessage`); the agent's own prose is mirrored back as bubbles.
 *   Messages typed in the agent's terminal are mirrored in too (`origin: "tui"`),
 *   which is what makes the web chat and the tmux pane the same conversation.
 * - **There are no turns.** Sending never blocks and never locks the composer:
 *   interleaving mid-stream messages is Pi's job (`deliverAs: "steer"`), not the
 *   daemon's. Delivery state is a real 3-step receipt: queued → delivered → read.
 * - **Nothing is destroyed.** "New chat" and persona swaps *end* a session
 *   (snapshotting it to markdown) and open a new one, so history is resumable.
 * - **Thoughts are ephemeral.** Reasoning chunks live in a capped in-memory ring
 *   buffer for the "peek behind the …" affordance; they are never persisted.
 */

import type { DatabaseSync } from "node:sqlite";
import { writeSnapshot, snapshotPath, readSnapshot } from "./assistant-snapshots.ts";

// ─── Types ──────────────────────────────────────────────────────────

export type AssistantRole = "user" | "assistant" | "system";
/** Where a message came from: the web UI, the agent's terminal, the agent, the daemon. */
export type AssistantOrigin = "web" | "tui" | "agent" | "system";
/** Receipt states for a user message. Assistant/system rows carry null. */
export type AssistantDelivery = "queued" | "delivered" | "read";

export interface AssistantMessage {
  id: string;
  sessionId: string;
  role: AssistantRole;
  content: string;
  origin: AssistantOrigin;
  /** Receipt for user messages; null for assistant/system rows. */
  delivery: AssistantDelivery | null;
  /** 'ok' | 'failed' — only meaningful for assistant rows. */
  state: string;
  /** Id of the message this one quotes, if any. */
  replyTo: string | null;
  /** Resolved quote of `replyTo` (role + a trimmed excerpt), for rendering. */
  quoted: { id: string; role: AssistantRole; content: string } | null;
  createdAt: string;
}

export interface AssistantSession {
  id: string;
  personaId: string | null;
  personaTitle: string | null;
  title: string;
  /** Absolute path to the backing Pi session file, when the agent has reported one. */
  piSessionPath: string | null;
  status: "active" | "ended";
  snapshotPath: string | null;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
}

/** One item of agent-facing work: a user message not yet handed to Pi. */
export interface InboxMessage {
  id: string;
  content: string;
  replyTo: string | null;
  /** Excerpt of the quoted message, so the agent sees what is being answered. */
  quoted: string | null;
  origin: AssistantOrigin;
}

/** Events pushed to subscribers of GET /api/assistant/stream. */
export type AssistantEvent =
  | { type: "message"; message: AssistantMessage }
  | { type: "message-deleted"; id: string }
  | { type: "delivery"; id: string; delivery: AssistantDelivery }
  | { type: "thinking"; active: boolean; chunk?: string }
  | { type: "session"; session: AssistantSession };

/** Max reasoning chunks / bytes held for the "peek" buffer. Oldest are dropped. */
const THOUGHT_MAX_CHUNKS = 200;
const THOUGHT_MAX_BYTES = 64 * 1024;

/** How stale an active session's snapshot may get before it is rewritten. */
const SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;

// ─── Implementation ─────────────────────────────────────────────────

export class AssistantChat {
  private db: DatabaseSync;
  private teamDir: string;
  /** Resolves a context-entry id to its title, for session labelling. */
  private personaTitle: (id: string) => string | null;

  private subscribers = new Set<(event: AssistantEvent) => void>();

  /**
   * Live reasoning peek: a capped ring buffer for the current session, dropped
   * on daemon restart. Cleared when a new agent run starts, so after a reply
   * lands you can still open the `…` and read what it was just thinking.
   */
  private thoughts: { sessionId: string; chunks: string[]; bytes: number; updatedAt: number } | null = null;
  /** Whether the agent is mid-run (drives the `…` indicator). */
  private thinking = false;

  private lastSnapshotAt = 0;

  constructor(db: DatabaseSync, teamDir: string, personaTitle: (id: string) => string | null) {
    this.db = db;
    this.teamDir = teamDir;
    this.personaTitle = personaTitle;
  }

  // ─── Event stream ─────────────────────────────────────────────────

  /** Subscribe to chat events (SSE). Returns an unsubscribe function. */
  subscribe(fn: (event: AssistantEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(event: AssistantEvent): void {
    for (const fn of this.subscribers) {
      // A broken subscriber (closed SSE socket) must never break an append.
      try { fn(event); } catch { /* ignore */ }
    }
  }

  // ─── Row mapping ──────────────────────────────────────────────────

  private rowToMessage(row: Record<string, unknown>): AssistantMessage {
    const replyTo = (row.reply_to as string) || null;
    return {
      id: row.id as string,
      sessionId: (row.session_id as string) || "",
      role: row.role as AssistantRole,
      content: (row.content as string) || "",
      origin: ((row.origin as string) || "web") as AssistantOrigin,
      delivery: ((row.delivery as string) || null) as AssistantDelivery | null,
      state: (row.state as string) || "ok",
      replyTo,
      quoted: replyTo ? this.resolveQuote(replyTo) : null,
      createdAt: new Date(row.created_at as number).toISOString(),
    };
  }

  /** Excerpt the quoted message for rendering; null if it was deleted. */
  private resolveQuote(id: string): { id: string; role: AssistantRole; content: string } | null {
    const row = this.db.prepare("SELECT id, role, content FROM assistant_messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const content = ((row.content as string) || "").trim();
    return {
      id: row.id as string,
      role: row.role as AssistantRole,
      content: content.length > 280 ? `${content.slice(0, 280)}…` : content,
    };
  }

  private rowToSession(row: Record<string, unknown>): AssistantSession {
    return {
      id: row.id as string,
      personaId: (row.persona_id as string) || null,
      personaTitle: (row.persona_title as string) || null,
      title: (row.title as string) || "",
      piSessionPath: (row.pi_session_path as string) || null,
      status: row.status as "active" | "ended",
      snapshotPath: (row.snapshot_path as string) || null,
      startedAt: new Date(row.started_at as number).toISOString(),
      endedAt: row.ended_at ? new Date(row.ended_at as number).toISOString() : null,
      messageCount: (row.message_count as number) || 0,
    };
  }

  // ─── Sessions ─────────────────────────────────────────────────────

  /** The single active session, or null when the chat has never been used. */
  getActiveSession(): AssistantSession | null {
    const row = this.db.prepare("SELECT * FROM assistant_sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  getSession(id: string): AssistantSession | null {
    const row = this.db.prepare("SELECT * FROM assistant_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  /** All sessions, newest first. */
  listSessions(): AssistantSession[] {
    const rows = this.db.prepare("SELECT * FROM assistant_sessions ORDER BY started_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSession(r));
  }

  /**
   * The active session, created on demand. Called by every append path so the
   * chat "just works" without an explicit start step.
   */
  ensureActiveSession(personaId: string | null): AssistantSession {
    const existing = this.getActiveSession();
    if (existing) return existing;
    return this.startSession(personaId);
  }

  /** Open a new active session. Any previously active session must already be ended. */
  startSession(personaId: string | null): AssistantSession {
    const now = Date.now();
    const id = sessionId(now, personaId);
    const title = this.personaTitle(personaId ?? "");
    this.db.prepare(
      "INSERT INTO assistant_sessions (id, persona_id, persona_title, title, status, started_at, message_count) VALUES (?, ?, ?, '', 'active', ?, 0)",
    ).run(id, personaId, personaId ? title : null, now);
    const session = this.getSession(id)!;
    this.emit({ type: "session", session });
    return session;
  }

  /**
   * End the active session: snapshot its transcript to markdown, mark it ended.
   * Returns the ended session, or null when there was nothing active.
   */
  endActiveSession(): AssistantSession | null {
    const active = this.getActiveSession();
    if (!active) return null;
    const now = Date.now();
    this.db.prepare("UPDATE assistant_sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(now, active.id);
    const ended = this.getSession(active.id)!;
    this.snapshot(ended);
    this.clearThoughts();
    const session = this.getSession(active.id)!;
    this.emit({ type: "session", session });
    return session;
  }

  /**
   * Start a fresh chat: end the active session and open a new one under
   * `personaId`. The caller is responsible for telling the agent to roll its Pi
   * session (a `new-session` leader directive).
   */
  newSession(personaId: string | null, notice?: string): AssistantSession {
    this.endActiveSession();
    const session = this.startSession(personaId);
    if (notice) this.appendSystemNotice(notice);
    return session;
  }

  /**
   * Reopen a previously ended session as the active one (resume). The current
   * session is snapshotted and ended first. Returns null for an unknown id.
   */
  resumeSession(id: string): AssistantSession | null {
    const target = this.getSession(id);
    if (!target) return null;
    if (target.status === "active") return target;
    this.endActiveSession();
    this.db.prepare("UPDATE assistant_sessions SET status = 'active', ended_at = NULL WHERE id = ?").run(id);
    const session = this.getSession(id)!;
    this.emit({ type: "session", session });
    this.appendSystemNotice(`Resumed “${session.title || session.id}”`);
    return this.getSession(id)!;
  }

  /**
   * Record the Pi session file backing the active chat session (reported by the
   * extension on register/session_start). This is what makes resume possible.
   */
  reportPiSession(piSessionPath: string, personaId: string | null): AssistantSession {
    const session = this.ensureActiveSession(personaId);
    this.db.prepare("UPDATE assistant_sessions SET pi_session_path = ? WHERE id = ?").run(piSessionPath, session.id);
    const updated = this.getSession(session.id)!;
    this.emit({ type: "session", session: updated });
    return updated;
  }

  /** Read a session's markdown snapshot (writing it first if it is missing). */
  getSnapshot(id: string): string | null {
    const session = this.getSession(id);
    if (!session) return null;
    const existing = readSnapshot(this.teamDir, id);
    if (existing) return existing;
    this.snapshot(session);
    return readSnapshot(this.teamDir, id);
  }

  /** Write a session's snapshot file and remember the path on the row. */
  private snapshot(session: AssistantSession): void {
    try {
      const file = writeSnapshot(this.teamDir, session, this.getMessages(session.id));
      this.db.prepare("UPDATE assistant_sessions SET snapshot_path = ? WHERE id = ?").run(file, session.id);
      this.lastSnapshotAt = Date.now();
    } catch (err) {
      console.warn(`⚠️  Failed to snapshot assistant session "${session.id}": ${err}`);
    }
  }

  /**
   * Refresh the active session's snapshot if it has gone stale, so a crash loses
   * at most a few minutes of transcript. Cheap no-op most of the time; called
   * from the daemon's periodic sweep.
   */
  refreshActiveSnapshot(force = false): void {
    const active = this.getActiveSession();
    if (!active || active.messageCount === 0) return;
    if (!force && Date.now() - this.lastSnapshotAt < SNAPSHOT_REFRESH_MS) return;
    this.snapshot(active);
  }

  // ─── Messages ─────────────────────────────────────────────────────

  getMessage(id: string): AssistantMessage | null {
    const row = this.db.prepare("SELECT * FROM assistant_messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMessage(row) : null;
  }

  /** One session's messages, oldest first (defaults to the active session). */
  getMessages(sessionId?: string): AssistantMessage[] {
    const id = sessionId ?? this.getActiveSession()?.id;
    if (!id) return [];
    const rows = this.db.prepare("SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY seq ASC").all(id) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToMessage(r));
  }

  /**
   * Append a user message. Always succeeds — the composer never blocks. `web`
   * messages start `queued` (the extension will pull and deliver them); `tui`
   * messages are already in the agent's context, so they land `read`.
   */
  appendUserMessage(
    content: string,
    opts: { personaId: string | null; replyTo?: string | null; origin?: AssistantOrigin } = { personaId: null },
  ): AssistantMessage {
    const origin: AssistantOrigin = opts.origin === "tui" ? "tui" : "web";
    const session = this.ensureActiveSession(opts.personaId);
    const delivery: AssistantDelivery = origin === "tui" ? "read" : "queued";
    const message = this.insert(session.id, "user", content, origin, delivery, "ok", opts.replyTo ?? null);
    // The first user message names the session (used in the session list + snapshot).
    if (!session.title) this.setSessionTitle(session.id, content);
    return message;
  }

  /**
   * Append one assistant bubble — the mirror of a paragraph of the agent's own
   * prose (or a tool-progress note). `failed` renders as an error bubble.
   */
  appendAssistantBubble(content: string, opts: { personaId: string | null; failed?: boolean } = { personaId: null }): AssistantMessage {
    const session = this.ensureActiveSession(opts.personaId);
    return this.insert(session.id, "assistant", content, "agent", null, opts.failed ? "failed" : "ok", null);
  }

  /** Append a centered session marker ("New chat as Pizzaiolo", "Resumed …"). */
  appendSystemNotice(content: string): AssistantMessage | null {
    const session = this.getActiveSession();
    if (!session) return null;
    return this.insert(session.id, "system", content, "system", null, "ok", null);
  }

  private insert(
    sessionId: string,
    role: AssistantRole,
    content: string,
    origin: AssistantOrigin,
    delivery: AssistantDelivery | null,
    state: string,
    replyTo: string | null,
  ): AssistantMessage {
    const now = Date.now();
    const id = `msg-${now}-${crypto.randomUUID().slice(0, 8)}`;
    this.db.prepare(
      "INSERT INTO assistant_messages (id, session_id, role, content, origin, delivery, state, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, sessionId, role, content, origin, delivery, state, replyTo, now);
    this.db.prepare("UPDATE assistant_sessions SET message_count = message_count + 1 WHERE id = ?").run(sessionId);
    const message = this.getMessage(id)!;
    this.emit({ type: "message", message });
    return message;
  }

  /** Name a session from its first user message (single line, trimmed). */
  private setSessionTitle(sessionId: string, firstMessage: string): void {
    const title = firstMessage.trim().split("\n")[0]!.slice(0, 80);
    this.db.prepare("UPDATE assistant_sessions SET title = ? WHERE id = ?").run(title, sessionId);
    const session = this.getSession(sessionId);
    if (session) this.emit({ type: "session", session });
  }

  deleteMessage(id: string): boolean {
    const row = this.db.prepare("SELECT session_id FROM assistant_messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return false;
    this.db.prepare("DELETE FROM assistant_messages WHERE id = ?").run(id);
    this.db.prepare("UPDATE assistant_sessions SET message_count = MAX(message_count - 1, 0) WHERE id = ?").run(row.session_id as string);
    this.emit({ type: "message-deleted", id });
    return true;
  }

  // ─── Inbox (agent-facing) ─────────────────────────────────────────

  /**
   * User messages the agent has not been handed yet, oldest first. The extension
   * polls this, sends each into Pi, then acks `delivered`.
   */
  getInbox(): InboxMessage[] {
    const rows = this.db.prepare(
      "SELECT id, content, reply_to, origin FROM assistant_messages WHERE role = 'user' AND delivery = 'queued' ORDER BY seq ASC",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const replyTo = (row.reply_to as string) || null;
      const quote = replyTo ? this.resolveQuote(replyTo) : null;
      return {
        id: row.id as string,
        content: (row.content as string) || "",
        replyTo,
        quoted: quote ? quote.content : null,
        origin: ((row.origin as string) || "web") as AssistantOrigin,
      };
    });
  }

  /**
   * Advance delivery receipts. `delivered` = handed to Pi; `read` = the agent
   * actually started a run that sees them. Receipts only ever move forward.
   */
  ackInbox(ids: string[], state: AssistantDelivery): number {
    const rank: Record<AssistantDelivery, number> = { queued: 0, delivered: 1, read: 2 };
    let updated = 0;
    for (const id of ids) {
      const row = this.db.prepare("SELECT delivery FROM assistant_messages WHERE id = ? AND role = 'user'").get(id) as Record<string, unknown> | undefined;
      if (!row) continue;
      const current = (row.delivery as AssistantDelivery) || "queued";
      if (rank[state] <= rank[current]) continue;
      this.db.prepare("UPDATE assistant_messages SET delivery = ? WHERE id = ?").run(state, id);
      this.emit({ type: "delivery", id, delivery: state });
      updated++;
    }
    return updated;
  }

  /** Mark everything already handed to Pi as read (called when a run starts). */
  markDeliveredAsRead(): number {
    const rows = this.db.prepare("SELECT id FROM assistant_messages WHERE role = 'user' AND delivery = 'delivered'").all() as Array<Record<string, unknown>>;
    return this.ackInbox(rows.map((r) => r.id as string), "read");
  }

  // ─── Thoughts (ephemeral peek buffer) ─────────────────────────────

  /** Whether the agent is mid-run — drives the `…` bubble. */
  isThinking(): boolean {
    return this.thinking;
  }

  setThinking(active: boolean): void {
    this.thinking = active;
    this.emit({ type: "thinking", active });
  }

  /**
   * Append a reasoning chunk to the peek buffer. Capped by chunk count and
   * bytes; oldest chunks are dropped so a long run can't grow without bound.
   */
  appendThought(chunk: string): void {
    if (!chunk) return;
    const sessionId = this.getActiveSession()?.id ?? "";
    if (!this.thoughts || this.thoughts.sessionId !== sessionId) {
      this.thoughts = { sessionId, chunks: [], bytes: 0, updatedAt: Date.now() };
    }
    const buf = this.thoughts;
    buf.chunks.push(chunk);
    buf.bytes += chunk.length;
    buf.updatedAt = Date.now();
    while (buf.chunks.length > THOUGHT_MAX_CHUNKS || buf.bytes > THOUGHT_MAX_BYTES) {
      const dropped = buf.chunks.shift();
      if (dropped === undefined) break;
      buf.bytes -= dropped.length;
    }
    this.emit({ type: "thinking", active: this.thinking, chunk });
  }

  /** Drop the peek buffer (called when a new agent run starts). */
  clearThoughts(): void {
    this.thoughts = null;
  }

  /** The current peek buffer: what the agent is (or was just) thinking. */
  getThoughts(): { chunks: string[]; updatedAt: string | null; thinking: boolean } {
    return {
      chunks: this.thoughts ? [...this.thoughts.chunks] : [],
      updatedAt: this.thoughts ? new Date(this.thoughts.updatedAt).toISOString() : null,
      thinking: this.thinking,
    };
  }

  // ─── Migration ────────────────────────────────────────────────────

  /**
   * Fold v1 rows (turn-based chat) into a single ended `legacy-*` session so no
   * history is lost, mapping the old `status` column onto the new `delivery` /
   * `state` split. Idempotent: only runs while unassigned rows exist.
   * See docs/ASSISTANT_CHAT_V2.md §10.
   */
  migrateLegacyMessages(): void {
    const orphan = this.db.prepare("SELECT COUNT(*) AS n FROM assistant_messages WHERE session_id IS NULL OR session_id = ''").get() as { n: number };
    if (!orphan.n) return;

    const first = this.db.prepare("SELECT created_at FROM assistant_messages ORDER BY seq ASC LIMIT 1").get() as Record<string, unknown> | undefined;
    const startedAt = (first?.created_at as number) ?? Date.now();
    const id = `legacy-${new Date(startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    this.db.prepare(
      "INSERT OR IGNORE INTO assistant_sessions (id, persona_id, persona_title, title, status, started_at, ended_at, message_count) VALUES (?, NULL, NULL, 'Earlier conversation', 'ended', ?, ?, 0)",
    ).run(id, startedAt, Date.now());
    this.db.prepare("UPDATE assistant_messages SET session_id = ? WHERE session_id IS NULL OR session_id = ''").run(id);
    // Old `status` column: user 'sent'|'read', assistant 'done'|'failed'.
    this.db.exec("UPDATE assistant_messages SET origin = CASE WHEN role = 'user' THEN 'web' ELSE 'agent' END WHERE origin IS NULL OR origin = ''");
    this.db.exec("UPDATE assistant_messages SET delivery = CASE status WHEN 'sent' THEN 'queued' WHEN 'read' THEN 'read' ELSE NULL END WHERE role = 'user' AND delivery IS NULL");
    this.db.exec("UPDATE assistant_messages SET state = CASE status WHEN 'failed' THEN 'failed' ELSE 'ok' END WHERE state IS NULL OR state = ''");
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM assistant_messages WHERE session_id = ?").get(id) as { n: number };
    this.db.prepare("UPDATE assistant_sessions SET message_count = ? WHERE id = ?").run(count.n, id);

    // Legacy queued messages must not be replayed to the agent — that session is over.
    this.db.prepare("UPDATE assistant_messages SET delivery = 'read' WHERE session_id = ? AND delivery = 'queued'").run(id);

    const session = this.getSession(id);
    if (session) this.snapshot(session);
    console.log(`ℹ️  Migrated ${count.n} assistant message(s) into session "${id}" (see ${snapshotPath(this.teamDir, id)}).`);
  }
}

/**
 * Mint a readable, filesystem-safe session id: `<timestamp>-<persona>`.
 * Millisecond precision matters: ending and starting a session happen in the
 * same tick (new chat, persona swap), and second precision would collide on the
 * primary key.
 */
function sessionId(now: number, personaId: string | null): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const suffix = (personaId || "default").replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40);
  return `${stamp}-${suffix}`;
}
