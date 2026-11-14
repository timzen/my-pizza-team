/**
 * tests/interrupt.test.ts — The agent's side of Interrupt, harness-agnostic
 * (runtime/interrupt.ts; docs/DESIGN.md "Stalled Teammates").
 *
 * On fakes: `offer` reads the activity, tells the loop the run is being
 * interrupted and aborts it — once per directive, however often the poll
 * offers it; `runSettled` then sends the nudge and marks the directive done;
 * one that can't be realized (no item, no run, paired) is failed with the
 * reason; a report the daemon didn't get is sent again on the next offer,
 * never aborting twice. And the nudge's wording. (Pi's real bash tool and a
 * hung subprocess: harnesses/pi/tests/interrupt.test.mjs.)
 */

import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { InterruptRealizer, interruptNudge, type InterruptRealizerDeps } from "../runtime/interrupt.ts";
import type { AgentActivityReport } from "../shared/agent-protocol.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-14T03:00:00Z");
const NOW = T0 + 13 * 60 * MIN;
const HUNG: AgentActivityReport = { activity: { state: "tool", tool: "bash", since: T0, preview: "node --test tests/persona-model.test.mjs | grep fail" }, lastProgressAt: T0 };

/** A realizer on fakes, and what it did. */
function realizer(over: Partial<InterruptRealizerDeps> = {}) {
  const log = { aborts: 0, marked: [] as string[], nudges: [] as string[], reports: [] as Array<[string, string, string | undefined]> };
  let failReports = false;
  const deps: InterruptRealizerDeps = {
    workItemId: () => "wi-1",
    isRunning: () => true,
    isAutonomous: () => true,
    activity: () => HUNG,
    markInterrupted: (id) => { log.marked.push(id); },
    abort: () => { log.aborts++; },
    sendNudge: (text) => { log.nudges.push(text); },
    complete: async (id, status, error) => {
      if (failReports) throw new Error("daemon unreachable");
      log.reports.push([id, status, error]);
    },
    now: () => NOW,
    ...over,
  };
  return { r: new InterruptRealizer(deps), log, setFailReports: (v: boolean) => { failReports = v; } };
}

test("nudge: names the command and how long it made no progress, and says what to do", () => {
  assertEquals(
    interruptNudge(HUNG, NOW),
    "Your last command (`node --test tests/persona-model.test.mjs | grep fail`) was interrupted by the user after 13h with no progress. " +
      "It likely hung. Find out why (e.g. a test that never settles), re-run with a timeout, then continue your task.",
  );
  assertStringIncludes(interruptNudge({ activity: { state: "tool", tool: "grep", since: T0 }, lastProgressAt: T0 }, T0 + 45 * MIN), "Your last grep call was interrupted by the user after 45m");
  assertStringIncludes(interruptNudge({ activity: { state: "model", since: T0 }, lastProgressAt: T0 }, T0 + 31 * MIN), "Your last model call was interrupted");
  assertStringIncludes(interruptNudge(null, NOW), "Your last step was interrupted by the user with no progress.");
  assertStringIncludes(interruptNudge(HUNG, NOW, "  it's the persona-model test  "), "continue your task. The user said: it's the persona-model test");
});

test("offer aborts the run once and holds the nudge; runSettled sends it and marks the directive done", async () => {
  const { r, log } = realizer();
  await r.offer({ id: "d1", params: {} });
  assertEquals([log.aborts, log.marked], [1, ["wi-1"]]);
  assert(r.pending, "waiting for the aborted run to settle");
  assertEquals(log.nudges, [], "not before the run settled");
  // The poll offers it again while the run settles: nothing more happens.
  await r.offer({ id: "d1", params: {} });
  assertEquals(log.aborts, 1);
  await r.runSettled();
  assertEquals(log.nudges.length, 1);
  assertStringIncludes(log.nudges[0]!, "`node --test tests/persona-model.test.mjs | grep fail`");
  assertEquals(log.reports, [["d1", "done", undefined]]);
  assertEquals(r.pending, false);
  // A settle with nothing waiting (an ordinary run) does nothing.
  await r.runSettled();
  assertEquals(log.nudges.length, 1);
});

test("one that can't be realized is failed at once with the reason", async () => {
  for (const [over, reason] of [
    [{ workItemId: () => null }, "not working on a work item"],
    [{ isAutonomous: () => false }, "paired with a human"],
    [{ isRunning: () => false }, "no run in flight to interrupt"],
  ] as const) {
    const { r, log } = realizer(over as Partial<InterruptRealizerDeps>);
    await r.offer({ id: "d1" });
    assertEquals(log.aborts, 0, reason);
    assertEquals(log.reports.length, 1);
    assertEquals(log.reports[0]![1], "failed");
    assertStringIncludes(log.reports[0]![2] ?? "", reason);
  }
});

test("a report the daemon didn't get is sent again on the next offer — the run is never aborted twice", async () => {
  const { r, log, setFailReports } = realizer();
  await r.offer({ id: "d1" });
  setFailReports(true);
  await r.runSettled();
  assertEquals(log.reports, []);
  setFailReports(false);
  await r.offer({ id: "d1" });
  assertEquals(log.reports, [["d1", "done", undefined]]);
  assertEquals(log.aborts, 1);
  assertEquals(log.nudges.length, 1);
});

test("a stopped realizer (the session is going away) realizes nothing", async () => {
  const { r, log } = realizer();
  await r.offer({ id: "d1" });
  r.stop();
  await r.runSettled();
  await r.offer({ id: "d2" });
  assertEquals([log.aborts, log.nudges.length, log.reports.length], [1, 0, 0]);
});
