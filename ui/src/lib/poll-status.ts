/**
 * lib/poll-status.ts — How a poll-state task's status reads in the UI
 * (docs/DESIGN.md "Polling States").
 *
 * Between checks a poll-state task has no active WorkItem, so the board's
 * WorkItem chip says nothing; this says what the state is doing instead:
 *   - **waiting** — the last check ended with wait; the next is due at `nextCheckAt`;
 *   - **held** — a check is due but the team's readiness probe says not ready;
 *   - **needs you** — `pollTimeout` ran out (`onTimeout: "manual"`) and polling stopped.
 * Dependency-free so the daemon's Node suite can test it (tests/poll-status-ui.test.ts).
 */

/** The bits of a task's poll status (shared/protocol.ts `TaskPollView`) this reads. */
export interface PollStatusInfo {
  checks: number;
  lastWaitReason?: string;
  nextCheckAt?: string;
  heldForReadiness?: boolean;
  heldReason?: string;
  timedOutAt?: string;
  onTimeout: "fail" | "manual";
}

/** A poll chip: its kind, short label and tooltip. */
export interface PollChip {
  kind: "waiting" | "held" | "needs-you";
  label: string;
  title: string;
}

/** "in 4m" / "in 2h" / "due" until `iso` from `now`. */
function until(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return "due";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

/**
 * The chip for a poll-state task between checks, or null when there is
 * nothing to say (a check in flight, a failed timeout — the Inbox shows that,
 * or a first check not yet run).
 */
export function pollChip(poll: PollStatusInfo, now: number = Date.now()): PollChip | null {
  const last = poll.lastWaitReason ? `Last check: ${poll.lastWaitReason}` : "";
  if (poll.timedOutAt) {
    if (poll.onTimeout !== "manual") return null;
    return { kind: "needs-you", label: "needs you", title: `Polling timed out — move it on if it's done, or back in to poll again. ${last}`.trim() };
  }
  if (poll.heldForReadiness) {
    return { kind: "held", label: "held", title: `Next check held: the team isn't ready (${poll.heldReason || "readiness probe"}). ${last}`.trim() };
  }
  if (poll.nextCheckAt && poll.checks > 0) {
    return { kind: "waiting", label: `next check ${until(poll.nextCheckAt, now)}`, title: `${poll.checks} check${poll.checks === 1 ? "" : "s"} so far. ${last}`.trim() };
  }
  return null;
}
