/**
 * tests/session-retry-ui.test.ts — The UI makes errored-session retries visible
 * (docs/DESIGN.md "Errored Sessions Retry"): Queue rows label a held retry, and
 * thread comments tagged `[failed]` / `[retry]` are framed so a failure never
 * reads like a quiet success.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { commentToneClass, retryLabel } from "../ui/src/lib/retry.ts";
import { inboxOutcome } from "../ui/src/lib/mobile.ts";

Deno.test("retryLabel: none for a first attempt; attempt + countdown for a held retry", () => {
  const now = Date.parse("2026-10-01T18:00:00Z");
  assertEquals(retryLabel({ state: "READY", attempt: 1 }, now), null);
  assertEquals(retryLabel({ state: "READY" }, now), null);
  const held = retryLabel({ state: "READY", attempt: 2, retryAt: "2026-10-01T18:05:00Z" }, now)!;
  assertStringIncludes(held, "attempt 2");
  assertStringIncludes(held, "in 5m");
  assertStringIncludes(retryLabel({ state: "READY", attempt: 3, retryAt: "2026-10-01T17:00:00Z" }, now)!, "due");
  assertEquals(retryLabel({ state: "IN_PROGRESS", attempt: 2 }, now), "retry · attempt 2");
});

Deno.test("commentToneClass: [failed] is destructive, [retry] amber, others neutral", () => {
  assertStringIncludes(commentToneClass("[failed] Bedrock 503 after 4 attempts."), "destructive");
  assertStringIncludes(commentToneClass("[retry] Attempt 1/4 failed: …"), "amber");
  assertEquals(commentToneClass("[done] Work complete."), "border-border bg-background");
});

Deno.test("inboxOutcome: an errored attempt's outcome is its [retry] comment", () => {
  const comments = [
    { from: "firm-odo", body: "[status] Started working on this.", at: "2026-10-01T18:00:12Z" },
    { from: "firm-odo", body: "[retry] Attempt 1/4 failed: Service unavailable.", at: "2026-10-01T18:00:30Z" },
  ];
  assertEquals(inboxOutcome(comments, { memberId: "firm-odo", lastStateChangeAt: "2026-10-01T18:00:30Z" })?.body.startsWith("[retry]"), true);
});
