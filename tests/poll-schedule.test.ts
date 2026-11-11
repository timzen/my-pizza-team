/**
 * tests/poll-schedule.test.ts — the poll schedule (docs/DESIGN.md "Polling States"):
 * after a check waits, the daemon queues the next one after `pollEvery`, holds a
 * due check while the team isn't ready (exactly one check on recovery), applies
 * `pollTimeout`/`onTimeout` (never while held: the recovery check runs first),
 * keeps at most one check in flight, resumes after a restart, stops when the task
 * leaves the state, and offers **Check now** (`POST /api/tasks/:id/check-now`).
 *
 * The clock is injected (`runPollChecks(now)`, `waitWorkItem(…, now)`), and so is
 * readiness (`setTeamReadiness`, with a member online so gating applies).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { post, withTeam } from "./_team.ts";
import { Store } from "../daemon/store.ts";
import type { WorkflowConfig } from "../shared/types.ts";

const MIN = 60_000;

/** in_progress (once) → cr (poll every 15m, 1h timeout, `onTimeout`) → review (manual). */
function pollWf(onTimeout: "fail" | "manual" = "fail"): WorkflowConfig {
  return {
    states: [
      { name: "in_progress", type: "teammate" },
      { name: "cr", type: "teammate", completion: "poll", pollEvery: "15m", pollTimeout: "1h", onTimeout },
      { name: "review", type: "manual" },
    ],
  };
}

const TASK = "s1-1";

/** Story s1 with its task moved into `cr`; member a1 online. Returns the first check's item id. */
function storyInCr(store: Store): string {
  store.registerMember("a1", "neo", "/tmp");
  store.createStory("s1", "S1", "D", "open", [], [{ title: "Send the CR", description: "Create it, then get it approved" }], "default");
  store.moveTask(TASK, "cr");
  return store.getActiveWorkItem(TASK)!.id;
}

/** Claim and end the task's active check with wait at `at`. */
function waitActive(store: Store, at: Date, reason = "CR not approved yet"): void {
  const item = store.getActiveWorkItem(TASK)!;
  assert(store.claimWorkItem(item.id, "a1"), "claimed");
  assert(store.waitWorkItem(item.id, reason, at).ok, "waited");
}

const at = (base: number, ms: number) => new Date(base + ms);
const readyCount = (store: Store) => store.getWorkItems({ states: ["READY"], workDefId: TASK }).total;

test("the next check is queued after pollEvery, on the tick, through the normal enqueue path", async () => {
  await withTeam({ workflows: { default: pollWf() } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.now();
    waitActive(store, at(t0, 0));

    store.runPollChecks(at(t0, 14 * MIN));
    assertEquals(readyCount(store), 0, "not due before pollEvery");
    assertEquals(store.getTaskPollStatus(TASK)!.nextCheckAt, at(t0, 15 * MIN).toISOString());

    store.runPollChecks(at(t0, 15 * MIN));
    const next = store.getActiveWorkItem(TASK)!;
    assertEquals(next.state, "READY");
    assertEquals(store.getTaskPollStatus(TASK)!.nextCheckAt, undefined, "no next check while one is queued");

    // The rhythm resumes from that check's end.
    assert(store.claimWorkItem(next.id, "a1"));
    assert(store.waitWorkItem(next.id, "still waiting", at(t0, 20 * MIN)).ok);
    store.runPollChecks(at(t0, 34 * MIN));
    assertEquals(readyCount(store), 0);
    store.runPollChecks(at(t0, 35 * MIN));
    assertEquals(readyCount(store), 1);
    assertEquals(store.getTask(TASK)!.poll!.checks, 2);
  });
});

test("at most one check is in flight: a queued or running check holds the next", async () => {
  await withTeam({ workflows: { default: pollWf() } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.now();
    waitActive(store, at(t0, 0));
    store.runPollChecks(at(t0, 15 * MIN));
    store.runPollChecks(at(t0, 30 * MIN));
    store.runPollChecks(at(t0, 45 * MIN));
    assertEquals(readyCount(store), 1, "one READY check, not one per tick");
    const item = store.getActiveWorkItem(TASK)!;
    assert(store.claimWorkItem(item.id, "a1"));
    store.runPollChecks(at(t0, 50 * MIN));
    assertEquals(store.getWorkItems({ states: ["READY", "IN_PROGRESS"], workDefId: TASK }).total, 1);
  });
});

