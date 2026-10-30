/**
 * tests/features.test.ts — Feature toggles for Stories, Tasks, and Schedules.
 *
 * Covers the config model (`resolveFeatures` defaults, the new-team config), the
 * daemon's gate (daemon/features.ts: 403 on a disabled kind's routes, everything
 * else untouched), and the turn-off guard on `PUT /api/config` (refused while
 * active items exist, allowed once they're archived). Also proves the toggles
 * are registry-driven: a fake toggleable Work Source gets the same gate and guard.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { initTeamConfig } from "../cli/setup.ts";
import { DEFAULT_CONFIG, NEW_TEAM_FEATURES, newTeamConfig, resolveFeatures, type FeaturesConfig, type TeamConfig } from "../shared/types.ts";
import * as path from "node:path";
import { TASK_SOURCE_ID } from "../daemon/sources/registry.ts";
import type { WorkSource } from "../daemon/sources/types.ts";

function setup(features?: FeaturesConfig) {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-features-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), ...(features ? { features } : {}) };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  const cleanup = () => { store.close(); try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ } };
  return { app, store, config, teamDir, cleanup };
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const post = (body: unknown) => ({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });

/** A PUT /api/config body that changes only `features`. */
function configBody(config: TeamConfig, features: unknown) {
  return { defaultWorkflow: config.defaultWorkflow, workflows: config.workflows, features };
}

// ─── Config model ────────────────────────────────────────────────────

test("resolveFeatures: missing block or flag means on", () => {
  assertEquals(resolveFeatures({}), { stories: true, tasks: true, schedules: true });
  assertEquals(resolveFeatures({ features: {} }), { stories: true, tasks: true, schedules: true });
  assertEquals(resolveFeatures({ features: { stories: false } }), { stories: false, tasks: true, schedules: true });
  assertEquals(resolveFeatures({ features: { stories: false, tasks: false, schedules: false } }), { stories: false, tasks: false, schedules: false });
});

test("DEFAULT_CONFIG has no features block (existing teams stay all-on)", () => {
  assertEquals("features" in DEFAULT_CONFIG, false);
  assertEquals(resolveFeatures(DEFAULT_CONFIG), { stories: true, tasks: true, schedules: true });
});

test("a new team starts with Tasks only", () => {
  assertEquals(NEW_TEAM_FEATURES, { tasks: true, stories: false, schedules: false });
  assertEquals(newTeamConfig().features, NEW_TEAM_FEATURES);
  const teamDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mpt-features-init-")), ".my-pizza-team");
  try {
    assertEquals(initTeamConfig(teamDir), true);
    const written = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as TeamConfig;
    assertEquals(written.features, { tasks: true, stories: false, schedules: false });
    // Never overwrites an existing config (which, without the key, means all-on).
    fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({ port: 1 }));
    assertEquals(initTeamConfig(teamDir), false);
    assertEquals(JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")), { port: 1 });
  } finally { fs.rmSync(path.dirname(teamDir), { recursive: true, force: true }); }
});

// ─── Exposure ────────────────────────────────────────────────────────

test("/api/status and GET /api/config expose resolved features", async () => {
  const all = setup();
  try {
    assertEquals((await (await all.app.request("/api/status")).json()).features, { stories: true, tasks: true, schedules: true });
    assertEquals((await (await all.app.request("/api/config")).json()).features, { stories: true, tasks: true, schedules: true });
  } finally { all.cleanup(); }
  const some = setup({ stories: false });
  try {
    assertEquals((await (await some.app.request("/api/status")).json()).features, { stories: false, tasks: true, schedules: true });
    assertEquals((await (await some.app.request("/api/config")).json()).features, { stories: false, tasks: true, schedules: true });
  } finally { some.cleanup(); }
});

// ─── Route gating ────────────────────────────────────────────────────

async function assertDisabled(res: Response, feature: string) {
  assertEquals(res.status, 403);
  assertEquals(await res.json(), { success: false, error: `feature '${feature}' is disabled`, feature });
}

