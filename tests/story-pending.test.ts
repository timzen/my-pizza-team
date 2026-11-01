/**
 * tests/story-pending.test.ts — Pending stories (docs/DESIGN.md "Pending: Write,
 * Review, Activate"): the reversible active ⇄ pending state that replaced story
 * `paused` and the backlog.
 *
 * - Dispatch: a pending story's READY items are never handed out and nothing is
 *   admitted; an IN_PROGRESS task finishes normally; activating resumes.
 * - Dependencies: stories that dependOn a pending story wait (unmet), nothing moves.
 * - API: create/PUT take `pending` (deprecated `paused` alias), POST
 *   /pending and /activate, backlog routes gone.
 *
 * (Pre-0.36.0 `paused` / `backlog/` story files are no longer migrated; such a
 * team is refused at startup — tests/layout-check.test.ts.)
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assertEquals, assertExists } from "./_assert.ts";
import { withTeam, jsonInit, type TeamOptions } from "./_team.ts";
import * as path from "node:path";
import type { WorkflowConfig } from "../shared/types.ts";

/** One agent state: completing it finishes the task (done), admitting the next. */
const SOLO: WorkflowConfig = { states: [{ name: "work", type: "agent" }] };
/** Two agent states: completing `build` enqueues a fresh READY item in `check`. */
const TWO: WorkflowConfig = { states: [{ name: "build", type: "agent" }, { name: "check", type: "agent" }] };

/** Workflows `default` (SOLO) and `two` (TWO), and agent a1 online in /tmp. */
const SOLO_TEAM: TeamOptions = {
  beforeApp: (store) => {
    store.saveWorkflow("default", SOLO);
    store.saveWorkflow("two", TWO);
    store.registerMember("a1", "neo", "/tmp");
  },
};

function readStoryFile(teamDir: string, id: string, dir = "stories"): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(teamDir, dir, `${id}.json`), "utf8"));
}

// ─── Dispatch ───────────────────────────────────────────────────────

test("pending story: READY work is not handed out; activating resumes it", () => {
  return withTeam({}, ({ store }) => {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "T1", description: "d" }], "default");
    const wi = store.getActiveWorkItem("s1-1");
    assertExists(wi);
    assertEquals(wi.state, "READY");

    store.setStoryPending("s1", true);
    assertEquals(store.getStory("s1")!.pending, true);
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" }), null);

    store.setStoryPending("s1", false);
    assertEquals(store.getStory("s1")!.pending, undefined);
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" })?.id, wi.id);
  }, SOLO_TEAM);
});

test("pending story created pending: nothing admitted until activated", () => {
  return withTeam({}, ({ store }) => {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "T1", description: "d" }], "default", true);
    assertEquals(store.getTask("s1-1")!.status, "todo");
    assertEquals(store.getActiveWorkItem("s1-1"), null);
    store.setStoryPending("s1", false);
    assertEquals(store.getTask("s1-1")!.status, "work");
    assertExists(store.getActiveWorkItem("s1-1"));
  }, SOLO_TEAM);
});

test("pending mid-flight: the in-progress task finishes; the next task is not admitted", () => {
  return withTeam({}, ({ store }) => {
    store.createStory("s1", "S1", "d", "open", [], [
      { title: "T1", description: "d" }, { title: "T2", description: "d" },
    ], "default");
    const wi = store.getActiveWorkItem("s1-1")!;
    assertEquals(store.claimWorkItem(wi.id, "a1"), true);

    store.setStoryPending("s1", true);
    // The claimed item is untouched and still completes normally.
    assertEquals(store.getWorkItem(wi.id)!.state, "IN_PROGRESS");
    assertEquals(store.setWorkItemState(wi.id, "COMPLETE").ok, true);
    assertEquals(store.getTask("s1-1")!.status, "done");
    // …but nothing new starts.
    assertEquals(store.getTask("s1-2")!.status, "todo");
    assertEquals(store.getActiveWorkItem("s1-2"), null);

    // Toggling back to active admits and hands out the next task.
    store.setStoryPending("s1", false);
    assertEquals(store.getTask("s1-2")!.status, "work");
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" })?.ref.workDefId, "s1-2");
  }, SOLO_TEAM);
});

test("pending mid-flight: advancing into the next agent state is not handed out", () => {
  return withTeam({}, ({ store }) => {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "T1", description: "d" }], "two");
    const wi = store.getActiveWorkItem("s1-1")!;
    assertEquals(store.claimWorkItem(wi.id, "a1"), true);
    store.setStoryPending("s1", true);
    assertEquals(store.setWorkItemState(wi.id, "COMPLETE").ok, true);
    // Advance still happens (it's the finishing task's own move)…
    assertEquals(store.getTask("s1-1")!.status, "check");
    const next = store.getActiveWorkItem("s1-1");
    assertExists(next);
    // …but its fresh READY item waits for activation.
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" }), null);
    store.setStoryPending("s1", false);
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" })?.id, next.id);
  }, SOLO_TEAM);
});

