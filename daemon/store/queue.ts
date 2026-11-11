/**
 * daemon/store/queue.ts — The WorkItem queue.
 *
 * A WorkItem is the unit of agent execution: a dumb, terminal-only attempt
 * pointing at a WorkDef (a board task or standalone work). It drives the work:
 * a COMPLETE item advances a board task, a FAILED/CANCELED one leaves it stuck
 * for a human, and a WAITED one (a poll state's "not yet") leaves it in place
 * for its next check (docs/DESIGN.md "The WorkItem", "Polling States"). This module owns the
 * `work_items` rows:
 *   - reads (one item, filtered lists, counts, the active item for a def, the
 *     latest state) and the claim-time persona snapshot;
 *   - `enqueueFor`, the single creator (pending WorkDefs never get one);
 *   - `getNextWorkItem` — directory affinity, eligibility, retry backoff, and
 *     the exclusive directory leases (`getDirectoryBlocker`) — and `claimWorkItem`;
 *   - the transitions: the agent's `setWorkItemState` and `waitWorkItem`, the errored-session
 *     retry (`failWorkItemForSessionError`), cancel / force-fail / re-enqueue,
 *     read flags, and `notifyItemTerminal` (the source's onItemTerminal hook);
 *   - execution stats (docs/DESIGN.md "Execution Count: Derived, not Counted").
 *
 * The Store delegates its queue methods here one line each. What this needs
 * from the sources, readiness, members, assignments and threads comes in as
 * `QueueStoreDeps`.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  ACTIVE_WORK_ITEM_STATES,
  directoriesOverlap,
  exclusiveDirectoriesEnabled,
  resolveRetry,
  retryBackoffMs,
  type Member,
  type PersonaRef,
  type PersonaVia,
  type TeamConfig,
  type WorkDef,
  type WorkItem,
  type WorkItemRef,
  type WorkItemState,
} from "../../shared/types.ts";
import { normalizeDirectory } from "../../shared/directory.ts";
import { errorMessage } from "../../shared/util.ts";
import type { SourceEntry } from "../sources/registry.ts";
import type { ItemTerminalOutcome } from "../sources/types.ts";
import { getWorkDef } from "./workdefs.ts";
import type { StoreDomainContext } from "./domain.ts";

/**
 * How often a WorkDef has run, derived from `work_items` (CANCELED excluded) —
 * see `QueueStore.getExecutionStats` and docs/DESIGN.md "Execution Count: Derived, not Counted".
 */
export interface WorkDefExecutionStats {
  /** WorkItems created for the WorkDef, excluding CANCELED ones. */
  executionCount: number;
  /** When the latest counted WorkItem was enqueued (ISO), or null if never run. */
  lastRunAt: string | null;
}

