/**
 * tests/poll-status-ui.test.ts — How a poll-state task reads on its card, the
 * story page and the task page (ui/src/lib/poll-status.ts; docs/DESIGN.md
 * "Polling States"): waiting with the next check's time and the check count,
 * held for readiness with the probe's reason, the normal in-progress look while
 * a check runs, needs attention after a manual timeout — and when Check now may
 * ask, and how the daemon's refusal reads.
 */

import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { checkClock, checkNowBlockedReason, checkNowRefusal, pollChip } from "../ui/src/lib/poll-status.ts";

// Local noon, so "later today" stays today in any time zone.
const nowDate = new Date(2026, 9, 1, 12, 0, 0);
const now = nowDate.getTime();
const at = (mins: number) => new Date(now + mins * 60_000).toISOString();
const base = { checks: 4, lastWaitReason: "2 comments open", onTimeout: "manual" as const };

test("checkClock: today's time as HH:MM, a later day with its weekday or date, past as due", () => {
  assertEquals(checkClock(at(165), now), "14:45");
  assertEquals(checkClock(at(-1), now), "due");
  assert(/^[A-Z][a-z]{2} 12:00$/.test(checkClock(at(2 * 24 * 60), now)), "two days out names the weekday");
  assert(/^[A-Z][a-z]{2} \d+ 12:00$/.test(checkClock(at(10 * 24 * 60), now)), "ten days out names the date");
});

test("pollChip waiting: 'Waiting · next check 14:45', the check count, and the last reason as the tooltip", () => {
  const chip = pollChip({ ...base, nextCheckAt: at(165) }, now)!;
  assertEquals(chip.kind, "waiting");
  assertEquals(chip.label, "Waiting · next check 14:45");
  assertEquals(chip.count, "check 4");
  assertStringIncludes(chip.title, "2 comments open");
  assertEquals(pollChip({ ...base, nextCheckAt: at(-5) }, now)!.label, "Waiting · next check due");
});

test("pollChip held: 'Held · team not ready' with the probe's reason", () => {
  const chip = pollChip({ ...base, nextCheckAt: at(-5), heldForReadiness: true, heldReason: "creds expired" }, now)!;
  assertEquals(chip.kind, "held");
  assertEquals(chip.label, "Held · team not ready");
  assertStringIncludes(chip.title, "creds expired");
  assertEquals(chip.count, "check 4");
});

test("pollChip running: nothing while a check is in flight (no nextCheckAt), so the in-progress chip shows", () => {
  assertEquals(pollChip({ ...base }, now), null);
  assertEquals(pollChip({ checks: 0, onTimeout: "manual" }, now), null, "nothing before the first wait");
});

test("pollChip timed out: manual needs attention; fail shows in the Inbox instead", () => {
  const chip = pollChip({ ...base, timedOutAt: at(-1) }, now)!;
  assertEquals(chip.kind, "needs-you");
  assertEquals(chip.label, "Needs attention: polling timed out");
  assertStringIncludes(chip.title, "Move the task on");
  assertEquals(pollChip({ ...base, onTimeout: "fail", timedOutAt: at(-1) }, now), null);
});

test("checkNowBlockedReason: enabled between checks; disabled while queued, running, at risk, pending or asking", () => {
  assertEquals(checkNowBlockedReason({ workItemState: null }), null);
  assertEquals(checkNowBlockedReason({}), null);
  for (const state of ["READY", "IN_PROGRESS", "MORIBUND"]) {
    assertStringIncludes(checkNowBlockedReason({ workItemState: state })!, "already queued or running");
  }
  assertStringIncludes(checkNowBlockedReason({ pending: true })!, "pending");
  assert(checkNowBlockedReason({}, true) !== null, "disabled while the request is in flight");
});

test("checkNowRefusal: the probe's reason when the team isn't ready, else the daemon's error", () => {
  assertEquals(checkNowRefusal({ error: "The team isn't ready: creds expired", readiness: "creds expired" }), "Team not ready: creds expired");
  assertEquals(checkNowRefusal({ error: "A check is already queued or running" }), "A check is already queued or running");
  assertEquals(checkNowRefusal({}), "Couldn't queue a check");
});
