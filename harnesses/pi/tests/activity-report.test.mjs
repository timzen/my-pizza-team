// Activity reports for the stall check: Pi's events drive the tracker, and both
// roles send it with every heartbeat.
// Run with: node --experimental-strip-types tests/activity-report.test.mjs
//
// The daemon flags a teammate that is alive but stuck — a hung `node --test`
// slept for 13 hours behind a fresh heartbeat — from what the harness says it
// is doing and when it last made progress (my-pizza-team docs/DESIGN.md
// "Stalled Teammates"). This drives Pi's run and tool events through
// `attachActivity` (src/activity-report.ts) on a fake clock, and checks from
// source that the teammate's and the leader's heartbeats carry the report.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachActivity } from "../src/activity-report.ts";
import { ActivityTracker } from "../src/runtime/activity.ts";

let passed = 0;
let failed = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}: ${e.message}`); failed++; }
}

/** A fake Pi that records pi.on handlers and emits events to them. */
function fakePi() {
  const handlers = new Map();
  return {
    on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
    async emit(name, event = {}) { for (const fn of handlers.get(name) ?? []) await fn(event, {}); },
  };
}

console.log("attachActivity:");

await test("a run, a tool and its end move the activity and the last progress", async () => {
  const pi = fakePi();
  const clock = { now: 1000 };
  const activity = attachActivity(pi, new ActivityTracker(() => clock.now));
  assert.deepEqual(activity.report(), { activity: { state: "idle", since: 1000 }, lastProgressAt: 1000 });
  clock.now = 2000;
  await pi.emit("agent_start");
  assert.deepEqual(activity.report().activity, { state: "model", since: 2000 });
  clock.now = 3000;
  await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "GH_TOKEN=x node --test\n tests/a.test.mjs" } });
  clock.now = 3000 + 13 * 3_600_000;
  assert.deepEqual(activity.report(), {
    activity: { state: "tool", tool: "bash", since: 3000, preview: "GH_TOKEN=*** node --test tests/a.test.mjs" },
    lastProgressAt: 2000,
  });
  await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: true });
  assert.deepEqual(activity.report(), { activity: { state: "model", since: clock.now }, lastProgressAt: clock.now });
  clock.now += 10;
  await pi.emit("turn_end", {});
  assert.equal(activity.report().lastProgressAt, clock.now);
  clock.now += 10;
  await pi.emit("agent_end", { messages: [] });
  assert.deepEqual(activity.report(), { activity: { state: "idle", since: clock.now }, lastProgressAt: clock.now });
});

const src = (f) => fs.readFileSync(path.join(import.meta.dirname, "../src", f), "utf8");

await test("the teammate's heartbeats carry the report", () => {
  const teammate = src("teammate.ts");
  assert.equal((teammate.match(/this\.client\.heartbeat\([^)]*this\.activityReport\?\.\(\)\)/g) ?? []).length, 3);
  assert.match(src("index.ts"), /loop\.activityReport = \(\) => activity\.report\(\);/);
});

await test("the leader's heartbeat carries the report", () => {
  assert.match(src("leader.ts"), /client\.heartbeat\("idle", undefined, activity\.report\(\)\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