test("a story depending on a pending story waits; it stays on the board", () => {
  return withTeam({}, ({ store }) => {
    store.createStory("a", "A", "d", "open", [], [{ title: "A1", description: "d" }], "default", true);
    store.createStory("b", "B", "d", "open", ["a"], [{ title: "B1", description: "d" }], "default");
    assertEquals(store.isStoryReady("b"), false);
    assertEquals(store.getTask("b-1")!.status, "todo");
    // Nothing is moved around: b is still an ordinary (active) story.
    assertEquals(store.getStory("b")!.pending, undefined);

    // Activate a and finish it: b is admitted.
    store.setStoryPending("a", false);
    const wi = store.getActiveWorkItem("a-1")!;
    store.claimWorkItem(wi.id, "a1");
    store.setWorkItemState(wi.id, "COMPLETE");
    assertEquals(store.getStory("a")!.status, "done");
    assertEquals(store.getTask("b-1")!.status, "work");
  }, SOLO_TEAM);
});

test("pending survives a restart (stories/<id>.json carries it)", () => {
  return withTeam({}, ({ store, teamDir }) => {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "T1", description: "d" }], "default", true);
    assertEquals(readStoryFile(teamDir, "s1").pending, true);
    store.loadFromDisk();
    assertEquals(store.getStory("s1")!.pending, true);
    assertEquals(store.getActiveWorkItem("s1-1"), null);
  }, SOLO_TEAM);
});

// ─── API ────────────────────────────────────────────────────────────

test("API: create/PUT take pending; POST /pending and /activate toggle it", async () => {
  await withTeam({}, async ({ app, store }) => {
    let res = await app.request("/api/stories", jsonInit("POST", { id: "s1", title: "S", description: "d", workflow: "default", pending: true, tasks: [{ title: "T", description: "d" }] }));
    assertEquals(res.status, 201);
    assertEquals((await res.json()).story.pending, true);
    assertEquals(store.getTask("s1-1")!.status, "todo");

    const listed = (await (await app.request("/api/stories")).json()).stories;
    assertEquals(listed[0].pending, true);

    res = await app.request("/api/stories/s1/activate", jsonInit("POST"));
    assertEquals(await res.json(), { success: true, pending: false });
    assertEquals(store.getStory("s1")!.pending, undefined);
    assertEquals(store.getTask("s1-1")!.status, "work");

    res = await app.request("/api/stories/s1/pending", jsonInit("POST"));
    assertEquals(await res.json(), { success: true, pending: true });
    assertEquals(store.getStory("s1")!.pending, true);

    res = await app.request("/api/stories/s1", jsonInit("PUT", { pending: false }));
    assertEquals((await res.json()).success, true);
    assertEquals(store.getStory("s1")!.pending, undefined);

    // A PUT without pending leaves the state alone.
    store.setStoryPending("s1", true);
    await app.request("/api/stories/s1", jsonInit("PUT", { title: "Renamed" }));
    assertEquals(store.getStory("s1")!.pending, true);

    assertEquals((await app.request("/api/stories/nope/pending", jsonInit("POST"))).status, 404);
    assertEquals((await app.request("/api/stories/nope/activate", jsonInit("POST"))).status, 404);
  }, SOLO_TEAM);
});

test("API: the deprecated `paused` field is accepted as an alias of pending", async () => {
  await withTeam({}, async ({ app, store }) => {
    await app.request("/api/stories", jsonInit("POST", { id: "s1", title: "S", description: "d", workflow: "default", paused: true }));
    assertEquals(store.getStory("s1")!.pending, true);
    await app.request("/api/stories/s1", jsonInit("PUT", { paused: false }));
    assertEquals(store.getStory("s1")!.pending, undefined);
    // Responses only carry `pending`.
    const listed = (await (await app.request("/api/stories")).json()).stories;
    assertEquals("paused" in listed[0], false);
  }, SOLO_TEAM);
});

test("API: the backlog routes are gone", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("s1", "S", "d", "open", [], [], "default");
    assertEquals((await app.request("/api/backlog")).status, 404);
    assertEquals((await app.request("/api/stories/s1/backlog", jsonInit("POST"))).status, 404);
    assertEquals((await app.request("/api/backlog/s1/restore", jsonInit("POST"))).status, 404);
  }, SOLO_TEAM);
});