test("a due check is held while not ready, then exactly one check runs on recovery", async () => {
  await withTeam({ workflows: { default: pollWf() } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.now();
    waitActive(store, at(t0, 0));

    store.setTeamReadiness(false, "mwinit credentials expired");
    store.runPollChecks(at(t0, 15 * MIN));
    assertEquals(readyCount(store), 0, "held, not queued");
    let poll = store.getTask(TASK)!.poll!;
    assertEquals(poll.heldForReadiness, true);
    assertEquals(poll.heldReason, "mwinit credentials expired");

    // Several missed intervals while not ready: still nothing queued.
    store.runPollChecks(at(t0, 30 * MIN));
    store.runPollChecks(at(t0, 45 * MIN));
    assertEquals(readyCount(store), 0);

    store.setTeamReadiness(true);
    store.runPollChecks(at(t0, 50 * MIN));
    assertEquals(readyCount(store), 1, "one check on recovery, not a backlog");
    poll = store.getTask(TASK)!.poll!;
    assertEquals(poll.heldForReadiness, undefined, "the hold clears");
    assertEquals(poll.heldReason, undefined);
    store.runPollChecks(at(t0, 51 * MIN));
    assertEquals(readyCount(store), 1);

    // The rhythm resumes from the recovery check's end.
    waitActive(store, at(t0, 52 * MIN));
    store.runPollChecks(at(t0, 66 * MIN));
    assertEquals(readyCount(store), 0);
  });
});

test("readiness gating doesn't apply with no teammate online (as for schedules)", async () => {
  await withTeam({ workflows: { default: pollWf() } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.now();
    waitActive(store, at(t0, 0));
    store.updateMemberStatus("a1", "offline");
    store.setTeamReadiness(false, "creds");
    store.runPollChecks(at(t0, 15 * MIN));
    assertEquals(readyCount(store), 1);
  });
});

test("onTimeout fail: once pollTimeout passes after a wait, the last check is failed and polling stops", async () => {
  await withTeam({ workflows: { default: pollWf("fail") } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.parse(store.getTask(TASK)!.poll!.startedAt);
    waitActive(store, at(t0, 50 * MIN));
    const waited = store.getWorkItems({ states: ["WAITED"], workDefId: TASK }).items[0]!;

    store.runPollChecks(at(t0, 61 * MIN));
    assertEquals(readyCount(store), 0, "no further check");
    const failed = store.getWorkItem(waited.id)!;
    assertEquals(failed.state, "FAILED");
    assertEquals(failed.read, false, "the outcome is news");
    assertEquals(store.getTask(TASK)!.status, "cr", "stuck in the state, as for any failed run");
    assert(store.getTask(TASK)!.poll!.timedOutAt, "timedOutAt recorded");
    const last = store.getCommentsForRef({ workDefId: TASK }).at(-1)!;
    assertEquals(last.from, "daemon");
    assertStringIncludes(last.body, "[timeout]");
    assertStringIncludes(last.body, "the task is failed");

    store.runPollChecks(at(t0, 90 * MIN));
    assertEquals(readyCount(store), 0, "polling has stopped");
  });
});

test("onTimeout manual: polling stops and the task is flagged for a human, nothing failed", async () => {
  await withTeam({ workflows: { default: pollWf("manual") } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.parse(store.getTask(TASK)!.poll!.startedAt);
    waitActive(store, at(t0, 50 * MIN));
    store.runPollChecks(at(t0, 61 * MIN));
    assertEquals(readyCount(store), 0);
    assertEquals(store.getWorkItems({ states: ["FAILED"], workDefId: TASK }).total, 0, "nothing failed");
    assertEquals(store.getWorkItems({ states: ["WAITED"], workDefId: TASK }).total, 1);
    const status = store.getTaskPollStatus(TASK)!;
    assert(status.timedOutAt, "flagged");
    assertEquals(status.onTimeout, "manual");
    assertEquals(status.nextCheckAt, undefined, "no next check");
    assertStringIncludes(store.getCommentsForRef({ workDefId: TASK }).at(-1)!.body, "needs a human");
    store.runPollChecks(at(t0, 120 * MIN));
    assertEquals(readyCount(store), 0);

    // The human moves it on: the record goes, as for a done check.
    assert(store.moveTask(TASK, "review").ok);
    assertEquals(store.getTask(TASK)!.poll, undefined);
  });
});

