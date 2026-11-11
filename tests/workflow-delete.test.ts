/**
 * tests/workflow-delete.test.ts — Deleting a workflow (DELETE /api/workflows/:name,
 * `Store.deleteWorkflow`) and the usage the delete dialog reads
 * (GET /api/workflows/:name/usage).
 *
 * - An unused workflow's folder moves to `workflows/.deleted/<name>-<timestamp>/`
 *   (a backup) and it leaves the list; `loadWorkflows` skips the backup folder.
 * - Refused (409): the team's default, the last workflow, one an open story uses
 *   (those stories listed). 404 for an unknown name.
 * - Done stories don't block, and afterwards resolve to the default workflow.
 * - `PUT /api/config` refuses a workflow named `.deleted` (the backup folder).
 */

import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertEquals, assert } from "./_assert.ts";
import { withTeam, del, get, put, type TeamOptions } from "./_team.ts";
import { WorkflowDeleteError, DELETED_WORKFLOWS_DIR } from "../daemon/store.ts";
import type { WorkflowConfig } from "../shared/types.ts";
import type { DeleteWorkflowResponse, WorkflowUsageResponse } from "../shared/protocol.ts";

const DEFAULT: WorkflowConfig = { states: [{ name: "build", type: "teammate" }, { name: "review", type: "manual" }] };
const SPARE: WorkflowConfig = { states: [{ name: "ship", type: "teammate" }] };

/** `default` (the team default) and `spare`. */
const TEAM: TeamOptions = {
  beforeApp: (store) => {
    store.saveWorkflow("default", DEFAULT);
    store.saveWorkflow("spare", SPARE);
    store.reloadWorkflows();
  },
};

test("workflow delete: an unused workflow moves to the backup folder and leaves the list", () => {
  return withTeam({}, async ({ app, store, teamDir }) => {
    const res = await del(app, "/api/workflows/spare");
    assertEquals(res.status, 200);
    const body = await res.json() as DeleteWorkflowResponse;
    assertEquals(body.success, true);
    const backup = body.backup!;
    assert(backup.startsWith(path.join("workflows", DELETED_WORKFLOWS_DIR, "spare-")), backup);
    // The folder moved, contents intact; the original is gone.
    assertEquals(JSON.parse(fs.readFileSync(path.join(teamDir, backup, "workflow.json"), "utf8")), SPARE);
    assert(!fs.existsSync(path.join(teamDir, "workflows", "spare")));
    assertEquals(Object.keys(store.getWorkflows()), ["default"]);
    const list = await (await get(app, "/api/workflows")).json() as Array<{ name: string }>;
    assertEquals(list.map((w) => w.name), ["default"]);
    // A reload from disk skips workflows/.deleted/ (no workflow.json at its top level).
    store.reloadWorkflows();
    assertEquals(Object.keys(store.getWorkflows()), ["default"]);
  }, TEAM);
});

test("workflow delete: an unknown name is 404", () => {
  return withTeam({}, async ({ app }) => {
    const res = await del(app, "/api/workflows/nope");
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error, "Workflow 'nope' not found");
    assertEquals((await get(app, "/api/workflows/nope/usage")).status, 404);
  }, TEAM);
});

test("workflow delete: the team's default workflow is refused (409)", () => {
  return withTeam({}, async ({ app, store, teamDir }) => {
    const res = await del(app, "/api/workflows/default");
    assertEquals(res.status, 409);
    const { error } = await res.json() as { error: string };
    assert(error.includes("default workflow"), error);
    assert(fs.existsSync(path.join(teamDir, "workflows", "default", "workflow.json")));
    assertEquals(Object.keys(store.getWorkflows()).sort(), ["default", "spare"]);
  }, TEAM);
});

test("workflow delete: the last workflow left is refused (409)", () => {
  // The default is "only", so the default check can't be what refuses "solo".
  const solo: TeamOptions = { beforeApp: (store) => { store.saveWorkflow("solo", SPARE); store.reloadWorkflows(); } };
  return withTeam({ defaultWorkflow: "elsewhere" }, async ({ app, store, teamDir }) => {
    assertEquals(Object.keys(store.getWorkflows()), ["solo"]);
    const res = await del(app, "/api/workflows/solo");
    assertEquals(res.status, 409);
    const { error } = await res.json() as { error: string };
    assert(error.includes("only workflow left"), error);
    assert(fs.existsSync(path.join(teamDir, "workflows", "solo", "workflow.json")));
  }, solo);
});

test("workflow delete: refused (409) while an open story uses it, listing the stories", () => {
  return withTeam({}, async ({ app, store, teamDir }) => {
    store.createStory("s1", "Open one", "d", "open", [], [], "spare", true);
    store.createStory("s2", "Open two", "d", "open", [], [], "spare", false);
    store.createStory("s3", "Finished", "d", "done", [], [], "spare", false);
    store.createStory("s4", "Other", "d", "open", [], [], "default", false);
    const usage = await (await get(app, "/api/workflows/spare/usage")).json() as WorkflowUsageResponse;
    assertEquals(usage.openStories.map((s) => s.id), ["s1", "s2"]);
    assertEquals(usage.doneStories.map((s) => s.id), ["s3"]);

    const res = await del(app, "/api/workflows/spare");
    assertEquals(res.status, 409);
    const body = await res.json() as DeleteWorkflowResponse;
    assert(body.error!.includes("'Open one' (s1)") && body.error!.includes("'Open two' (s2)"), body.error);
    assert(!body.error!.includes("s3") && !body.error!.includes("s4"), body.error);
    assertEquals(body.openStories, [{ id: "s1", title: "Open one" }, { id: "s2", title: "Open two" }]);
    assert(fs.existsSync(path.join(teamDir, "workflows", "spare", "workflow.json")));
    // The store throws the same refusal for any caller.
    let thrown: unknown;
    try { store.deleteWorkflow("spare"); } catch (e) { thrown = e; }
    assert(thrown instanceof WorkflowDeleteError && thrown.status === 409 && thrown.openStories.length === 2);
  }, TEAM);
});

test("workflow delete: used only by done (or archived) stories is allowed; they resolve to the default", () => {
  return withTeam({}, async ({ app, store }) => {
    store.createStory("s1", "Finished", "d", "done", [], [], "spare", false);
    store.createStory("s2", "Shelved", "d", "open", [], [{ title: "T", description: "d" }], "spare", true);
    store.updateTaskStatus("s2-1", "done");
    store.archiveStory("s2");
    assertEquals(store.getWorkflowUsage("spare").openStories, []);
    assertEquals(store.getWorkflowForStory("s1"), SPARE);
    const res = await del(app, "/api/workflows/spare");
    assertEquals(res.status, 200);
    // The story keeps its (now stale) override and falls back to the default.
    assertEquals(store.getStory("s1")!.workflow, "spare");
    assertEquals(store.getWorkflowForStory("s1"), DEFAULT);
  }, TEAM);
});

test("workflow delete: PUT /api/config refuses a workflow named like the backup folder", () => {
  return withTeam({}, async ({ app, store, teamDir }) => {
    const res = await put(app, "/api/config", { defaultWorkflow: "default", workflows: { default: DEFAULT, [DELETED_WORKFLOWS_DIR]: SPARE } });
    assertEquals(res.status, 400);
    assert(String((await res.json()).error).includes("reserved"));
    assert(!fs.existsSync(path.join(teamDir, "workflows", DELETED_WORKFLOWS_DIR, "workflow.json")));
    assertEquals(Object.keys(store.getWorkflows()).sort(), ["default", "spare"]);
  }, TEAM);
});
