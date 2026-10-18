/**
 * lib/retry.ts — Making errored-session retries visible (docs/DESIGN.md
 * "Errored Sessions Retry").
 *
 * When a teammate's model call fails, the daemon retries the WorkItem with
 * backoff and posts `[retry] …`, then `[failed] …` once retries run out. The UI
 * must never let that read like ordinary waiting or a quiet success, so:
 *   - Queue rows label a retry with its attempt and countdown (`retryLabel`);
 *   - thread comments tagged `[failed]` / `[retry]` get a destructive / amber
 *     frame (`commentToneClass`).
 * Dependency-free so the Deno suite can test it (tests/session-retry-ui.test.ts).
 */

/** The bits of a queued WorkItem `retryLabel` reads. */
export interface RetryInfo {
  state: string;
  /** 1 for a first run; n for an automatic retry after an errored session. */
  attempt?: number;
  /** A READY retry is held until this time (its backoff). */
  retryAt?: string;
}

/** "4m" / "2h" until `ms` from now. */
function until(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/**
 * "retry · attempt 2 · in 4m" for an automatic retry (attempt > 1), else null —
 * so a held retry on the Queue page doesn't look like ordinary waiting. "due"
 * once the backoff has passed (it then waits for readiness and a teammate).
 */
export function retryLabel(item: RetryInfo, now = Date.now()): string | null {
  if (!item.attempt || item.attempt <= 1) return null;
  const base = `retry · attempt ${item.attempt}`;
  if (item.state !== "READY" || !item.retryAt) return base;
  const wait = new Date(item.retryAt).getTime() - now;
  return wait > 0 ? `${base} · in ${until(wait)}` : `${base} · due`;
}

/** Border/background classes for a thread comment card, keyed off its `[tag]` prefix. */
export function commentToneClass(body: string): string {
  if (/^\[failed\]/.test(body)) return "border-destructive/60 bg-destructive/5";
  if (/^\[retry\]/.test(body)) return "border-amber-500/60 bg-amber-500/5";
  return "border-border bg-background";
}
