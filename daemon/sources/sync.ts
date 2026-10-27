/**
 * daemon/sources/sync.ts — The daemon-driven sync loop for external (pull-only)
 * Work Sources. See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins"
 * (external sources).
 *
 * One `SyncRunner` per Store. For each source with a `sync`, the Store's timer
 * calls `run(entry)` every `syncEveryMs`; the runner calls the source, bounded
 * by `syncTimeoutMs`, and hands a good result to the Store's `ingest` (mirror,
 * enqueue once per revision, archive what vanished). Its job is **isolation**:
 *   - a source that throws, rejects, times out, or returns garbage is logged and
 *     backed off (exponentially, capped) — it never throws into the timer;
 *   - a slow source only delays itself: a sync still running when its next tick
 *     comes is skipped (no overlap), and one that outlives its timeout counts as
 *     failed — its late result, whenever it comes, is dropped (the race is over);
 *   - every source has its own state, so one failing never stalls another.
 * The runner never touches the queue itself; `ingest` (the Store) does, through
 * the single `enqueueFor`.
 */

import type { SourceEntry } from "./registry.ts";
import type { ExternalDef, SyncOutcome } from "./types.ts";

/** Default `syncEveryMs`: once a minute. */
export const DEFAULT_SYNC_EVERY_MS = 60_000;
/** Default `syncTimeoutMs`. */
export const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

/** Backoff after consecutive failures: base · 2^(n−1), capped. */
export interface SyncBackoff {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_SYNC_BACKOFF: SyncBackoff = { baseMs: 30_000, maxMs: 30 * 60_000 };

/** Per-source runner state (in memory: a restarted daemon simply syncs again). */
interface SourceSyncState {
  running: boolean;
  failures: number;
  /** No sync before this time (epoch ms) while backing off. */
  notBefore: number;
  /** The last sync that called the source (skips aren't recorded). */
  last?: { at: number; outcome: SyncOutcome };
}

/**
 * A source's sync health, for `GET /api/sources` (in memory, like the rest of
 * the runner's state): the last sync that ran, and any backoff in force.
 */
export interface SyncStatus {
  running: boolean;
  /** Consecutive failures (0 when healthy). */
  failures: number;
  /** Backing off until then (epoch ms), when failing; null otherwise. */
  backoffUntil: number | null;
  /** The last sync that called the source — when it finished, and how it went — or null before the first. */
  last: { at: number; ok: boolean; error?: string; mirrored: number; enqueued: number; archived: number; held: number } | null;
}

/** An empty outcome, for skips and failures. */
function emptyOutcome(extra: Partial<SyncOutcome> = {}): SyncOutcome {
  return { ok: false, mirrored: [], enqueued: [], archived: [], held: [], ...extra };
}

export class SyncRunner {
  private states = new Map<string, SourceSyncState>();
  private stopped = false;
  private ingest: (entry: SourceEntry, defs: ExternalDef[]) => SyncOutcome;
  private backoff: SyncBackoff;
  private isSwitchedOff: (entry: SourceEntry) => boolean;

  /**
   * @param ingest applies a good sync result (the Store: mirror, enqueue, archive).
   * @param backoff how long to wait after consecutive failures.
   * @param isSwitchedOff is the source's feature toggle off right now (the
   *   Store's live config)? Then it isn't synced at all — see `run`.
   */
  constructor(
    ingest: (entry: SourceEntry, defs: ExternalDef[]) => SyncOutcome,
    backoff: SyncBackoff = DEFAULT_SYNC_BACKOFF,
    isSwitchedOff: (entry: SourceEntry) => boolean = () => false,
  ) {
    this.ingest = ingest;
    this.backoff = backoff;
    this.isSwitchedOff = isSwitchedOff;
  }

  private state(id: string): SourceSyncState {
    let s = this.states.get(id);
    if (!s) {
      s = { running: false, failures: 0, notBefore: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  /** Drop the results of any sync still running (the Store is closing). */
  stop(): void {
    this.stopped = true;
  }

  /** Consecutive failures for a source (0 when healthy), for tests and logs. */
  failures(id: string): number {
    return this.states.get(id)?.failures ?? 0;
  }

  /**
   * Forget a source's failures and backoff (a re-init after a settings Save:
   * the old failures were about the old settings). A sync in flight isn't
   * touched; it finishes and records its result as usual.
   */
  reset(id: string): void {
    const s = this.states.get(id);
    if (!s) return;
    s.failures = 0;
    s.notBefore = 0;
  }

  /** A source's sync health (see `SyncStatus`). `now` decides whether a backoff is still in force. */
  status(id: string, now: number = Date.now()): SyncStatus {
    const s = this.states.get(id);
    const last = s?.last;
    return {
      running: s?.running ?? false,
      failures: s?.failures ?? 0,
      backoffUntil: s && s.notBefore > now ? s.notBefore : null,
      last: last
        ? {
          at: last.at, ok: last.outcome.ok, ...(last.outcome.error ? { error: last.outcome.error } : {}),
          mirrored: last.outcome.mirrored.length, enqueued: last.outcome.enqueued.length,
          archived: last.outcome.archived.length, held: last.outcome.held.length,
        }
        : null,
    };
  }

  /**
   * Run one sync of `entry` now. Skips (without calling the source) while a run
   * is in flight or, unless `force`, while backing off. Never rejects.
   *
   * A source whose feature toggle is off (docs/DESIGN.md "Feature Toggles") is
   * skipped even when forced — no `sync` call, no mirrors, no enqueues — and a
   * result that arrives after it was switched off mid-sync is dropped, so a
   * disconnect can't be undone by a sync already in flight. Its timer keeps
   * running, so switching it back on resumes on the next tick.
   */
  async run(entry: SourceEntry, opts: { now?: number; force?: boolean } = {}): Promise<SyncOutcome> {
    const { source, ctx } = entry;
    if (!source.sync) return emptyOutcome({ error: "not an external source" });
    if (this.isSwitchedOff(entry)) return emptyOutcome({ skipped: "disabled" });
    const st = this.state(source.id);
    if (st.running) return emptyOutcome({ skipped: "in-flight" });
    const now = opts.now ?? Date.now();
    if (!opts.force && now < st.notBefore) return emptyOutcome({ skipped: "backoff" });

    st.running = true;
    const timeoutMs = source.syncTimeoutMs && source.syncTimeoutMs > 0 ? source.syncTimeoutMs : DEFAULT_SYNC_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sync timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      // Promise.resolve().then: a sync that throws synchronously is a rejection too.
      const defs = await Promise.race([Promise.resolve().then(() => source.sync!(ctx)), timeout]);
      if (!Array.isArray(defs)) throw new Error("sync did not return an array");
      // The Store closed while the source was working: its DB is gone.
      if (this.stopped) return emptyOutcome({ error: "stopped" });
      // Switched off while the source was working: drop the result (see above).
      if (this.isSwitchedOff(entry)) return emptyOutcome({ skipped: "disabled" });
      const outcome = this.ingest(entry, defs);
      st.failures = 0;
      st.notBefore = 0;
      st.last = { at: Date.now(), outcome };
      return outcome;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      st.failures++;
      const wait = Math.min(this.backoff.baseMs * 2 ** (st.failures - 1), this.backoff.maxMs);
      st.notBefore = now + wait;
      ctx.log(`sync failed (${st.failures} in a row; next try in ${Math.round(wait / 1000)}s): ${error}`);
      const outcome = emptyOutcome({ error });
      st.last = { at: Date.now(), outcome };
      return outcome;
    } finally {
      clearTimeout(timer);
      st.running = false;
    }
  }
}