test("all on (no features key): every kind's routes work", async () => {
  const { app, cleanup } = setup();
  try {
    assertEquals((await app.request("/api/stories")).status, 200);
    assertEquals((await app.request("/api/stories", post({ id: "s1", title: "S", description: "d", workflow: "default" }))).status, 201);
    assertEquals((await app.request("/api/templates")).status, 200);
    assertEquals((await app.request("/api/schedules")).status, 200);
    assertEquals((await app.request("/api/work-defs", post({ title: "T", goal: "g", enqueue: false }))).status, 201);
    assertEquals((await app.request("/api/work-defs", post({ title: "C", goal: "g", type: "Scheduled", cron: "0 9 * * *" }))).status, 201);
  } finally { cleanup(); }
});

test("stories off: story, board-task, pending and archive routes refuse", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    store.createStory("s1", "S", "d", "open", [], [{ title: "t", description: "d" }]);
    const boardTask = store.getTasksForStory("s1")[0]!.id;
    // Off is set directly (the guard is tested below).
    config.features = { stories: false };
    await assertDisabled(await app.request("/api/stories"), "stories");
    await assertDisabled(await app.request("/api/stories", post({ id: "s2", title: "S", description: "d", workflow: "default" })), "stories");
    await assertDisabled(await app.request("/api/stories/s1", put({ title: "x" })), "stories");
    await assertDisabled(await app.request("/api/stories/s1/tasks", post({ title: "t", description: "d" })), "stories");
    await assertDisabled(await app.request(`/api/tasks/${boardTask}/move`, post({ position: "done" })), "stories");
    await assertDisabled(await app.request("/api/stories/s1/pending", post({})), "stories");
    await assertDisabled(await app.request("/api/stories/s1/activate", post({})), "stories");
    await assertDisabled(await app.request("/api/archived"), "stories");
    // A board WorkDef through the generic routes is a story's too…
    await assertDisabled(await app.request(`/api/work-defs/${boardTask}`), "stories");
    // …but its thread stays readable (Inbox, viewers, agents).
    assertEquals((await app.request(`/api/work-defs/${boardTask}/comments`)).status, 200);
    // The other kinds are unaffected.
    assertEquals((await app.request("/api/templates")).status, 200);
    assertEquals((await app.request("/api/work-defs", post({ title: "T", goal: "g", enqueue: false }))).status, 201);
  } finally { cleanup(); }
});

test("tasks off: Solitary WorkDef and template routes refuse; the list hides them", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    const solo = store.createWorkDef({ title: "Solo", goal: "g", acceptanceCriteria: "" }, false);
    const sched = store.createSchedule({ title: "C", cron: "0 9 * * *" });
    const cron = store.createWorkDef({ title: "Cron", goal: "g", acceptanceCriteria: "", parent: { kind: "schedule", id: sched.id } }, false);
    store.createTemplate({ title: "Mold", goal: "g", acceptanceCriteria: "" });
    config.features = { tasks: false };
    await assertDisabled(await app.request("/api/work-defs", post({ title: "T", goal: "g" })), "tasks");
    await assertDisabled(await app.request(`/api/work-defs/${solo.id}`), "tasks");
    await assertDisabled(await app.request(`/api/work-defs/${solo.id}`, put({ title: "x" })), "tasks");
    await assertDisabled(await app.request(`/api/work-defs/${solo.id}/enqueue`, { method: "POST" }), "tasks");
    await assertDisabled(await app.request(`/api/work-defs/${solo.id}/archive`, { method: "POST" }), "tasks");
    await assertDisabled(await app.request(`/api/work-defs/${solo.id}`, { method: "DELETE" }), "tasks");
    await assertDisabled(await app.request("/api/templates"), "tasks");
    await assertDisabled(await app.request("/api/templates", post({ title: "T" })), "tasks");
    await assertDisabled(await app.request("/api/templates/mold"), "tasks");
    const list = await (await app.request("/api/work-defs?status=all")).json() as { workDefs: Array<{ id: string }> };
    assertEquals(list.workDefs.map((d) => d.id), [cron.id]);
    // Scheduled work is still reachable, and so is the Solitary def's thread.
    assertEquals((await app.request(`/api/work-defs/${cron.id}`)).status, 200);
    assertEquals((await app.request(`/api/work-defs/${solo.id}/comment`, post({ from: "you", body: "hi" }))).status, 200);
  } finally { cleanup(); }
});

