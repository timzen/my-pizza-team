/**
 * tests/poll-status-ui.test.ts — the board's poll chip (ui/src/lib/poll-status.ts;
 * docs/DESIGN.md "Polling States"): waiting with the next check, held for
 * readiness with the probe's reason, or needs you after a manual timeout.
 */

import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { pollChip } from "../ui/src/lib/poll-status.ts";

const now = Date.parse("2026-10-01T18:00:00Z");

test("pollChip: waiting shows the next check; held shows the readiness reason; a manual timeout needs you", () => {
  const base = { checks: 2, lastWaitReason: "2 comments open", onTimeout: "manual" as const };
  const waiting = pollChip({ ...base, nextCheckAt: "2026-10-01T18:10:00Z" }, now)!;
  assertEquals(waiting.kind, "waiting");
  assertEquals(waiting.label, "next check in 10m");
  assertStringIncludes(waiting.title, "2 comments open");
  assertEquals(pollChip({ ...base, nextCheckAt: "2026-10-01T17:00:00Z" }, now)!.label, "next check due");

  const held = pollChip({ ...base, nextCheckAt: "2026-10-01T17:00:00Z", heldForReadiness: true, heldReason: "creds expired" }, now)!;
  assertEquals(held.kind, "held");
  assertStringIncludes(held.title, "creds expired");

  assertEquals(pollChip({ ...base, timedOutAt: "2026-10-01T17:00:00Z" }, now)!.kind, "needs-you");
  assertEquals(pollChip({ ...base, onTimeout: "fail", timedOutAt: "2026-10-01T17:00:00Z" }, now), null, "a failed timeout shows in the Inbox");
  assertEquals(pollChip({ checks: 0, onTimeout: "manual" }, now), null, "nothing before the first wait");
});
