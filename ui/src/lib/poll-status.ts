/**
 * lib/poll-status.ts — How a poll-state task's status reads in the UI
 * (docs/DESIGN.md "Polling States"), and when its **Check now** can be asked.
 *
 * Between checks a poll-state task has no active WorkItem, so the board's
 * WorkItem chip says nothing; this says what the state is doing instead:
 *   - **waiting** — the last check ended with wait; the next is due at
 *     `nextCheckAt` ("Waiting · next check 14:45", with "check 4" beside it);
 *   - **held** — a check is due but the team's readiness probe says not ready
 *     ("Held · team not ready", the probe's reason in the tooltip);
 *   - **needs you** — `pollTimeout` ran out (`onTimeout: "manual"`) and polling
 *     stopped ("Needs attention: polling timed out").
 * While a check is queued or running the card shows the normal in-progress
 * chip instead (the task's `workItemState`), so `pollChip` says nothing then.
 *
 * Dependency-free so the daemon's Node suite can test it
 * (tests/poll-status-ui.test.ts).
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

/** A poll chip: its kind, label, the small "check N" beside it, and its tooltip. */
export interface PollChip {
  kind: "waiting" | "held" | "needs-you";
  label: string;
  /** "check 4" — how many checks have waited so far; unset before the first. */
  count?: string;
  title: string;
}

/**
 * When a check is due, as a wall-clock time: "14:45" today, "Tue 14:45" within
 * the week, else "Oct 3 14:45"; "due" once it's past. Local time, 24-hour.
 */
export function checkClock(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!(at > now)) return "due";
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hm;
  if (at - now < 6 * 86_400_000) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/**
 * The chip for a poll-state task between checks, or null when there is
 * nothing to say (a check in flight — the in-progress chip shows that; a
 * failed timeout — the Inbox shows that; or a first check not yet run).
 */
export function pollChip(poll: PollStatusInfo, now: number = Date.now()): PollChip | null {
  const last = poll.lastWaitReason ? `Last check: ${poll.lastWaitReason}` : "";
  const count = poll.checks > 0 ? `check ${poll.checks}` : undefined;
  if (poll.timedOutAt) {
    if (poll.onTimeout !== "manual") return null;
    return {
      kind: "needs-you", label: "Needs attention: polling timed out", count,
      title: `Polling stopped. Move the task on if it's done, or back into the state to poll again. ${last}`.trim(),
    };
  }
  if (poll.heldForReadiness) {
    return {
      kind: "held", label: "Held · team not ready", count,
      title: `The next check is held until the team is ready: ${poll.heldReason || "the readiness probe failed"}. ${last}`.trim(),
    };
  }
  if (poll.nextCheckAt && poll.checks > 0) {
    return { kind: "waiting", label: `Waiting · next check ${checkClock(poll.nextCheckAt, now)}`, count, title: last || "The last check said not yet." };
  }
  return null;
}

/** The bits of a board task Check now looks at (shared/protocol.ts `TaskView`). */
export interface CheckNowTask {
  pending?: boolean;
  workItemState?: string | null;
}

/**
 * Why **Check now** is disabled (its tooltip), or null when it may ask: a
 * check already queued or running, or a pending task. The daemon has the final
 * say (a 409 — e.g. the team isn't ready); `checkNowRefusal` words that.
 */
export function checkNowBlockedReason(task: CheckNowTask, inFlight = false): string | null {
  if (inFlight) return "Asking for a check…";
  if (task.workItemState === "READY" || task.workItemState === "IN_PROGRESS" || task.workItemState === "MORIBUND") {
    return "A check is already queued or running";
  }
  if (task.pending) return "The task is pending: activate it first";
  return null;
}

/** The daemon's refusal of a Check now (`CheckNowResponse`), in words: the probe's reason when the team isn't ready. */
export function checkNowRefusal(res: { error?: string; readiness?: string }): string {
  if (res.readiness) return `Team not ready: ${res.readiness}`;
  return res.error || "Couldn't queue a check";
}