/** A backoff delay for a comment: "1m", "15m", "30s", "1h 30m". */
function formatDelay(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** What the queue needs from the rest of the Store. */
export interface QueueStoreDeps {
  /** The registered source that owns a WorkDef, if any (its hooks: isEligible, onItemClaimed, onItemTerminal). */
  sourceFor(def: WorkDef): SourceEntry | undefined;
  /**
   * A new item's title/directory overrides for a def (hook: resolveItem — or
   * the daemon's own for a triage-mode mirror), or undefined for none.
   */
  resolveItem(def: WorkDef): { title?: string; directory?: string } | undefined;
  /** Does the team's readiness probe say ready (an automatic retry waits for it)? */
  isTeamReady(): boolean;
  /** The registered members (online ones' directories shape tier 3 of matching). */
  getMembers(): Member[];
  /** Release a WorkDef's board assignment row (a no-op for non-board work). */
  releaseAssignment(workDefId: string): void;
  /** Append a comment to a ref's thread (the errored-session `[retry]` / `[failed]` lines). */
  addComment(ref: WorkItemRef, from: string, body: string): void;
}

export class QueueStore {
  private db: DatabaseSync;
  private teamDir: string;
  private config: TeamConfig;
  private deps: QueueStoreDeps;

  constructor(ctx: StoreDomainContext, deps: QueueStoreDeps) {
    this.db = ctx.db;
    this.teamDir = ctx.teamDir;
    this.config = ctx.config;
    this.deps = deps;
  }

  private rowToWorkItem(row: Record<string, unknown>): WorkItem {
    const ref: WorkItemRef = { workDefId: row.work_def_id as string };
    return {
      id: row.id as string,
      title: (row.title as string) || "",
      ref,
      directory: (row.directory as string) || undefined,
      state: row.state as WorkItemState,
      read: !!row.read,
      memberId: (row.member_id as string) || undefined,
      enqueuedAt: new Date(row.enqueued_at as number).toISOString(),
      lastStateChangeAt: new Date(row.last_state_change_at as number).toISOString(),
      attempt: (row.attempt as number) || 1,
      retryAt: row.retry_at ? new Date(row.retry_at as number).toISOString() : undefined,
      error: (row.error as string) || undefined,
      persona: row.persona_id ? {
        id: row.persona_id as string,
        title: (row.persona_title as string) || (row.persona_id as string),
        origin: (row.persona_origin as string) || "team",
        via: row.persona_via as PersonaVia,
        ...(row.persona_fallback_from ? { fallbackFrom: row.persona_fallback_from as string } : {}),
      } : undefined,
    };
  }

  /**
   * On daemon boot: any WorkItem left IN_PROGRESS lost its holder across the
   * restart, so it's moved to MORIBUND (its `member_id` kept, so the same agent
   * reconnecting can still complete it). See `Store.resetConnectionsForBoot`.
   */
  markInFlightMoribundForBoot(): void {
    this.db.prepare("UPDATE work_items SET state = 'MORIBUND', last_state_change_at = ? WHERE state = 'IN_PROGRESS'").run(Date.now());
  }

  /**
   * Record the persona a WorkItem's run was given (the claim-time snapshot;
   * docs/DESIGN.md "The in-flight persona"). `null` clears it — a run with no
   * persona. Called by `claimWorkItem`; exposed for the prompt path that resolves it.
   */
  recordWorkItemPersona(id: string, persona: PersonaRef | null): void {
    this.db.prepare(
      "UPDATE work_items SET persona_id = ?, persona_title = ?, persona_origin = ?, persona_via = ?, persona_fallback_from = ? WHERE id = ?",
    ).run(persona?.id ?? null, persona?.title ?? null, persona?.origin ?? null, persona?.via ?? null, persona?.fallbackFrom ?? null, id);
  }

  /** One WorkItem by id, or null. */
  getWorkItem(id: string): WorkItem | null {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToWorkItem(row) : null;
  }

  /** List WorkItems, optionally filtered by state(s)/read, newest-first, paginated. */
  getWorkItems(opts?: { states?: WorkItemState[]; read?: boolean; workDefId?: string; limit?: number; offset?: number }): { items: WorkItem[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts?.states && opts.states.length > 0) {
      where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
      params.push(...opts.states);
    }
    if (opts?.read !== undefined) { where.push("read = ?"); params.push(opts.read ? 1 : 0); }
    // One WorkDef's runs (its detail page's run history, with each run's persona).
    if (opts?.workDefId !== undefined) { where.push("work_def_id = ?"); params.push(opts.workDefId); }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM work_items ${clause}`).get(...params) as { n: number }).n;
    let sql = `SELECT * FROM work_items ${clause} ORDER BY enqueued_at DESC`;
    if (opts?.limit !== undefined) { sql += " LIMIT ?"; params.push(opts.limit); if (opts?.offset) { sql += " OFFSET ?"; params.push(opts.offset); } }
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return { items: rows.map((r) => this.rowToWorkItem(r)), total };
  }

  /**
   * Count WorkItems matching state(s)/read without loading any rows — a single
   * `COUNT(*)`, cheap enough for the toolbar badges that poll /api/status.
   */
  countWorkItems(opts?: { states?: WorkItemState[]; read?: boolean }): number {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts?.states && opts.states.length > 0) {
      where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
      params.push(...opts.states);
    }
    if (opts?.read !== undefined) { where.push("read = ?"); params.push(opts.read ? 1 : 0); }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM work_items ${clause}`).get(...params) as { n: number }).n;
  }

  /** The active (READY/IN_PROGRESS/MORIBUND) WorkItem for a WorkDef, if any. */
  getActiveWorkItem(workDefId: string): WorkItem | null {
    const row = this.db.prepare(
      `SELECT * FROM work_items WHERE work_def_id = ? AND state IN (${ACTIVE_WORK_ITEM_STATES.map(() => "?").join(",")}) LIMIT 1`
    ).get(workDefId, ...ACTIVE_WORK_ITEM_STATES) as Record<string, unknown> | undefined;
    return row ? this.rowToWorkItem(row) : null;
  }

  /** The newest WorkItem's state for a WorkDef (CANCELED included), or null if it never had one. */
  getLatestWorkItemState(defId: string): WorkItemState | null {
    const row = this.db.prepare("SELECT state FROM work_items WHERE work_def_id = ? ORDER BY enqueued_at DESC, rowid DESC LIMIT 1")
      .get(defId) as { state: WorkItemState } | undefined;
    return row?.state ?? null;
  }

  /**
   * Execution stats for every WorkDef that has any: how many WorkItems were
   * created for it and when the latest was enqueued. One `GROUP BY` over
   * `work_items`, so a list endpoint pays one query, not one per row.
   *
   * Derived, not stored (docs/DESIGN.md "Execution Count: Derived, not Counted"):
   * every WorkItem already lands in `work_items` through `enqueueFor`, so a
   * counter would be a second copy that could drift, and `workdef.md` must stay
   * authored-only. **CANCELED items are excluded** — a cancel withdraws an
   * attempt before (or instead of) it running, so it isn't a run. Every other
   * state counts, READY and IN_PROGRESS included: queued or running work is not
   * "never run". A WorkDef with no entry here has zero runs.
   */
  getExecutionStats(): Map<string, WorkDefExecutionStats> {
    const rows = this.db.prepare(
      `SELECT work_def_id AS id, COUNT(*) AS n, MAX(enqueued_at) AS last FROM work_items
       WHERE work_def_id IS NOT NULL AND state != 'CANCELED' GROUP BY work_def_id`
    ).all() as Array<{ id: string; n: number; last: number | null }>;
    const out = new Map<string, WorkDefExecutionStats>();
    for (const r of rows) {
      out.set(r.id, { executionCount: r.n, lastRunAt: r.last ? new Date(r.last).toISOString() : null });
    }
    return out;
  }

  /** Execution stats for one WorkDef (zero runs → `{ executionCount: 0, lastRunAt: null }`). */
  getExecutionStatsFor(workDefId: string): WorkDefExecutionStats {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS n, MAX(enqueued_at) AS last FROM work_items
       WHERE work_def_id = ? AND state != 'CANCELED'`
    ).get(workDefId) as { n: number; last: number | null };
    return { executionCount: r.n, lastRunAt: r.last ? new Date(r.last).toISOString() : null };
  }

  /**
   * The single WorkItem creator: enqueue a READY item for any WorkDef, of any
   * kind. The item takes the def's title and directory unless its source
   * overrides them (hook: resolveItem — a board task falls back to its story's
   * directory). Caller ensures none is already active.
   *
   * A pending WorkDef never gets a WorkItem: refusing here, at the one creator,
   * is what guarantees no path (Run, cron, admission, reconcile, re-enqueue)
   * dispatches one (docs/DESIGN.md "Pending: Write, Review, Activate").
   */
  enqueueFor(workDefId: string, retry?: { attempt: number; retryAt: number }): WorkItem | null {
    const def = getWorkDef(this.teamDir, workDefId);
    if (!def || def.pending) return null;
    let directory = def.directory;
    let title = def.title;
    // A registered source may override where/what the item is (hook: resolveItem;
    // e.g. a triage item takes the note's title and the leader's directory).
    // A triage-mode mirror's title/directory are the daemon's (external-triage.ts).
    const resolved = this.deps.resolveItem(def);
    if (resolved?.title !== undefined) title = resolved.title;
    if (resolved?.directory !== undefined) directory = resolved.directory;
    const id = `wi-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO work_items (id, title, work_def_id, directory, state, read, member_id, enqueued_at, last_state_change_at, attempt, retry_at)
       VALUES (?, ?, ?, ?, 'READY', 0, NULL, ?, ?, ?, ?)`
    ).run(id, title, def.id, directory ? normalizeDirectory(directory) : null, now, now, retry?.attempt ?? 1, retry?.retryAt ?? null);
    return this.getWorkItem(id)!;
  }

  /**
   * Move a WorkItem row to `state` (and optionally set its member) — the bare
   * transition: no assignment release, no source hook. Callers that end an item
   * follow it with `notifyItemTerminal` where the source should hear.
   */
  setWorkItemStateRow(id: string, state: WorkItemState, memberId?: string | null): void {
    if (memberId === undefined) {
      this.db.prepare("UPDATE work_items SET state = ?, last_state_change_at = ? WHERE id = ?").run(state, Date.now(), id);
    } else {
      this.db.prepare("UPDATE work_items SET state = ?, member_id = ?, last_state_change_at = ? WHERE id = ?").run(state, memberId, Date.now(), id);
    }
  }

  /** Cancel a task's active WorkItem (internal override on position changes). */
  abandonActiveWorkItem(taskId: string): void {
    const item = this.getActiveWorkItem(taskId);
    if (!item) return;
    this.setWorkItemStateRow(item.id, "CANCELED");
    this.notifyItemTerminal(item.id);
  }

  /**
   * Pick the next READY WorkItem for a polling agent using directory affinity
   * (docs/DESIGN.md "Work Matching: Directory Affinity"). Eligibility is the
   * owning source's (`isWorkItemEligible`). Priority tiers:
   *   1. item.directory == agent.directory  (my repo's work)
   *   2. item has no directory              (anyone's)
   *   3. item.directory != agent.directory AND no online agent has that dir
   * Oldest-first within a tier. All directories are compared via
   * `normalizeDirectory` (symlinks resolved), applied here at compare time.
   *
   * With `exclusiveDirectories` on (the default), a candidate whose directory
   * overlaps an active (IN_PROGRESS/MORIBUND) item's directory is skipped — it
   * stays READY until the lease frees (see `getDirectoryBlocker`).
   *
   * An automatic retry (docs/DESIGN.md "Errored Sessions Retry") stays READY
   * until its backoff (`retryAt`) passes *and* the team's readiness probe says
   * ready — retrying into expired credentials would just burn an attempt.
   */
  getNextWorkItem(agent: { id?: string; directory?: string }, now: number = Date.now()): WorkItem | null {
    const rows = this.db.prepare("SELECT * FROM work_items WHERE state = 'READY' ORDER BY enqueued_at ASC").all() as Array<Record<string, unknown>>;
    // Normalize at compare time too (not just at write time): rows written
    // before symlink resolution, or before the path existed on this host, may
    // hold an unresolved variant. Memoized per call — one realpath per distinct dir.
    const norm = this.directoryNormalizer();
    const leases = this.getDirectoryLeases(norm);
    const candidates = rows.map((r) => this.rowToWorkItem(r))
      .filter((wi) => this.isWorkItemEligible(wi) && this.isRetryDue(wi, now) && !this.findLeaseBlocker(wi, leases, norm));
    if (candidates.length === 0) return null;

    const agentDir = agent.directory ? norm(agent.directory) : undefined;
    const onlineDirs = new Set(
      this.deps.getMembers()
        .filter((m) => m.status !== "offline" && m.directory)
        .map((m) => norm(m.directory!)),
    );

    const tier1 = candidates.filter((wi) => agentDir && wi.directory && norm(wi.directory) === agentDir);
    if (tier1[0]) return tier1[0];
    const tier2 = candidates.filter((wi) => !wi.directory);
    if (tier2[0]) return tier2[0];
    const tier3 = candidates.filter((wi) => wi.directory && norm(wi.directory) !== agentDir && !onlineDirs.has(norm(wi.directory)));
    return tier3[0] ?? null;
  }

  /**
   * May this READY item be handed out yet? A first attempt always may; a retry
   * waits out its backoff, then for the readiness probe (re-run every 30s by
   * daemon/readiness.ts) to report ready.
   */
  private isRetryDue(wi: WorkItem, now: number): boolean {
    if (wi.attempt <= 1) return true;
    if (wi.retryAt && Date.parse(wi.retryAt) > now) return false;
    return this.deps.isTeamReady();
  }

  /** A READY WorkItem is eligible if its backing work still wants doing. */
  private isWorkItemEligible(wi: WorkItem): boolean {
    const def = getWorkDef(this.teamDir, wi.ref.workDefId);
    if (!def) return false;
    // A registered source decides for its own defs (hook: isEligible; Story:
    // its story active and ready, the task in a teammate state).
    const src = this.deps.sourceFor(def);
    if (src?.source.isEligible) return src.source.isEligible(def, src.ctx);
    // No hook (e.g. Scheduled): eligible while it exists.
    return true;
  }

  /**
   * Lease a READY WorkItem to a member (→ IN_PROGRESS), then tell its source
   * (hook: onItemClaimed — Story records the board's assignment row). Refused (false) if the item isn't READY or its directory is
   * busy: the lease is re-checked here, inside one IMMEDIATE transaction, so two
   * agents that were both offered items for one directory can't both claim
   * (docs/DESIGN.md "Work Matching: Directory Affinity").
   */
  claimWorkItem(id: string, memberId: string, persona?: PersonaRef | null): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getWorkItem(id);
      if (!item || item.state !== "READY" || this.getDirectoryBlocker(item)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.setWorkItemStateRow(id, "IN_PROGRESS", memberId);
      // The persona snapshot, inside the claim transaction (a retry is a new item).
      if (persona !== undefined) this.recordWorkItemPersona(id, persona);
      const def = getWorkDef(this.teamDir, item.ref.workDefId);
      const src = def ? this.deps.sourceFor(def) : undefined;
      if (def && src?.source.onItemClaimed) src.source.onItemClaimed(def, { ...item, state: "IN_PROGRESS", memberId }, memberId, src.ctx);
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * The active WorkItem holding a directory lease that blocks `item`, or null.
   * Only WorkItem directories take part — a teammate's registered directory
   * only biases matching. Null when `exclusiveDirectories` is off, when `item`
   * has no directory (exempt), or when nothing overlapping is in flight.
   * Surfaced by `GET /api/work-items` as the reason a READY item is waiting.
   */
  getDirectoryBlocker(item: WorkItem): WorkItem | null {
    const norm = this.directoryNormalizer();
    return this.findLeaseBlocker(item, this.getDirectoryLeases(norm), norm);
  }

  /** A memoized `normalizeDirectory` (one realpath per distinct dir per call). */
  private directoryNormalizer(): (d: string) => string {
    const memo = new Map<string, string>();
    return (d: string): string => {
      let n = memo.get(d);
      if (n === undefined) { n = normalizeDirectory(d); memo.set(d, n); }
      return n;
    };
  }

  /**
   * Active directory leases: every IN_PROGRESS or MORIBUND WorkItem with a
   * directory. MORIBUND keeps its lease so a teammate that reconnects doesn't
   * collide with a newcomer; COMPLETE/FAILED/CANCELED free it. Empty when
   * `exclusiveDirectories` is off.
   */
  private getDirectoryLeases(norm: (d: string) => string): Array<{ item: WorkItem; dir: string }> {
    if (!exclusiveDirectoriesEnabled(this.config)) return [];
    const rows = this.db.prepare(
      "SELECT * FROM work_items WHERE state IN ('IN_PROGRESS', 'MORIBUND') AND directory IS NOT NULL AND directory != '' ORDER BY last_state_change_at ASC",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToWorkItem(r)).map((item) => ({ item, dir: norm(item.directory!) }));
  }

  /** The first lease whose directory overlaps `item`'s (never `item` itself). */
  private findLeaseBlocker(item: WorkItem, leases: Array<{ item: WorkItem; dir: string }>, norm: (d: string) => string): WorkItem | null {
    if (!item.directory || leases.length === 0) return null;
    const dir = norm(item.directory);
    return leases.find((l) => l.item.id !== item.id && directoriesOverlap(l.dir, dir))?.item ?? null;
  }

  /**
   * Agent-facing terminal transition (the single state-setter). The item's
   * assignment row (if any) is released and its source is told (hook:
   * onItemTerminal — COMPLETE on a board task advances it; FAILED leaves it
   * stuck). The daemon posts NO comment — the agent composes its own
   * completion/failure comment (via the comment routes) before setting state.
   * Returns whatever the source reports back (a board task's new position).
   */
  setWorkItemState(id: string, state: "COMPLETE" | "FAILED"): { ok: boolean; error?: string; newStatus?: string; completed?: boolean } {
    const item = this.getWorkItem(id);
    if (!item) return { ok: false, error: "WorkItem not found" };
    if (item.state !== "IN_PROGRESS" && item.state !== "MORIBUND") {
      return { ok: false, error: `WorkItem is ${item.state}, not in flight` };
    }
    this.setWorkItemStateRow(id, state);
    this.deps.releaseAssignment(item.ref.workDefId);
    // The daemon posts nothing: the agent composes its own completion/failure
    // comment (see the teammate loop / fail tool) before calling this.
    const outcome = this.notifyItemTerminal(id);
    return { ok: true, ...outcome };
  }

  /**
   * A poll state's check ended with "not yet" (docs/DESIGN.md "Polling
   * States"): the item goes WAITED — terminal, so the WorkItem stays one-shot
   * and its directory lease frees — and is marked read, because a wait isn't
   * news (the outcome that finally comes is). Its assignment row is released
   * and its source told, as for any terminal state; the Story source neither
   * advances nor fails the task. Whether the item's state may wait at all is
   * the caller's check (`Store.waitWorkItem`).
   */
  waitWorkItem(id: string): { ok: boolean; error?: string } {
    const item = this.getWorkItem(id);
    if (!item) return { ok: false, error: "WorkItem not found" };
    if (item.state !== "IN_PROGRESS" && item.state !== "MORIBUND") {
      return { ok: false, error: `WorkItem is ${item.state}, not in flight` };
    }
    this.setWorkItemStateRow(id, "WAITED");
    this.markWorkItemRead(id, true);
    this.deps.releaseAssignment(item.ref.workDefId);
    this.notifyItemTerminal(id);
    return { ok: true };
  }

  /**
   * A poll state's `onTimeout: "fail"` (docs/DESIGN.md "Polling States"): the
   * WorkDef's latest item — its last check, which ended WAITED — becomes
   * FAILED, unread (the outcome *is* news), and its source is told. No item is
   * created: the timeout fails the check that last ran rather than inventing a
   * run. False (nothing changed) when the latest item isn't WAITED.
   */
  failLatestWaitedItem(workDefId: string): boolean {
    const row = this.db.prepare("SELECT id, state FROM work_items WHERE work_def_id = ? ORDER BY enqueued_at DESC, rowid DESC LIMIT 1")
      .get(workDefId) as { id: string; state: WorkItemState } | undefined;
    if (!row || row.state !== "WAITED") return false;
    this.setWorkItemStateRow(row.id, "FAILED");
    this.markWorkItemRead(row.id, false);
    this.notifyItemTerminal(row.id);
    return true;
  }

  /**
   * Tell the item's source it reached a terminal state (hook: onItemTerminal):
   * COMPLETE/FAILED from the agent, and CANCELED / force-FAILED from a person
   * or a board move. A synchronous hook's outcome (e.g. a board task's new position) is
   * returned; an async one is fire-and-forget. A source's failure (sync or
   * async) is logged, never allowed to undo the state change the agent just made.
   */
  notifyItemTerminal(itemId: string): ItemTerminalOutcome {
    const item = this.getWorkItem(itemId);
    const def = item ? getWorkDef(this.teamDir, item.ref.workDefId) : null;
    if (!item || !def) return {};
    const src = this.deps.sourceFor(def);
    if (!src?.source.onItemTerminal) return {};
    const fail = (e: unknown) => src.ctx.log(`onItemTerminal failed: ${errorMessage(e)}`);
    try {
      const r = src.source.onItemTerminal(def, item, src.ctx);
      if (r instanceof Promise) r.catch(fail);
      else if (r) return r;
    } catch (e) {
      fail(e);
    }
    return {};
  }

  /**
   * The agent's session *errored* (the model call failed — a Bedrock 503,
   * missing credentials), so the attempt produced nothing. Unlike the agent
   * giving up, this is retried automatically (docs/DESIGN.md "Errored Sessions
   * Retry"):
   *
   *   - retries left → this attempt goes FAILED *read* (it isn't news — the
   *     retry is), and a fresh READY item (attempt n+1) is enqueued, held until
   *     its backoff passes and the team is ready. Comment: `[retry] …`.
   *   - retries exhausted → FAILED, unread, so it lands in the Inbox. Comment:
   *     `[failed] <error> after N attempts`.
   *
   * The daemon posts the comment here — the one exception to "the agent owns
   * its comments", because the retry decision (and its attempt count) is the
   * daemon's. It is posted *before* the state change, so it is the item's
   * closing comment (ui/src/lib/mobile.ts `inboxOutcome`). Works the same for
   * board tasks and Solitary/Scheduled WorkDefs: a task keeps its position,
   * and the retry is just its next WorkItem.
   */
  failWorkItemForSessionError(id: string, sessionError: string, now: number = Date.now()): {
    ok: boolean; error?: string; retry?: { workItemId: string; attempt: number; maxAttempts: number; retryAt: string };
  } {
    const item = this.getWorkItem(id);
    if (!item) return { ok: false, error: "WorkItem not found" };
    if (item.state !== "IN_PROGRESS" && item.state !== "MORIBUND") {
      return { ok: false, error: `WorkItem is ${item.state}, not in flight` };
    }
    const policy = resolveRetry(this.config);
    const maxAttempts = policy.maxRetries + 1;
    const reason = sessionError.trim() || "The agent session errored";
    const author = item.memberId || "daemon";
    const retriesLeft = item.attempt < maxAttempts && getWorkDef(this.teamDir, item.ref.workDefId) !== null;
    this.db.prepare("UPDATE work_items SET error = ? WHERE id = ?").run(reason, id);

    if (!retriesLeft) {
      const tries = item.attempt === 1 ? "1 attempt" : `${item.attempt} attempts`;
      this.deps.addComment(item.ref, author, `[failed] ${reason} after ${tries}. The agent session errored; nothing was done on the final attempt.`);
      this.setWorkItemState(id, "FAILED");
      return { ok: true };
    }

    const delayMs = retryBackoffMs(policy, item.attempt);
    const retryAt = now + delayMs;
    const next = item.attempt + 1;
    this.deps.addComment(
      item.ref,
      author,
      `[retry] Attempt ${item.attempt}/${maxAttempts} failed: ${reason}. Retrying in ${formatDelay(delayMs)} (attempt ${next}/${maxAttempts}), once the team is ready.`,
    );
    this.setWorkItemState(id, "FAILED");
    this.markWorkItemRead(id, true);
    // Re-check: setWorkItemState → advance/admission never enqueues on FAILED, but stay safe.
    if (this.getActiveWorkItem(item.ref.workDefId)) return { ok: true };
    const fresh = this.enqueueFor(item.ref.workDefId, { attempt: next, retryAt });
    if (!fresh) return { ok: true };
    return { ok: true, retry: { workItemId: fresh.id, attempt: next, maxAttempts, retryAt: new Date(retryAt).toISOString() } };
  }

  /** Cancel a READY WorkItem (human). */
  cancelWorkItem(id: string): boolean {
    const item = this.getWorkItem(id);
    if (!item || item.state !== "READY") return false;
    this.setWorkItemStateRow(id, "CANCELED");
    this.deps.releaseAssignment(item.ref.workDefId);
    this.notifyItemTerminal(id);
    return true;
  }

  /** Force a MORIBUND item to FAILED (human decided the agent is truly gone). */
  forceFailWorkItem(id: string, reEnqueue = false): { ok: boolean; error?: string; newItem?: WorkItem | null } {
    const item = this.getWorkItem(id);
    if (!item || item.state !== "MORIBUND") return { ok: false, error: "WorkItem is not moribund" };
    this.setWorkItemStateRow(id, "FAILED");
    this.deps.releaseAssignment(item.ref.workDefId);
    this.notifyItemTerminal(id);
    let newItem: WorkItem | null = null;
    if (reEnqueue) newItem = this.reEnqueueRef(item.ref);
    return { ok: true, newItem };
  }

  /** Create a fresh READY WorkItem for a ref that has no active one. */
  reEnqueueRef(ref: WorkItemRef): WorkItem | null {
    if (this.getActiveWorkItem(ref.workDefId)) return null;
    return this.enqueueFor(ref.workDefId);
  }

  /** Mark a WorkItem read/unread (Inbox). */
  markWorkItemRead(id: string, read = true): boolean {
    const item = this.getWorkItem(id);
    if (!item) return false;
    this.db.prepare("UPDATE work_items SET read = ? WHERE id = ?").run(read ? 1 : 0, id);
    return true;
  }
}
