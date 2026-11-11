/**
 * tests/onboarding.test.ts — The Welcome checklist's progress (daemon/onboarding.ts,
 * daemon/routes/onboarding.ts).
 *
 * Each step is derived from real team state, never ticked by a script: these
 * tests change that state (register agents, create and run work, write to the
 * assistant, capture a note) and watch GET /api/onboarding follow. They also pin
 * the persisted marks (dismiss, reopen, the latched completedAt), the "team with
 * history" rule, and the sample task's create route.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, post, get } from "./_team.ts";
import type { OnboardingResponse, OnboardingStepId } from "../shared/protocol.ts";
import { ONBOARDING_STEP_IDS } from "../shared/protocol.ts";
import { ONBOARDING_HISTORY_RUNS, deriveOnboarding, type OnboardingFacts } from "../daemon/onboarding.ts";
import type { Store } from "../daemon/store.ts";

/** GET /api/onboarding as JSON. */
async function onboarding(app: Parameters<typeof get>[0]): Promise<OnboardingResponse> {
  return (await get(app, "/api/onboarding")).json();
}

/** The ids of the done steps. */
function done(res: OnboardingResponse): OnboardingStepId[] {
  return res.steps.filter((s) => s.done).map((s) => s.id);
}

/** Enqueue a Solitary task, claim it as `memberId`, and finish it; returns the WorkItem id. */
function runOne(store: Store, memberId: string, title: string): string {
  const def = store.createWorkDef({ title, goal: "Do it", acceptanceCriteria: "" });
  const item = store.getActiveWorkItem(def.id)!;
  assertEquals(store.claimWorkItem(item.id, memberId), true);
  assertEquals(store.setWorkItemState(item.id, "COMPLETE").ok, true);
  return item.id;
}

const NO_FACTS: OnboardingFacts = {
  leaderOnline: false, teammatesOnline: 0, hasTask: false, claimedRuns: 0, finishedRuns: 0,
  reviewedRuns: 0, firstUserMessageAt: null, firstThoughtAt: null,
};
const NO_MARKS = { dismissedAt: null, reopenedAt: null, completedAt: null };

test("a new team: every step undone, in order, and the card visible", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await onboarding(app);
    assertEquals(res.steps.map((s) => s.id), [...ONBOARDING_STEP_IDS]);
    assertEquals(done(res), []);
    assertEquals(res.complete, false);
    assertEquals(res.visible, true);
    assertEquals(res.hasHistory, false);
    assertEquals([res.dismissedAt, res.reopenedAt, res.completedAt], [null, null, null]);
    // No leader online: the sample task has no directory yet (the card asks).
    assertEquals(res.sampleTask?.title, "Summarize this project");
    assertEquals(res.sampleTask?.directory, null);
    assertEquals(res.sampleTask?.persona, "builtin:teammate");
  });
});

test("steps tick off from real state, through to complete", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("lead", "leader", "/tmp/project");
    assertEquals(done(await onboarding(app)), ["leaderOnline"]);
    assertEquals((await onboarding(app)).sampleTask?.directory, "/tmp/project");

    store.registerMember("w1", "worker-1", "/tmp/project");
    assertEquals(done(await onboarding(app)), ["leaderOnline", "teammateOnline"]);

    const def = store.createWorkDef({ title: "First", goal: "Do it", acceptanceCriteria: "" });
    assertEquals(done(await onboarding(app)).includes("firstTaskCreated"), true);
    assertEquals(done(await onboarding(app)).includes("firstRunStarted"), false);

    const item = store.getActiveWorkItem(def.id)!;
    store.claimWorkItem(item.id, "w1");
    assertEquals(done(await onboarding(app)).includes("firstRunStarted"), true);

    store.setWorkItemState(item.id, "COMPLETE");
    assertEquals(done(await onboarding(app)).includes("firstRunReviewed"), false);
    store.markWorkItemRead(item.id);
    assertEquals(done(await onboarding(app)).includes("firstRunReviewed"), true);

    await post(app, "/api/assistant/messages", { content: "hello" });
    const afterChat = await onboarding(app);
    const chatStep = afterChat.steps.find((s) => s.id === "assistantUsed")!;
    assertEquals(chatStep.done, true);
    assertEquals(typeof chatStep.at, "string");
    assertEquals(afterChat.complete, false);
    assertEquals(afterChat.completedAt, null);

    store.createThought({ content: "an idea" });
    const res = await onboarding(app);
    assertEquals(done(res), [...ONBOARDING_STEP_IDS]);
    assertEquals(res.complete, true);
    // First seen complete: completedAt is latched and the card goes away…
    assertEquals(typeof res.completedAt, "string");
    assertEquals(res.visible, false);

    // …and stays gone when a step reads false again (the leader stopped).
    store.removeMember("lead");
    const later = await onboarding(app);
    assertEquals(later.complete, false);
    assertEquals(later.completedAt, res.completedAt);
    assertEquals(later.visible, false);
  });
});

