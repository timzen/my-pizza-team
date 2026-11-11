/**
 * tests/poll-states.test.ts — poll-state config and the "wait" run outcome
 * (docs/DESIGN.md "Polling States").
 *
 * - `validateWorkflow` accepts good completion/poll fields and refuses bad
 *   ones; a manual state's are ignored with a load warning (like a persona).
 * - `parseDuration` reads "15m" / "7d" / "1h 30m" and refuses the rest.
 * - A teammate in a poll state ends a check with WAITED: the item is terminal
 *   (and read), the task neither advances nor fails, and its poll record
 *   notes the check. A once state refuses WAITED and keeps the item in flight.
 * - The claim reports `completion`, and a poll state's prompt states the check
 *   contract and quotes the earlier checks.
 * - The poll record survives a daemon restart, and a waited task isn't
 *   re-enqueued by the restart's reconcile.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { makeTeam, post, withTeam } from "./_team.ts";
import { Store } from "../daemon/store.ts";
import { buildWorkDefPrompt, POLL_CHECK_CONTRACT } from "../daemon/prompt.ts";
import { ignoredStateFields, pollSettings, validateWorkflow } from "../daemon/workflow-engine.ts";
import { parseDuration } from "../shared/duration.ts";
import type { WorkflowConfig, WorkflowState } from "../shared/types.ts";

/** in_progress (once) → cr (poll every 15m) → review (manual). */
const POLL_WF: WorkflowConfig = {
  states: [
    { name: "in_progress", type: "teammate" },
    { name: "cr", type: "teammate", completion: "poll", pollEvery: "15m", pollTimeout: "2d", onTimeout: "fail" },
    { name: "review", type: "manual" },
  ],
};

/** A one-state workflow around `state`, validated. */
function validate(state: Partial<WorkflowState>): string | null {
  return validateWorkflow({ states: [{ name: "s", type: "teammate", ...state } as WorkflowState] });
}

// --- Durations ---

test("parseDuration reads unit-suffixed durations and refuses the rest", () => {
  assertEquals(parseDuration("30s"), 30_000);
  assertEquals(parseDuration("15m"), 900_000);
  assertEquals(parseDuration("1h 30m"), 5_400_000);
  assertEquals(parseDuration("1h30m"), 5_400_000);
  assertEquals(parseDuration("7d"), 604_800_000);
  assertEquals(parseDuration("2w"), 1_209_600_000);
  for (const bad of ["", "15", "0m", "1.5h", "-5m", "5 minutes", "m", 15, null, undefined]) {
    assertEquals(parseDuration(bad), null, `refuses ${JSON.stringify(bad)}`);
  }
});

// --- Config validation ---

test("validateWorkflow accepts poll states and today's once states", () => {
  assertEquals(validateWorkflow(POLL_WF), null);
  assertEquals(validate({}), null);
  assertEquals(validate({ completion: "once" }), null);
  assertEquals(validate({ completion: "poll", pollEvery: "1m" }), null, "the minimum is allowed");
  assertEquals(validate({ completion: "poll", pollEvery: "15m", onTimeout: "manual" }), null);
});

test("validateWorkflow refuses bad completion and poll fields", () => {
  const cases: Array<[Partial<WorkflowState>, string]> = [
    [{ completion: "forever" as never }, `completion must be "once" or "poll"`],
    [{ completion: "poll" }, "needs pollEvery"],
    [{ completion: "poll", pollEvery: "soon" }, "pollEvery must be a duration"],
    [{ completion: "poll", pollEvery: "30s" }, "at least 1m"],
    [{ completion: "poll", pollEvery: "15m", pollTimeout: "a week" }, "pollTimeout must be a duration"],
    [{ completion: "poll", pollEvery: "1h", pollTimeout: "30m" }, "pollTimeout must be at least pollEvery"],
    [{ completion: "poll", pollEvery: "15m", onTimeout: "retry" as never }, `onTimeout must be "fail" or "manual"`],
    [{ pollEvery: "15m" }, `pollEvery only apply with completion "poll"`],
    [{ completion: "once", onTimeout: "fail" }, `onTimeout only apply with completion "poll"`],
  ];
  for (const [state, message] of cases) {
    const err = validate(state);
    assert(err !== null, `refuses ${JSON.stringify(state)}`);
    assertStringIncludes(err!, message);
    assertStringIncludes(err!, `State "s"`);
  }
});

test("pollSettings applies the defaults; once and manual states have none", () => {
  const wf: WorkflowConfig = {
    states: [
      { name: "a", type: "teammate", completion: "poll", pollEvery: "15m" },
      { name: "b", type: "teammate" },
      { name: "c", type: "manual", completion: "poll", pollEvery: "15m" },
    ],
  };
  assertEquals(pollSettings(wf, "a"), { pollEveryMs: 900_000, pollTimeoutMs: 604_800_000, onTimeout: "manual" });
  assertEquals(pollSettings(POLL_WF, "cr"), { pollEveryMs: 900_000, pollTimeoutMs: 172_800_000, onTimeout: "fail" });
  assertEquals(pollSettings(wf, "b"), null);
  assertEquals(pollSettings(wf, "c"), null);
  assertEquals(pollSettings(wf, "todo"), null);
});

