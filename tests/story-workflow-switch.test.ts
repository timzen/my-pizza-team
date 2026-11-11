/**
 * tests/story-workflow-switch.test.ts — Changing a story's workflow after it's
 * created (PUT /api/stories/:id `workflow`, `Store.updateStoryDetails`).
 *
 * - An unknown name is refused (400, create's message); "" / null clear the
 *   override back to the team default.
 * - A switch is refused (409, naming the task and state) when an in-flight task
 *   — one outside the implicit todo/done buckets — sits in a state the new
 *   workflow lacks; not-started and finished tasks never block, and a state
 *   both workflows declare is fine (docs/DESIGN.md "The Work Model").
 */

import { test } from "node:test";
import { assertEquals, assert } from "./_assert.ts";
import { withTeam, put, type TeamOptions } from "./_team.ts";
import { StoryUpdateError } from "../daemon/store.ts";
import type { WorkflowConfig } from "../shared/types.ts";

/** `default`: build → review; `shared`: build → ship; `other`: just ship. */
const DEFAULT: WorkflowConfig = { states: [{ name: "build", type: "teammate" }, { name: "review", type: "manual" }] };
const SHARED: WorkflowConfig = { states: [{ name: "build", type: "teammate" }, { name: "ship", type: "teammate" }] };
const OTHER: WorkflowConfig = { states: [{ name: "ship", type: "teammate" }] };

const TEAM: TeamOptions = {
  beforeApp: (store) => {
    store.saveWorkflow("default", DEFAULT);
    store.saveWorkflow("shared", SHARED);
    store.saveWorkflow("other", OTHER);
    store.reloadWorkflows();
  },
};

/** A pending story (so admission moves nothing) with two tasks, both in todo. */
function seed(store: Parameters<Parameters<typeof withTeam>[1]>[0]["store"], workflow = "default"): void {
  store.createStory("s1", "S1", "d", "open", [], [{ title: "First", description: "d" }, { title: "Second", description: "d" }], workflow, true);
}

test("workflow switch: an unknown name is refused with create's message", () => {
  return withTeam({}, async ({ app, store }) => {
    seed(store);
    const res = await put(app, "/api/stories/s1", { workflow: "nope" });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "Workflow 'nope' not found");
    assertEquals(store.getStory("s1")!.workflow, "default");
    let thrown: unknown;
    try { store.updateStoryDetails("s1", { workflow: "nope" }); } catch (e) { thrown = e; }
    assert(thrown instanceof StoryUpdateError && thrown.status === 400);
  }, TEAM);
});

test("workflow switch: \"\" and null clear the override to the team default", () => {
  return withTeam({}, async ({ app, store }) => {
    seed(store, "other");
    assertEquals((await put(app, "/api/stories/s1", { workflow: "" })).status, 200);
    assertEquals(store.getStory("s1")!.workflow, undefined);
    store.updateStoryDetails("s1", { workflow: "other" });
    assertEquals((await put(app, "/api/stories/s1", { workflow: null })).status, 200);
    assertEquals(store.getStory("s1")!.workflow, undefined);
  }, TEAM);
});

test("workflow switch: allowed when no task is in flight (todo and done never block)", () => {
  return withTeam({}, async ({ app, store }) => {
    seed(store);
    store.updateTaskStatus("s1-1", "done");
    const res = await put(app, "/api/stories/s1", { workflow: "other" });
    assertEquals(res.status, 200);
    assertEquals(store.getStory("s1")!.workflow, "other");
  }, TEAM);
});

test("workflow switch: allowed when the in-flight state exists in both workflows", () => {
  return withTeam({}, async ({ app, store }) => {
    seed(store);
    store.updateTaskStatus("s1-1", "build");
    const res = await put(app, "/api/stories/s1", { workflow: "shared" });
    assertEquals(res.status, 200);
    assertEquals(store.getStory("s1")!.workflow, "shared");
    assertEquals(store.getTask("s1-1")!.status, "build");
  }, TEAM);
});

test("workflow switch: refused (409) when an in-flight state is missing, naming the task and state", () => {
  return withTeam({}, async ({ app, store }) => {
    seed(store);
    store.updateTaskStatus("s1-1", "review");
    const res = await put(app, "/api/stories/s1", { workflow: "shared", title: "Renamed" });
    assertEquals(res.status, 409);
    const { error } = await res.json() as { error: string };
    assert(error.includes("'First' (s1-1) in 'review'"), error);
    assert(!error.includes("s1-2"), error);
    // Nothing is written: neither the workflow nor the other fields in the request.
    assertEquals(store.getStory("s1")!.workflow, "default");
    assertEquals(store.getStory("s1")!.title, "S1");
    // Clearing to the default (whose states include 'review') is checked too, and allowed here.
    store.updateStoryDetails("s1", { workflow: null });
    assertEquals(store.getStory("s1")!.workflow, undefined);
    // A no-op edit without `workflow` never runs the check.
    assertEquals(store.updateStoryDetails("s1", { title: "X" }), true);
  }, TEAM);
});