test("a note's triage container is not a first task; a note is a captured thought", async () => {
  await withTeam({}, async ({ app, store }) => {
    const note = store.createThought({ content: "an idea" });
    // Make the note's triage container exist, as auto triage would.
    assertEquals(store.ensureTriageWorkDef(note.id)?.parent?.kind, "thought");
    const res = await onboarding(app);
    assertEquals(done(res), ["thoughtCaptured"]);
    assertEquals(res.steps.find((s) => s.id === "thoughtCaptured")!.at, note.createdAt);
  });
});

test("a teammate that claimed a run and left still counts as having registered", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("w1", "worker-1", "/tmp");
    const def = store.createWorkDef({ title: "Job", goal: "Do it", acceptanceCriteria: "" });
    store.claimWorkItem(store.getActiveWorkItem(def.id)!.id, "w1");
    store.removeMember("w1");
    assertEquals(done(await onboarding(app)).includes("teammateOnline"), true);
  });
});

test("dismiss hides the card; reopen shows it again until the next dismiss", async () => {
  await withTeam({}, async ({ app, store }) => {
    const dismissed: OnboardingResponse = await (await post(app, "/api/onboarding/dismiss", {})).json();
    assertEquals(dismissed.visible, false);
    assertEquals(typeof dismissed.dismissedAt, "string");
    assertEquals((await onboarding(app)).visible, false);

    const reopened: OnboardingResponse = await (await post(app, "/api/onboarding/reopen", {})).json();
    assertEquals(reopened.visible, true);
    assertEquals(reopened.dismissedAt, null);
    assertEquals(typeof reopened.reopenedAt, "string");

    // Persisted in the settings table, not in memory.
    assertEquals(store.getSetting("onboarding.reopenedAt"), reopened.reopenedAt);

    const again: OnboardingResponse = await (await post(app, "/api/onboarding/dismiss", {})).json();
    assertEquals(again.visible, false);
    assertEquals(again.reopenedAt, null);
  });
});

test(`a team with history (${ONBOARDING_HISTORY_RUNS} finished runs) counts as onboarded unless reopened`, async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("w1", "worker-1", "/tmp");
    for (let i = 0; i < ONBOARDING_HISTORY_RUNS; i++) runOne(store, "w1", `Job ${i}`);
    const res = await onboarding(app);
    assertEquals(res.hasHistory, true);
    assertEquals(res.complete, false);
    assertEquals(res.visible, false);

    await post(app, "/api/onboarding/reopen", {});
    const reopened = await onboarding(app);
    assertEquals(reopened.visible, true);
    assertEquals(done(reopened).includes("firstRunStarted"), true);
  });
});

test("deriveOnboarding: visibility rules", () => {
  const at = "2025-01-01T00:00:00.000Z";
  assertEquals(deriveOnboarding(NO_FACTS, NO_MARKS, null).visible, true);
  assertEquals(deriveOnboarding(NO_FACTS, { ...NO_MARKS, dismissedAt: at }, null).visible, false);
  assertEquals(deriveOnboarding(NO_FACTS, { ...NO_MARKS, completedAt: at }, null).visible, false);
  assertEquals(deriveOnboarding({ ...NO_FACTS, finishedRuns: ONBOARDING_HISTORY_RUNS - 1 }, NO_MARKS, null).visible, true);
  assertEquals(deriveOnboarding({ ...NO_FACTS, finishedRuns: ONBOARDING_HISTORY_RUNS }, NO_MARKS, null).visible, false);
  assertEquals(deriveOnboarding({ ...NO_FACTS, finishedRuns: 9 }, { ...NO_MARKS, completedAt: at, reopenedAt: at }, null).visible, true);
});

test("POST /api/onboarding/sample-task creates and enqueues a Solitary task in the leader's directory", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    store.registerMember("lead", "leader", teamDir);
    const res = await post(app, "/api/onboarding/sample-task", {});
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.success, true);
    const def = store.getWorkDef(body.workDefId)!;
    assertEquals(def.title, "Summarize this project");
    assertEquals(def.parent, undefined);
    assertEquals(def.persona, "builtin:teammate");
    assertEquals(def.pending, undefined);
    assertEquals(typeof def.directory, "string");
    assertEquals(store.getActiveWorkItem(def.id)?.id, body.workItemId);
    assertEquals(store.getActiveWorkItem(def.id)?.state, "READY");
  });
});

test("POST /api/onboarding/sample-task takes the card's edits, and needs a directory without a leader", async () => {
  await withTeam({}, async ({ app, store }) => {
    const refused = await post(app, "/api/onboarding/sample-task", {});
    assertEquals(refused.status, 400);
    assertEquals(store.getWorkDefs().length, 0);

    const res = await post(app, "/api/onboarding/sample-task", { title: "Summarize the API", directory: "/tmp" });
    assertEquals(res.status, 201);
    const def = store.getWorkDef((await res.json()).workDefId)!;
    assertEquals(def.title, "Summarize the API");
    assertEquals(def.goal.startsWith("Read this directory"), true);
  });
});

test("the sample task follows the tasks toggle", async () => {
  await withTeam({ features: { tasks: false } }, async ({ app }) => {
    assertEquals((await onboarding(app)).sampleTask, null);
    const res = await post(app, "/api/onboarding/sample-task", { directory: "/tmp" });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).feature, "tasks");
  });
});
