/**
 * daemon/sources/schedule.ts — The built-in Schedule Work Source (cron).
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" and
 * "Pending schedules: reversible, no catch-up".
 *
 * A Schedule (store/schedules.ts) is a cron parent: on each daemon tick it
 * enqueues a WorkItem for every WorkDef whose `parent` is `{ kind: "schedule" }`
 * and whose cron is due. Everything here goes through `SourceContext`: the
 * enqueue is the daemon's single `enqueueFor`, and readiness is the daemon's.
 * A Scheduled WorkDef needs no other hook — it is eligible while it exists,
 * runs where it says, and uses the base prompt.
 */

import type { WorkDef } from "../../shared/types.ts";
import { isCronDue } from "../cron.ts";
import { listSchedules, scheduleCursor, updateSchedule } from "../store/schedules.ts";
import type { SourceContext, WorkSource } from "./types.ts";

/** The Schedule source's id (= its WorkDefs' `parent.kind`). */
export const SCHEDULE_SOURCE_ID = "schedule";

/**
 * Enqueue a WorkItem for every Scheduled WorkDef whose cron is due now (and
 * that isn't already in flight). Stamps `lastEnqueuedAt` for per-minute dedupe.
 *
 * Readiness gating (see docs/DESIGN.md "Readiness Gating"): a due child is
 * *held* rather than enqueued while the daemon says it can't enqueue now, and
 * the schedule is flagged `heldForReadiness` so it re-attempts every tick
 * (independent of the cron window) until the team recovers — firing exactly
 * one catch-up run instead of a per-occurrence backlog.
 *
 * Pending (docs/DESIGN.md "Pending schedules: reversible, no catch-up"): a
 * job fires only when both its Schedule and its WorkDef are active. A pending
 * Schedule is skipped outright — no cron firing, no readiness hold, no cursor
 * advance; a pending child WorkDef is left out of its (active) Schedule's
 * firing. The cron cursor is the later of `lastEnqueuedAt` and `resumedAt`,
 * so a reactivated Schedule resumes at its next occurrence and never
 * back-fires what it skipped while pending.
 */
export function runSchedules(ctx: SourceContext, now: Date): void {
  // Group WorkDefs by their schedule parent (skip archived ones).
  const childrenBySchedule = new Map<string, WorkDef[]>();
  for (const def of ctx.listWorkDefs()) {
    if (def.parent?.kind !== SCHEDULE_SOURCE_ID) continue;
    if (def.status === "archived") continue;
    if (def.pending) continue; // a pending job never fires (nor holds the schedule for readiness)
    const arr = childrenBySchedule.get(def.parent.id) || [];
    arr.push(def);
    childrenBySchedule.set(def.parent.id, arr);
  }
  for (const sched of listSchedules(ctx.teamDir)) {
    if (sched.pending) continue; // a pending schedule never fires nor holds for readiness
    const due = isCronDue(sched.cron, now, scheduleCursor(sched));
    const held = sched.heldForReadiness === true;
    // A schedule is worked either when its cron fires, or when it has work held
    // back for readiness that we keep retrying until the host recovers.
    if (!due && !held) continue;

    let anyHeld = false;
    for (const def of childrenBySchedule.get(sched.id) || []) {
      if (ctx.hasActiveItem(def.id)) continue;
      if (!ctx.readiness.canEnqueueNow()) { anyHeld = true; continue; }
      ctx.enqueue(def.id);
    }

    const patch: { lastEnqueuedAt?: string; heldForReadiness?: boolean } = {};
    // Advance the cron cursor only for a genuine cron firing (dedupes within
    // the minute). Recovery of held work is driven by `heldForReadiness`, not
    // the cron window, so a job held past its minute still fires once on recovery.
    if (due) patch.lastEnqueuedAt = now.toISOString();
    if (anyHeld !== held) patch.heldForReadiness = anyHeld;
    if (patch.lastEnqueuedAt !== undefined || patch.heldForReadiness !== undefined) {
      updateSchedule(ctx.teamDir, sched.id, patch);
    }
  }
}

/** The built-in Schedule source: fires due crons on each daemon tick. */
export const scheduleSource: WorkSource = {
  id: SCHEDULE_SOURCE_ID,
  apiVersion: 1,
  tick: runSchedules,
};