test("a manual state's poll fields are ignored with a load warning, like a persona", () => {
  const wf: WorkflowConfig = {
    states: [
      { name: "build", type: "teammate" },
      { name: "approve", type: "manual", completion: "poll", pollEvery: "nonsense", onTimeout: "fail" },
    ],
  };
  assertEquals(validateWorkflow(wf), null, "a manual state's fields aren't judged");
  assertEquals(ignoredStateFields(wf.states[1]!), ["completion", "pollEvery", "onTimeout"]);
  assertEquals(ignoredStateFields(wf.states[0]!), []);

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    const team = makeTeam({}, {
      beforeStore: (teamDir) => {
        fs.mkdirSync(path.join(teamDir, "workflows", "gate"), { recursive: true });
        fs.writeFileSync(path.join(teamDir, "workflows", "gate", "workflow.json"), JSON.stringify(wf));
      },
    });
    try {
      assert(team.store.getWorkflows().gate, "the workflow still loads");
    } finally {
      team.cleanup();
    }
  } finally {
    console.warn = original;
  }
  const mine = warnings.filter((w) => w.includes("manual state 'approve'"));
  assertEquals(mine.length, 3);
  assertStringIncludes(mine[0]!, "sets 'completion', which is ignored");
});

test("PUT /api/config refuses a workflow with a bad poll state", async () => {
  await withTeam({ workflows: { default: POLL_WF } }, async ({ app }) => {
    const config = await (await app.request("/api/config")).json();
    const bad = { states: [{ name: "cr", type: "teammate", completion: "poll" }] };
    const res = await app.request("/api/config", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, workflows: { ...config.workflows, default: bad } }),
    });
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).error, "needs pollEvery");
  });
});

// --- The wait outcome ---

/** A story on POLL_WF whose first task has been advanced into the `cr` poll state. */
function storyInCr(store: Store): string {
  store.createStory("s1", "S1", "D", "open", [], [{ title: "Send the CR", description: "Create it, then get it approved" }], "default");
  store.moveTask("s1-1", "cr");
  return store.getActiveWorkItem("s1-1")!.id;
}

test("a poll state's check ends WAITED: the task stays put, its poll record notes the check", async () => {
  await withTeam({ workflows: { default: POLL_WF } }, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    const wid = storyInCr(store);
    const entered = store.getTask("s1-1")!.poll!;
    assertEquals(entered.state, "cr");
    assertEquals(entered.checks, 0);

    const claim = await (await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" })).json();
    assertEquals(claim.completion, "poll");

    const res = await post(app, `/api/agents/work-items/${wid}/state`, {
      agentId: "a1", state: "WAITED", reason: "CR-123 has 2 unresolved comments; revision posted",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.waited, true);
    assertEquals(body.checks, 1);

    const item = store.getWorkItem(wid)!;
    assertEquals(item.state, "WAITED");
    assertEquals(item.read, true, "a wait isn't news");
    assertEquals(store.getActiveWorkItem("s1-1"), null, "one-shot: no item stays in flight");
    const task = store.getTask("s1-1")!;
    assertEquals(task.status, "cr", "neither advanced nor moved");
    assertEquals(task.poll!.checks, 1);
    assertEquals(task.poll!.startedAt, entered.startedAt);
    assertEquals(task.poll!.lastWaitReason, "CR-123 has 2 unresolved comments; revision posted");
    assert(task.poll!.lastCheckAt, "lastCheckAt set");
    assertEquals(store.getMember("a1")!.status, "idle");
    // The move canceled the in_progress item (not a run); the waited check is one.
    assertEquals(store.getExecutionStatsFor("s1-1").executionCount, 1, "a waited check is a run");
  });
});

test("a later done check advances the poll state as usual and drops the poll record", async () => {
  await withTeam({ workflows: { default: POLL_WF } }, async ({ app, store, teamDir }) => {
    store.registerMember("a1", "neo", "/tmp");
    storyInCr(store);
    const wid = store.getActiveWorkItem("s1-1")!.id;
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    const res = await (await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE" })).json();
    assertEquals(res.newStatus, "review");
    assertEquals(store.getTask("s1-1")!.poll, undefined);
    const story = JSON.parse(fs.readFileSync(path.join(teamDir, "stories", "s1.json"), "utf8"));
    assertEquals(story.tasks[0].poll, undefined, "the story file drops it too");
  });
});

test("WAITED is refused in a once state, and the item stays in flight", async () => {
  await withTeam({ workflows: { default: POLL_WF } }, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = store.getActiveWorkItem("s1-1")!.id;
    const claim = await (await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" })).json();
    assertEquals(claim.completion, "once");

    const res = await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "WAITED", reason: "not yet" });
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).error, `its state "in_progress" completes once`);
    assertEquals(store.getWorkItem(wid)!.state, "IN_PROGRESS");
    assertEquals(store.getTask("s1-1")!.poll, undefined);

    // Still completable the normal way.
    const done = await (await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE" })).json();
    assertEquals(done.newStatus, "cr");
  });
});