test("the timeout is never applied while held: the recovery check runs first, and the timeout applies only if it waits", async () => {
  await withTeam({ workflows: { default: pollWf("fail") } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.parse(store.getTask(TASK)!.poll!.startedAt);
    waitActive(store, at(t0, 40 * MIN));

    store.setTeamReadiness(false, "vpn down");
    store.runPollChecks(at(t0, 55 * MIN));
    store.runPollChecks(at(t0, 2 * 60 * MIN)); // well past the 1h timeout
    assertEquals(store.getWorkItems({ states: ["FAILED"], workDefId: TASK }).total, 0, "not failed while held");
    assertEquals(store.getTask(TASK)!.poll!.timedOutAt, undefined);
    assertEquals(store.getTask(TASK)!.poll!.heldForReadiness, true);

    store.setTeamReadiness(true);
    store.runPollChecks(at(t0, 2 * 60 * MIN + MIN));
    assertEquals(readyCount(store), 1, "the final check");
    assertEquals(store.getTask(TASK)!.poll!.timedOutAt, undefined);

    // It waits too → the timeout applies.
    waitActive(store, at(t0, 2 * 60 * MIN + 2 * MIN));
    store.runPollChecks(at(t0, 2 * 60 * MIN + 3 * MIN));
    assertEquals(store.getWorkItems({ states: ["FAILED"], workDefId: TASK }).total, 1);
    assert(store.getTask(TASK)!.poll!.timedOutAt);
  });
});

test("a timeout that falls due while not ready is held too, then decided after one final check", async () => {
  await withTeam({ workflows: { default: pollWf("fail") } }, async ({ store, app }) => {
    storyInCr(store);
    const t0 = Date.parse(store.getTask(TASK)!.poll!.startedAt);
    waitActive(store, at(t0, 59 * MIN)); // next check due at 74m; timeout at 60m
    store.setTeamReadiness(false, "creds");
    store.runPollChecks(at(t0, 61 * MIN));
    assertEquals(store.getTask(TASK)!.poll!.heldForReadiness, true);
    assertEquals(store.getWorkItems({ states: ["FAILED"], workDefId: TASK }).total, 0);

    store.setTeamReadiness(true);
    store.runPollChecks(at(t0, 62 * MIN));
    const final = store.getActiveWorkItem(TASK)!;
    assert(store.claimWorkItem(final.id, "a1"));
    // The final check is done: the task advances, no timeout at all.
    const res = await (await post(app, `/api/agents/work-items/${final.id}/state`, { agentId: "a1", state: "COMPLETE" })).json();
    assertEquals(res.newStatus, "review");
    assertEquals(store.getWorkItems({ states: ["FAILED"], workDefId: TASK }).total, 0);
  });
});

test("polling stops when the task leaves the state, is canceled, or its story goes pending", async () => {
  await withTeam({ workflows: { default: pollWf() } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.now();
    waitActive(store, at(t0, 0));

    // Pending story: nothing queued, nothing held.
    store.setStoryPending("s1", true);
    store.setTeamReadiness(false, "creds");
    store.runPollChecks(at(t0, 20 * MIN));
    assertEquals(readyCount(store), 0);
    assertEquals(store.getTask(TASK)!.poll!.heldForReadiness, undefined, "a pending story doesn't hold");
    store.setStoryPending("s1", false);
    store.setTeamReadiness(true);

    // A canceled check stops polling.
    store.runPollChecks(at(t0, 20 * MIN));
    const queued = store.getActiveWorkItem(TASK)!;
    assert(store.cancelWorkItem(queued.id));
    store.runPollChecks(at(t0, 60 * MIN));
    assertEquals(readyCount(store), 0, "canceled: no more checks");

    // Moved out of the state: its record goes and nothing more is queued.
    assert(store.moveTask(TASK, "review").ok);
    assertEquals(store.getTask(TASK)!.poll, undefined);
    store.runPollChecks(at(t0, 90 * MIN));
    assertEquals(readyCount(store), 0);
    assertEquals(store.getTaskPollStatus(TASK), null);
  });
});