test("schedules off: schedule routes and Scheduled WorkDefs refuse", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    const sched = store.createSchedule({ title: "C", cron: "0 9 * * *" });
    const cron = store.createWorkDef({ title: "Cron", goal: "g", acceptanceCriteria: "", parent: { kind: "schedule", id: sched.id } }, false);
    config.features = { schedules: false };
    await assertDisabled(await app.request("/api/schedules"), "schedules");
    await assertDisabled(await app.request(`/api/schedules/${sched.id}`, put({ cron: "0 10 * * *" })), "schedules");
    await assertDisabled(await app.request("/api/work-defs", post({ title: "C2", goal: "g", type: "Scheduled", cron: "0 9 * * *" })), "schedules");
    await assertDisabled(await app.request(`/api/work-defs/${cron.id}`), "schedules");
    // Solitary creation still works (the gate read the body; the route could too).
    const res = await app.request("/api/work-defs", post({ title: "Solo", goal: "g", enqueue: false }));
    assertEquals(res.status, 201);
    assertEquals((await res.json()).workDef.title, "Solo");
  } finally { cleanup(); }
});

test("all off: Thoughts, Personas, Inbox and the queue still work", async () => {
  const { app, config, cleanup } = setup({ stories: false, tasks: false, schedules: false });
  try {
    assertEquals(config.features, { stories: false, tasks: false, schedules: false });
    assertEquals((await app.request("/api/thoughts")).status, 200);
    assertEquals((await app.request("/api/personas")).status, 200);
    assertEquals((await app.request("/api/work-items")).status, 200);
    assertEquals((await app.request("/api/status")).status, 200);
    assertEquals((await app.request("/api/work-defs")).status, 200);
  } finally { cleanup(); }
});

test("an existing item of a disabled kind still runs to completion", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    const def = store.createWorkDef({ title: "Solo", goal: "g", acceptanceCriteria: "" });
    const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === def.id)!;
    config.features = { tasks: false };
    store.registerMember("a1", "swift-neo", "/tmp");
    const claim = await app.request(`/api/agents/claim/${item.id}`, post({ agentId: "a1" }));
    assertEquals(claim.status, 200);
    assertEquals((await app.request(`/api/agents/comments/${item.id}`, post({ agentId: "a1", body: "done" }))).status, 200);
    const done = await app.request(`/api/agents/work-items/${item.id}/state`, post({ agentId: "a1", state: "COMPLETE" }));
    assertEquals(done.status, 200);
    assertEquals(store.getWorkItem(item.id)?.state, "COMPLETE");
  } finally { cleanup(); }
});

test("accepting a triage proposal needs its kind to be on", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    const note = store.createThought({ content: "an idea" });
    store.runTriageSweep(Date.now() + 60 * 60 * 1000);
    const res = store.addTriageAnalysis(note.id, "swift-neo", "Here's what I think.", "proposals", [
      { id: "p1", kind: "task", title: "Do it", goal: "g" },
      { id: "p2", kind: "story", title: "Big thing", goal: "g", tasks: [{ title: "First", goal: "g" }] },
    ]);
    assertEquals(res.ok, true, (res as { error?: string }).error);
    config.features = { stories: false };
    await assertDisabled(await app.request(`/api/thoughts/${note.id}/proposals/p2/accept`, post({})), "stories");
    assertEquals((await app.request(`/api/thoughts/${note.id}/proposals/p1/accept`, post({}))).status, 200);
  } finally { cleanup(); }
});

// ─── Turning a feature off ───────────────────────────────────────────

test("turning stories off is refused while active stories exist, allowed once archived", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "t", description: "d" }]);
    store.createStory("s2", "S2", "d", "open", [], [{ title: "t", description: "d" }]);
    let res = await app.request("/api/config", put(configBody(config, { stories: false })));
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "archive or delete 2 stories first");
    assertEquals(resolveFeatures(config).stories, true); // nothing changed

    for (const id of ["s1", "s2"]) {
      for (const t of store.getTasksForStory(id)) store.updateTaskStatus(t.id, "done");
      store.archiveStory(id);
    }
    res = await app.request("/api/config", put(configBody(config, { stories: false })));
    assertEquals(res.status, 200);
    assertEquals(config.features, { stories: false, tasks: true, schedules: true });
    // Persisted in full.
    const onDisk = JSON.parse(fs.readFileSync(path.join(store["teamDir"], "config.json"), "utf8")) as TeamConfig;
    assertEquals(onDisk.features, { stories: false, tasks: true, schedules: true });
  } finally { cleanup(); }
});

