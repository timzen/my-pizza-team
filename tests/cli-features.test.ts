/**
 * tests/cli-features.test.ts — The mpt CLI and the feature toggles (cli/features.ts).
 *
 * `mpt status` leaves out a switched-off kind's counts and names what's off, and a
 * daemon feature refusal (403 `{ feature }`) is worded like the Pi tools word it.
 * The refusal bodies come from daemon/features.ts `featureDisabledBody`, so the CLI
 * is checked against what the daemon actually sends.
 */

import { assert, assertEquals } from "@std/assert";
import { daemonErrorMessage, featureDisabledMessage, statusSummaryLines } from "../cli/features.ts";
import { featureDisabledBody } from "../daemon/features.ts";

const status = {
  stories: { open: 2, done: 1, total: 3 },
  tasks: { total: 7 },
  members: { total: 2, working: 1, idle: 1 },
};

Deno.test("status summary: all on (or a daemon without features) shows every count", () => {
  for (const data of [status, { ...status, features: { stories: true, tasks: true, schedules: true } }]) {
    assertEquals(statusSummaryLines(data), [
      "Stories: 2 open, 1 done (3 total)",
      "Tasks: 7 total",
      "Members: 2 (1 working, 1 idle)",
    ]);
  }
});

Deno.test("status summary: a new team (tasks only) hides stories and names what's off", () => {
  const lines = statusSummaryLines({ ...status, features: { stories: false, tasks: true, schedules: false } });
  assert(!lines.some((l) => l.startsWith("Stories")));
  assertEquals(lines.at(-1), "Turned off: stories, schedules (Config → General → Work items)");
});

Deno.test("daemon errors: a feature 403 becomes the 'enable it in Config' message", () => {
  assertEquals(
    daemonErrorMessage(403, featureDisabledBody("stories")),
    "Stories are disabled — enable them in Config (features.stories)",
  );
  assertEquals(daemonErrorMessage(403, featureDisabledBody("schedules")), featureDisabledMessage("schedules"));
});

Deno.test("daemon errors: anything else keeps the daemon's message or the status", () => {
  assertEquals(daemonErrorMessage(409, { error: "locked" }), "locked");
  assertEquals(daemonErrorMessage(403, { error: "nope", feature: "bogus" }), "nope");
  assertEquals(daemonErrorMessage(500, null), "HTTP 500");
});
