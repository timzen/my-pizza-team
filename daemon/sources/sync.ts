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
}

/** An empty outcome, for skips and failures. */
function emptyOutcome(extra: Partial<SyncOutcome> = {}): SyncOutcome {
  return { ok: false, mirrored: [], enqueued: [], archived: [], held: [], ...extra };
}

export class SyncRunner {
  private states = new Map<string, SourceSyncState>();
  private stopped = false;

  /**
   * @param ingest applies a good sync result (the Store: mirror, enqueue, archive).
   * @param backoff how long to wait after consecutive failures.
   */
  constructor(
    private ingest: (entry: SourceEntry, defs: ExternalDef[]) => SyncOutcome,
    private backoff: SyncBackoff = DEFAULT_SYNC_BACKOFF,
  ) {}

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
   * Run one sync of `entry` now. Skips (without calling the source) while a run
   * is in flight or, unless `force`, while backing off. Never rejects.
   */
  async run(entry: SourceEntry, opts: { now?: number; force?: boolean } = {}): Promise<SyncOutcome> {
    const { source, ctx } = entry;
    if (!source.sync) return emptyOutcome({ error: "not an external source" });
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
      const outcome = this.ingest(entry, defs);
      st.failures = 0;
      st.notBefore = 0;
      return outcome;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      st.failures++;
      const wait = Math.min(this.backoff.baseMs * 2 ** (st.failures - 1), this.backoff.maxMs);
      st.notBefore = now + wait;
      ctx.log(`sync failed (${st.failures} in a row; next try in ${Math.round(wait / 1000)}s): ${error}`);
      return emptyOutcome({ error });
    } finally {
      clearTimeout(timer);
      st.running = false;
    }
  }
}