test("GET /api/config reports each kind's active items (featureUsage)", async () => {
  const { app, store, cleanup } = setup();
  try {
    let usage = (await (await app.request("/api/config")).json()).featureUsage;
    assertEquals(usage.stories, { count: 0, description: "0 stories" });
    assertEquals(usage.tasks.count, 0);
    assertEquals(usage.schedules.count, 0);
    store.createStory("s1", "S1", "d", "open", [], [{ title: "t", description: "d" }]);
    usage = (await (await app.request("/api/config")).json()).featureUsage;
    assertEquals(usage.stories, { count: 1, description: "1 story" });
  } finally { cleanup(); }
});

test("pending stories block turning stories off", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "t", description: "d" }]);
    store.setStoryPending("s1", true);
    const res = await app.request("/api/config", put(configBody(config, { stories: false })));
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "1 story first");
  } finally { cleanup(); }
});

test("turning tasks off counts Solitary tasks and templates; archived tasks don't block", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    const solo = store.createWorkDef({ title: "Solo", goal: "g", acceptanceCriteria: "" }, false);
    store.createTemplate({ title: "Mold", goal: "g", acceptanceCriteria: "" });
    // Board and Scheduled WorkDefs aren't Tasks.
    store.createStory("s1", "S1", "d", "open", [], [{ title: "t", description: "d" }]);
    let res = await app.request("/api/config", put(configBody(config, { tasks: false })));
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "archive or delete 1 task and 1 template first");

    store.archiveWorkDef(solo.id);
    res = await app.request("/api/config", put(configBody(config, { tasks: false })));
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "1 template first");

    store.deleteTemplate("mold");
    res = await app.request("/api/config", put(configBody(config, { tasks: false })));
    assertEquals(res.status, 200);
    assertEquals(resolveFeatures(config).tasks, false);
  } finally { cleanup(); }
});

test("turning schedules off is refused while an active Scheduled task exists", async () => {
  const { app, store, config, cleanup } = setup();
  try {
    const sched = store.createSchedule({ title: "C", cron: "0 9 * * *" });
    const cron = store.createWorkDef({ title: "Cron", goal: "g", acceptanceCriteria: "", parent: { kind: "schedule", id: sched.id } }, false);
    let res = await app.request("/api/config", put(configBody(config, { schedules: false })));
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "1 scheduled task first");
    store.archiveWorkDef(cron.id);
    res = await app.request("/api/config", put(configBody(config, { schedules: false })));
    assertEquals(res.status, 200);
  } finally { cleanup(); }
});

test("features validation: types, unknown keys, null, and turning on", async () => {
  const { app, store, config, cleanup } = setup({ stories: false, tasks: true, schedules: false });
  try {
    assertEquals((await app.request("/api/config", put(configBody(config, "yes")))).status, 400);
    assertEquals((await app.request("/api/config", put(configBody(config, { stories: "no" })))).status, 400);
    const unknown = await app.request("/api/config", put(configBody(config, { thoughts: false })));
    assertEquals(unknown.status, 400);
    assertStringIncludes((await unknown.json()).error, "Unknown feature");
    // Turning on is never blocked; a partial update keeps the other flags.
    assertEquals((await app.request("/api/config", put(configBody(config, { schedules: true })))).status, 200);
    assertEquals(config.features, { stories: false, tasks: true, schedules: true });
    // Leaving an already-off kind off isn't refused, even with items on disk.
    store.createStory("s1", "S1", "d");
    assertEquals((await app.request("/api/config", put(configBody(config, { stories: false })))).status, 200);
    // Omitting `features` keeps it.
    assertEquals((await app.request("/api/config", put(configBody(config, undefined)))).status, 200);
    assertEquals(config.features, { stories: false, tasks: true, schedules: true });
    // null clears the block: everything on, nothing persisted.
    assertEquals((await app.request("/api/config", put(configBody(config, null)))).status, 200);
    assertEquals(config.features, undefined);
    const onDisk = JSON.parse(fs.readFileSync(path.join(store["teamDir"], "config.json"), "utf8")) as TeamConfig;
    assertEquals("features" in onDisk, false);
  } finally { cleanup(); }
});

