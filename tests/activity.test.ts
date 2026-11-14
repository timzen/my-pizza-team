/**
 * tests/activity.test.ts — What a harness says it is doing (runtime/activity.ts,
 * shared/agent-protocol.ts `cleanActivityPreview`; docs/DESIGN.md "Stalled
 * Teammates").
 *
 * On a fake clock: `ActivityTracker` moves idle → model → tool → model → idle
 * with the run and tool lifecycle, counts a turn or tool call completing (and a
 * run starting or ending) as progress — and a tool that never returns as none —
 * and reports the longest-running of parallel tools. The preview is one short
 * line of the call's input (the command, the path; never file contents),
 * truncated and with obvious secrets redacted.
 */

import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import { ActivityTracker, toolPreview } from "../runtime/activity.ts";
import { ACTIVITY_PREVIEW_MAX, cleanActivityPreview } from "../shared/agent-protocol.ts";

const MIN = 60_000;

/** A tracker on a clock the test moves by hand. */
function tracker(start = 1_000_000) {
  const clock = { now: start };
  return { t: new ActivityTracker(() => clock.now), clock };
}

test("tracker: idle until a run starts; a run waits on the model; a tool shows its name, input and start", () => {
  const { t, clock } = tracker();
  assertEquals(t.report(), { activity: { state: "idle", since: 1_000_000 }, lastProgressAt: 1_000_000 });
  clock.now += MIN;
  t.runStarted();
  assertEquals(t.report(), { activity: { state: "model", since: clock.now }, lastProgressAt: clock.now });
  const started = (clock.now += MIN);
  t.toolStarted("c1", "bash", { command: "node --test tests/persona-model.test.mjs | grep fail" });
  clock.now += 13 * 60 * MIN;
  // The hung test: still the same tool since it started; no progress since the run began.
  assertEquals(t.report(), {
    activity: { state: "tool", tool: "bash", since: started, preview: "node --test tests/persona-model.test.mjs | grep fail" },
    lastProgressAt: started - MIN,
  });
});

test("tracker: a tool call or a turn completing is progress; the run ending is idle", () => {
  const { t, clock } = tracker();
  t.runStarted();
  t.toolStarted("c1", "read", { path: "src/a.ts" });
  const ended = (clock.now += 5_000);
  t.toolEnded("c1");
  assertEquals(t.report(), { activity: { state: "model", since: ended }, lastProgressAt: ended });
  const turn = (clock.now += 5_000);
  t.turnEnded();
  assertEquals(t.report().lastProgressAt, turn);
  const end = (clock.now += 5_000);
  t.runEnded();
  assertEquals(t.report(), { activity: { state: "idle", since: end }, lastProgressAt: end });
});

test("tracker: parallel tools report the longest-running one until all have returned", () => {
  const { t, clock } = tracker();
  t.runStarted();
  const first = (clock.now += 1_000);
  t.toolStarted("a", "bash", { command: "sleep 1000" });
  clock.now += 1_000;
  t.toolStarted("b", "read", { path: "x.ts" });
  assertEquals(t.activity(), { state: "tool", tool: "bash", since: first, preview: "sleep 1000" });
  clock.now += 1_000;
  t.toolEnded("a");
  assertEquals(t.activity().tool, "read");
  t.toolEnded("b");
  assertEquals(t.activity().state, "model");
});

test("tracker: a run ending clears tools that never reported their end (an abort)", () => {
  const { t } = tracker();
  t.runStarted();
  t.toolStarted("a", "bash", { command: "npm test" });
  t.runEnded();
  assertEquals(t.activity().state, "idle");
  t.runStarted();
  assertEquals(t.activity().state, "model");
});

test("preview: the command or path, never file contents; nothing without a known field", () => {
  assertEquals(toolPreview({ command: "npm test" }), "npm test");
  assertEquals(toolPreview({ path: "src/a.ts", content: "SECRET FILE BODY" }), "src/a.ts");
  assertEquals(toolPreview({ path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }), "src/a.ts");
  assertEquals(toolPreview({ content: "only contents" }), undefined);
  assertEquals(toolPreview(null), undefined);
  assertEquals(toolPreview("not an object"), undefined);
});

test("preview: one line, truncated with an ellipsis", () => {
  assertEquals(cleanActivityPreview("cd /repo &&\n  npm test\t--watch"), "cd /repo && npm test --watch");
  const long = cleanActivityPreview(`node --test ${"tests/x.test.mjs ".repeat(30)}`);
  assertEquals(long.length, ACTIVITY_PREVIEW_MAX);
  assert(long.endsWith("…"), "ends with an ellipsis");
  assertEquals(cleanActivityPreview("short"), "short");
});

test("preview: obvious secrets are redacted", () => {
  assertEquals(cleanActivityPreview("GITHUB_TOKEN=ghp_abc123 gh pr list"), "GITHUB_TOKEN=*** gh pr list");
  assertEquals(cleanActivityPreview("AWS_SECRET_ACCESS_KEY='a b' aws s3 ls"), "AWS_SECRET_ACCESS_KEY=*** aws s3 ls");
  assertEquals(cleanActivityPreview("export DB_PASSWORD=hunter2 && psql"), "export DB_PASSWORD=*** && psql");
  assertEquals(cleanActivityPreview("api_key=xyz curl"), "api_key=*** curl");
  assertEquals(cleanActivityPreview("curl -H 'Authorization: Bearer eyJhbGc.x.y' https://x"), "curl -H 'Authorization: Bearer ***' https://x");
  assertEquals(cleanActivityPreview("mytool --token abc --password=pw run"), "mytool --token *** --password=*** run");
  // Ordinary assignments are left alone.
  assertEquals(cleanActivityPreview("NODE_ENV=test npm test"), "NODE_ENV=test npm test");
  // Redacted before the cut, so a secret straddling the limit can't leak its start.
  const tail = cleanActivityPreview(`${"x".repeat(110)} MY_TOKEN=abcdefghijklmnop`);
  assert(!tail.includes("abcdef"), tail);
});
