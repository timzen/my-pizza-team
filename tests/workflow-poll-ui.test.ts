/**
 * tests/workflow-poll-ui.test.ts — The workflow editor's completion controls
 * (ui/src/lib/workflow-poll.ts; docs/DESIGN.md "Polling States"): Single run vs
 * Poll until complete, the poll fields, and validation that is the daemon's own
 * (shared/poll-config.ts, run by daemon/workflow-engine.ts `validateWorkflow`).
 */

import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import type { WorkflowState } from "../shared/types.ts";
import { validateWorkflow } from "../daemon/workflow-engine.ts";
import {
  asManual, isPollingState, pollErrorText, pollSummary, withCompletion, withPollField, workflowPollErrors,
} from "../ui/src/lib/workflow-poll.ts";

const cr: WorkflowState = { name: "cr", type: "teammate", persona: "cr-writer" };

test("withCompletion: Poll sets completion and a starting interval; Single run drops every poll field", () => {
  const poll = withCompletion(cr, "poll");
  assertEquals(poll, { name: "cr", type: "teammate", persona: "cr-writer", completion: "poll", pollEvery: "15m" });
  assert(isPollingState(poll));
  const back = withCompletion({ ...poll, pollTimeout: "2d", onTimeout: "fail" }, "once");
  assertEquals(back, cr, "a once state saves exactly as before: no completion key at all");
  assert(!isPollingState(back));
  assertEquals(withCompletion({ ...cr, completion: "poll", pollEvery: "1h" }, "poll").pollEvery, "1h", "keeps an interval it has");
});

test("withPollField: empty clears to the default; asManual drops the completion fields", () => {
  const poll = withCompletion(cr, "poll");
  assertEquals(withPollField(poll, "pollTimeout", "3d").pollTimeout, "3d");
  assertEquals("pollTimeout" in withPollField({ ...poll, pollTimeout: "3d" }, "pollTimeout", "  "), false);
  assertEquals(withPollField(poll, "onTimeout", "fail").onTimeout, "fail");
  assertEquals("onTimeout" in withPollField({ ...poll, onTimeout: "fail" }, "onTimeout", ""), false);
  assertEquals(asManual({ ...poll, pollTimeout: "3d" }), { name: "cr", type: "manual", persona: "cr-writer" });
  assert(!isPollingState({ type: "manual", completion: "poll" }), "a manual state never polls");
});

test("workflowPollErrors: the daemon's rule, field by field — including the 1m minimum", () => {
  const poll = withCompletion(cr, "poll");
  const cases: Array<[WorkflowState, string | null]> = [
    [poll, null],
    [{ ...poll, pollEvery: "1m" }, null],
    [{ ...poll, pollEvery: "30s" }, "pollEvery"],
    [{ ...poll, pollEvery: "15" }, "pollEvery"],
    [withPollField(poll, "pollEvery", ""), "pollEvery"],
    [{ ...poll, pollTimeout: "10m" }, "pollTimeout"],
    [{ ...poll, pollTimeout: "soon" }, "pollTimeout"],
    [{ ...poll, pollTimeout: "15m" }, null],
    [cr, null],
    [{ name: "review", type: "manual", completion: "poll", pollEvery: "5s" }, null],
  ];
  for (const [state, field] of cases) {
    const errs = workflowPollErrors([state]);
    assertEquals(errs[state.name]?.field ?? null, field, JSON.stringify(state));
    // The editor refuses exactly what the daemon's save would.
    const daemon = validateWorkflow({ states: [state] });
    assertEquals(daemon === null, field === null, `daemon agrees on ${JSON.stringify(state)}: ${daemon}`);
    if (field) assertEquals(daemon, `State "${state.name}": ${errs[state.name]!.message}`);
  }
});

test("pollErrorText / pollSummary: the editor's wording", () => {
  const err = workflowPollErrors([{ ...withCompletion(cr, "poll"), pollEvery: "30s" }]).cr!;
  assertEquals(pollErrorText(err), "The interval must be at least 1m");
  assertEquals(pollErrorText(workflowPollErrors([withPollField(withCompletion(cr, "poll"), "pollEvery", "")]).cr!), 'Poll needs an interval (a duration such as "15m")');
  assertEquals(pollSummary({ pollEvery: "15m" }), "Checks every 15m, up to 7d; then needs attention");
  assertEquals(pollSummary({ pollEvery: "1h", pollTimeout: "2d", onTimeout: "fail" }), "Checks every 1h, up to 2d; then fails");
});