test("WAITED is refused for standalone work and without a reason", async () => {
  await withTeam({ workflows: { default: POLL_WF } }, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createWorkDef({ title: "Solo", goal: "Do it", acceptanceCriteria: "" });
    const item = store.getWorkItems({ states: ["READY"] }).items.find((i) => i.title === "Solo")!;
    await post(app, `/api/agents/claim/${item.id}`, { agentId: "a1" });
    const solo = await post(app, `/api/agents/work-items/${item.id}/state`, { agentId: "a1", state: "WAITED", reason: "later" });
    assertEquals(solo.status, 400);
    assertStringIncludes((await solo.json()).error, "isn't a board task in a poll state");

    const wid = storyInCr(store);
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    const noReason = await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "WAITED" });
    assertEquals(noReason.status, 400);
    assertStringIncludes((await noReason.json()).error, "'reason' is required");
    assertEquals(store.getWorkItem(wid)!.state, "IN_PROGRESS");
  });
});

// --- The prompt ---

test("a poll state's prompt states the check contract and quotes the earlier checks", async () => {
  await withTeam({ workflows: { default: POLL_WF } }, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    const wid = storyInCr(store);
    assert(store.claimWorkItem(wid, "a1"));
    store.addCommentForRef({ workDefId: "s1-1" }, "a1", "[status] Started working on this.");
    store.addCommentForRef({ workDefId: "s1-1" }, "a1", "[wait] CR-123 created; waiting for review");
    assert(store.waitWorkItem(wid, "CR-123 created; waiting for review").ok);
    // The next check (queued by hand here; scheduling it is the poll schedule's job).
    const next = store.reEnqueueRef({ workDefId: "s1-1" })!;

    const claim = await (await post(app, `/api/agents/claim/${next.id}`, { agentId: "a1" })).json();
    const prompt: string = claim.prompt;
    assertStringIncludes(prompt, "## Your Role: cr");
    assertStringIncludes(prompt, POLL_CHECK_CONTRACT);
    assertStringIncludes(prompt, "Each run is one check; read the thread for what earlier checks did; post what you did; finish with done when complete, wait if it isn't yet, fail if it can't be done.");
    assertStringIncludes(prompt, "`wait_for_next_check`");
    assertStringIncludes(prompt, "1 earlier check ended with wait");
    assertStringIncludes(prompt, "## Earlier Checks");
    assertStringIncludes(prompt, "> [wait] CR-123 created; waiting for review");
    assert(!prompt.includes("[status] Started working on this."), "the started line isn't quoted");
    assert(!prompt.includes("## Completing This Work"), "not the once-state ending");
  });
});

test("a once state's prompt is unchanged (no poll contract)", () => {
  const input = { workDef: { title: "T", goal: "G", acceptanceCriteria: "" }, state: "in_progress" };
  const prompt = buildWorkDefPrompt(input);
  assertStringIncludes(prompt, "## Completing This Work");
  assertStringIncludes(prompt, "the task then advances automatically");
  assert(!prompt.includes("wait_for_next_check"));
  assert(!prompt.includes("Earlier Checks"));
  // The first check has nothing earlier to quote.
  const first = buildWorkDefPrompt({ ...input, poll: { since: new Date().toISOString(), checks: 0 } });
  assertStringIncludes(first, POLL_CHECK_CONTRACT);
  assert(!first.includes("## Earlier Checks"));
  assert(!first.includes("ended with wait"));
});

// --- Persistence ---

test("the poll record survives a daemon restart, and the restart doesn't re-run a waited check", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-poll-restart-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  try {
    const store = new Store(teamDir, structuredClone(TEST_CONFIG));
    store.saveWorkflow("default", POLL_WF);
    const wid = storyInCr(store);
    assert(store.claimWorkItem(wid, "a1"));
    assert(store.waitWorkItem(wid, "waiting for approval").ok);
    const before = store.getTask("s1-1")!.poll!;
    store.close();

    const story = JSON.parse(fs.readFileSync(path.join(teamDir, "stories", "s1.json"), "utf8"));
    assertEquals(story.tasks[0].poll.lastWaitReason, "waiting for approval", "the story file is the record");

    const store2 = new Store(teamDir, structuredClone(TEST_CONFIG));
    try {
      assertEquals(store2.getTask("s1-1")!.status, "cr");
      assertEquals(store2.getTask("s1-1")!.poll, before);
      assertEquals(store2.getStory("s1")!.tasks[0]!.poll, before);
      assertEquals(store2.getActiveWorkItem("s1-1"), null, "the next check is the poll schedule's, not the restart's");
      assertEquals(store2.getWorkItem(wid)!.state, "WAITED");
    } finally {
      store2.close();
    }
  } finally {
    fs.rmSync(teamDir, { recursive: true, force: true });
  }
});