// ─── A toggleable Work Source (plugin-style) ──────────────────────────

/**
 * A fake toggleable source standing in for the parent-less ("task") kind under
 * its own feature name, with an extra route and a controllable active count —
 * the registry alone must give it the 403 gate, list hiding, exposure, and the
 * turn-off guard. Registered before `buildApp`, as a startup plugin would be.
 */
function setupFixtureSource(activeCount: () => number | null) {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-features-source-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = structuredClone(TEST_CONFIG);
  const store = new Store(teamDir, config);
  store.unregisterWorkSource(TASK_SOURCE_ID);
  const source: WorkSource = {
    id: TASK_SOURCE_ID,
    apiVersion: 1,
    toggle: {
      feature: "fixture",
      routes: ["/api/fixture", "/api/fixture/*"],
      // null → fall back to the default (the source's non-archived WorkDefs).
      ...(activeCount() === null ? {} : { activeItems: () => ({ count: activeCount()!, description: `${activeCount()} fixture items` }) }),
    },
  };
  store.registerWorkSource(source);
  const app = buildApp(store, config, teamDir);
  const cleanup = () => { store.close(); try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ } };
  return { app, store, config, cleanup };
}

test("a toggleable source gets the gate, list hiding, and exposure from the registry", async () => {
  const { app, store, config, cleanup } = setupFixtureSource(() => 0);
  try {
    const def = store.createWorkDef({ title: "Mine", goal: "g", acceptanceCriteria: "" }, false);
    const status = (await (await app.request("/api/status")).json()).features;
    assertEquals(status, { stories: true, schedules: true, fixture: true });
    assertEquals((await (await app.request("/api/config")).json()).featureUsage.fixture, { count: 0, description: "0 fixture items" });
    assertEquals((await app.request(`/api/work-defs/${def.id}`)).status, 200);

    config.features = { fixture: false } as FeaturesConfig;
    assertEquals((await (await app.request("/api/status")).json()).features.fixture, false);
    await assertDisabled(await app.request("/api/fixture/anything"), "fixture");
    await assertDisabled(await app.request(`/api/work-defs/${def.id}`), "fixture");
    await assertDisabled(await app.request("/api/work-defs", post({ title: "T", goal: "g" })), "fixture");
    const list = await (await app.request("/api/work-defs?status=all")).json() as { workDefs: Array<{ id: string }> };
    assertEquals(list.workDefs.length, 0);
    // The thread stays open, and other kinds are untouched.
    assertEquals((await app.request(`/api/work-defs/${def.id}/comments`)).status, 200);
    assertEquals((await app.request("/api/stories")).status, 200);
  } finally { cleanup(); }
});

test("a toggleable source's activeItems guards switching it off", async () => {
  let active = 2;
  const { app, config, cleanup } = setupFixtureSource(() => active);
  try {
    let res = await app.request("/api/config", put(configBody(config, { fixture: false })));
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "Can't turn off fixture: archive or delete 2 fixture items first");
    active = 0;
    res = await app.request("/api/config", put(configBody(config, { fixture: false })));
    assertEquals(res.status, 200);
    assertEquals(config.features as Record<string, boolean>, { stories: true, schedules: true, fixture: false });
    // The built-in "tasks" source is gone, so its key is now unknown.
    const unknown = await app.request("/api/config", put(configBody(config, { tasks: false })));
    assertEquals(unknown.status, 400);
    assertStringIncludes((await unknown.json()).error, "known: stories, schedules, fixture");
  } finally { cleanup(); }
});

test("a toggleable source without activeItems counts its non-archived WorkDefs", async () => {
  const { app, store, config, cleanup } = setupFixtureSource(() => null);
  try {
    const def = store.createWorkDef({ title: "Mine", goal: "g", acceptanceCriteria: "" }, false);
    let res = await app.request("/api/config", put(configBody(config, { fixture: false })));
    assertEquals(res.status, 409);
    assertStringIncludes((await res.json()).error, "1 item first");
    store.archiveWorkDef(def.id);
    res = await app.request("/api/config", put(configBody(config, { fixture: false })));
    assertEquals(res.status, 200);
  } finally { cleanup(); }
});