test("a restart resumes from the persisted record: a check due while down runs once; a hold survives", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-poll-sched-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  try {
    const store = new Store(teamDir, structuredClone(TEST_CONFIG));
    store.saveWorkflow("default", pollWf());
    storyInCr(store);
    const t0 = Date.now();
    waitActive(store, at(t0, 0));
    store.setTeamReadiness(false, "creds");
    store.runPollChecks(at(t0, 15 * MIN));
    assertEquals(store.getTask(TASK)!.poll!.heldForReadiness, true);
    store.close();

    const story = JSON.parse(fs.readFileSync(path.join(teamDir, "stories", "s1.json"), "utf8"));
    assertEquals(story.tasks[0].poll.heldForReadiness, true, "the hold is on the story file");
    assertEquals(story.tasks[0].poll.heldReason, "creds");

    const store2 = new Store(teamDir, structuredClone(TEST_CONFIG));
    try {
      assertEquals(store2.getActiveWorkItem(TASK), null, "the restart itself queues nothing");
      // Down for hours: one due check, not one per missed interval.
      store2.runPollChecks(at(t0, 3 * 60 * MIN - 1));
      store2.runPollChecks(at(t0, 3 * 60 * MIN));
      assertEquals(store2.getWorkItems({ states: ["READY"], workDefId: TASK }).total, 1);
      assertEquals(store2.getTask(TASK)!.poll!.heldForReadiness, undefined);
    } finally {
      store2.close();
    }
  } finally {
    fs.rmSync(teamDir, { recursive: true, force: true });
  }
});

test("POST /api/tasks/:id/check-now queues a check now, refuses when one is in flight or the team isn't ready", async () => {
  await withTeam({ workflows: { default: pollWf() } }, async ({ app, store }) => {
    storyInCr(store);
    // The first check is still queued: refused.
    let res = await post(app, `/api/tasks/${TASK}/check-now`);
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "already queued or running");

    waitActive(store, new Date());

    store.setTeamReadiness(false, "mwinit credentials expired");
    res = await post(app, `/api/tasks/${TASK}/check-now`);
    assertEquals(res.status, 409);
    const refused = await res.json();
    assertEquals(refused.readiness, "mwinit credentials expired");
    assertStringIncludes(refused.error, "mwinit credentials expired");
    assertEquals(readyCount(store), 0, "nothing queued");

    store.setTeamReadiness(true);
    res = await post(app, `/api/tasks/${TASK}/check-now`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(store.getActiveWorkItem(TASK)!.id, body.workItem.id);

    assertEquals((await post(app, `/api/tasks/nope/check-now`)).status, 404);
  });
});

test("Check now is refused outside a poll state, and the board shows the poll status", async () => {
  await withTeam({ workflows: { default: pollWf() } }, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T", description: "D" }], "default");
    const res = await post(app, `/api/tasks/${TASK}/check-now`);
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "isn't a poll state");

    store.moveTask(TASK, "cr");
    waitActive(store, new Date(), "2 comments open");
    const stories = await (await app.request("/api/stories")).json();
    const view = stories.stories[0].tasks[0];
    assertEquals(view.poll.lastWaitReason, "2 comments open");
    assertEquals(view.poll.checks, 1);
    assert(view.poll.nextCheckAt, "next check shown");
    assertEquals(view.poll.onTimeout, "fail");
  });
});

test("the daemon tick runs the poll schedule (the Story source ticks)", async () => {
  await withTeam({ workflows: { default: pollWf() } }, async ({ store }) => {
    storyInCr(store);
    const t0 = Date.now();
    waitActive(store, at(t0, 0));
    store.tickWorkSources(at(t0, 15 * MIN));
    assertEquals(readyCount(store), 1);
  });
});
