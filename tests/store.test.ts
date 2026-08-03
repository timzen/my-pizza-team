/**
 * tests/store.test.ts — Verifies the SQLite store: CRUD, the WorkItem queue and
 * its terminal-only lifecycle, directory-affinity matching, WorkDefs, cron, and
 * JSON file sync. See docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md.
 */

import { assertEquals, assertExists } from "@std/assert";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, workDefType } from "../shared/types.ts";
import * as path from "@std/path";

function createTempTeamDir(): string {
  const dir = Deno.makeTempDirSync({ prefix: "mpt-store-test-" });
  Deno.mkdirSync(path.join(dir, "stories"), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try { Deno.removeSync(dir, { recursive: true }); } catch { /* ignore */ }
}

Deno.test("Store: creates database and initializes schema", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    assertExists(store);
    assertEquals(Deno.statSync(path.join(teamDir, "state.db")).isFile, true);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: creates and retrieves a story", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    const { story } = store.createStory("test-story-1", "Test Story", "A test story", "open", [], [{ title: "Task One", description: "Do something" }]);
    assertEquals(story.id, "test-story-1");
    const retrieved = store.getStory("test-story-1");
    assertExists(retrieved);
    assertEquals(retrieved.status, "open");
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: admission places the first task and enqueues a READY WorkItem", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("story-tasks", "Story with Tasks", "Testing task creation", "open", [], [
      { title: "First Task", description: "First" },
      { title: "Second Task", description: "Second" },
    ]);

    const retrieved = store.getTasksForStory("story-tasks");
    // CONWIP: the first task is admitted into the first agent state; the second waits in todo.
    assertEquals(retrieved[0]!.status, "in_progress");
    assertEquals(retrieved[1]!.status, "todo");

    // A READY WorkItem exists for the admitted task only.
    const wi = store.getActiveWorkItemForTask("story-tasks-1");
    assertExists(wi);
    assertEquals(wi.state, "READY");
    assertEquals(store.getActiveWorkItemForTask("story-tasks-2"), null);
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: WorkItem drives the task (claim -> COMPLETE advances + admits next)", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.registerMember("m1", "swift-ripley", "/tmp/repo");
    store.createStory("drive", "Drive", "D", "open", [], [
      { title: "T1", description: "D1" },
      { title: "T2", description: "D2" },
    ]);

    const item = store.getNextWorkItem({ id: "m1", directory: "/tmp/repo" });
    assertExists(item);
    assertEquals(item.ref.workDefId, "drive-1");

    assertEquals(store.claimWorkItem(item.id, "m1"), true);
    assertEquals(store.getWorkItem(item.id)!.state, "IN_PROGRESS");
    // Double claim fails.
    assertEquals(store.claimWorkItem(item.id, "m2"), false);

    // COMPLETE advances the task to the next (manual) state; frees no new agent work here.
    const res = store.setWorkItemState(item.id, "COMPLETE", "done it");
    assertEquals(res.ok, true);
    assertEquals(store.getWorkItem(item.id)!.state, "COMPLETE");
    assertEquals(store.getTask("drive-1")!.status, "review");

    // Moving the review task to done frees the CONWIP token → T2 is admitted.
    store.moveTask("drive-1", "done");
    assertEquals(store.getTask("drive-2")!.status, "in_progress");
    assertExists(store.getActiveWorkItemForTask("drive-2"));

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: boot clears stale members/assignments and orphans IN_PROGRESS to MORIBUND", () => {
  const teamDir = createTempTeamDir();
  try {
    // First run: a member claims a task (IN_PROGRESS + assignment row).
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.registerMember("m1", "swift-ripley", "/tmp/repo");
    store.createStory("boot", "Boot", "B", "open", [], [{ title: "T1", description: "D1" }]);
    const item = store.getNextWorkItem({ id: "m1", directory: "/tmp/repo" });
    assertExists(item);
    assertEquals(store.claimWorkItem(item.id, "m1"), true);
    assertEquals(store.getWorkItem(item.id)!.state, "IN_PROGRESS");
    assertExists(store.getActiveWorkItemForTask("boot-1"));
    store.close();

    // Second run (daemon restart): a fresh Store on the same dir has no live
    // connections, so members/assignments are cleared and the in-flight item
    // is moved to MORIBUND (its member_id kept).
    const store2 = new Store(teamDir, DEFAULT_CONFIG);
    assertEquals(store2.getMembers().length, 0);
    const wi = store2.getWorkItem(item.id)!;
    assertEquals(wi.state, "MORIBUND");
    assertEquals(wi.memberId, "m1");
    // The same agent can still complete its MORIBUND item after reconnecting.
    assertEquals(store2.setWorkItemState(item.id, "COMPLETE").ok, true);
    store2.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: FAILED leaves the task stuck; re-enqueue creates a fresh item", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.registerMember("m1", "m1", "/tmp/repo");
    store.createStory("fail", "Fail", "D", "open", [], [{ title: "T1", description: "D1" }]);

    const item = store.getNextWorkItem({ id: "m1" })!;
    store.claimWorkItem(item.id, "m1");
    store.setWorkItemState(item.id, "FAILED");

    // Terminal, and the task stays put with no active WorkItem.
    assertEquals(store.getWorkItem(item.id)!.state, "FAILED");
    assertEquals(store.getTask("fail-1")!.status, "in_progress");
    assertEquals(store.getActiveWorkItemForTask("fail-1"), null);

    // Re-enqueue creates a new READY item (a fresh attempt, not a re-open).
    const fresh = store.reEnqueueRef({ workDefId: "fail-1" });
    assertExists(fresh);
    assertEquals(fresh.state, "READY");
    assertEquals(fresh.id !== item.id, true);
    // No double re-enqueue while one is active.
    assertEquals(store.reEnqueueRef({ workDefId: "fail-1" }), null);

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: reap -> MORIBUND, heartbeat restores it", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, { ...DEFAULT_CONFIG, agentTimeoutSeconds: 0 });
    store.registerMember("m1", "m1", "/tmp/repo");
    store.createStory("reap", "Reap", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const item = store.getNextWorkItem({ id: "m1" })!;
    store.claimWorkItem(item.id, "m1");

    // Timeout 0 → the reaper marks m1 offline and its in-flight item MORIBUND.
    store.reapOfflineAgents();
    assertEquals(store.getWorkItem(item.id)!.state, "MORIBUND");
    assertEquals(store.getMember("m1")!.status, "offline");

    // The agent comes back → its MORIBUND item is restored to IN_PROGRESS.
    store.heartbeat("m1", "working");
    assertEquals(store.getWorkItem(item.id)!.state, "IN_PROGRESS");

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: force-fail a moribund item, optionally re-enqueue", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, { ...DEFAULT_CONFIG, agentTimeoutSeconds: 0 });
    store.registerMember("m1", "m1", "/tmp/repo");
    store.createStory("ff", "FF", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const item = store.getNextWorkItem({ id: "m1" })!;
    store.claimWorkItem(item.id, "m1");
    store.reapOfflineAgents();

    const res = store.forceFailWorkItem(item.id, true);
    assertEquals(res.ok, true);
    assertEquals(store.getWorkItem(item.id)!.state, "FAILED");
    assertExists(res.newItem);
    assertEquals(res.newItem!.state, "READY");

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: directory-affinity matching (tiers + presence reservation)", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    // Story A -> /repo/a ; Story B -> /repo/b ; Story C -> no directory.
    store.createStory("sa", "A", "D", "open", [], [{ title: "TA", description: "d" }], "default", undefined, false, "/repo/a");
    store.createStory("sb", "B", "D", "open", [], [{ title: "TB", description: "d" }], "default", undefined, false, "/repo/b");
    store.createStory("sc", "C", "D", "open", [], [{ title: "TC", description: "d" }], "default", undefined, false);

    // Agent in /repo/a is registered online (reserves B's work from A? no — reserves A's).
    store.registerMember("ag-b", "ag-b", "/repo/b");

    // An agent in /repo/a: tier 1 is its own dir (A). It should get A.
    const forA = store.getNextWorkItem({ id: "ag-a", directory: "/repo/a" });
    assertEquals(forA!.ref.workDefId, "sa-1");

    // An agent in /repo/x: no tier-1; tier-2 is the no-directory story C. B is
    // reserved (an online /repo/b agent exists), A is reserved only if an online
    // agent has /repo/a — none does, but C (no dir) wins tier 2 first.
    const forX = store.getNextWorkItem({ id: "ag-x", directory: "/repo/x" });
    assertEquals(forX!.ref.workDefId, "sc-1");

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: tier-3 fallback only when no online agent has that directory", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("sb", "B", "D", "open", [], [{ title: "TB", description: "d" }], "default", undefined, false, "/repo/b");

    // No online agent in /repo/b → an agent elsewhere may take it (tier 3).
    const taken = store.getNextWorkItem({ id: "ag-x", directory: "/repo/x" });
    assertEquals(taken!.ref.workDefId, "sb-1");

    // But if a /repo/b agent is online, the item is reserved for it.
    store.registerMember("ag-b", "ag-b", "/repo/b");
    assertEquals(store.getNextWorkItem({ id: "ag-x", directory: "/repo/x" }), null);
    assertExists(store.getNextWorkItem({ id: "ag-b", directory: "/repo/b" }));

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: WorkDef create + enqueue + prompt-able", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    const def = store.createWorkDef({
      title: "Daily summary", goal: "Write a summary", acceptanceCriteria: "- MUST cover today",
      directory: "/repo/a",
    }, true);
    assertEquals(workDefType(def.parent), "Solitary");

    // Enqueued a READY WorkItem referencing the def, with the def's directory.
    const { items } = store.getWorkItems({ states: ["READY"] });
    assertEquals(items.length, 1);
    assertEquals(items[0]!.ref.workDefId, def.id);
    assertEquals(items[0]!.directory, "/repo/a");

    // Round-trips from disk (markdown).
    store.loadFromDisk();
    const reloaded = store.getWorkDef(def.id);
    assertExists(reloaded);
    assertEquals(reloaded.goal, "Write a summary");
    assertEquals(reloaded.acceptanceCriteria, "- MUST cover today");

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: scheduled WorkDef is enqueued when its cron is due", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    // Scheduled work: a cron Schedule parent owns the WorkDef.
    const sched = store.createSchedule({ title: "Every minute", cron: "* * * * *" });
    store.createWorkDef({ title: "Every minute", goal: "g", acceptanceCriteria: "a", parent: { kind: "schedule", id: sched.id } }, false);
    // Not enqueued on creation (Scheduled).
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 0);

    store.runScheduler(new Date());
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);
    // Running again in the same minute does not double-enqueue.
    store.runScheduler(new Date());
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: comments append to JSONL (task ref)", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("msg-test", "MT", "Comments", "open", [], [{ title: "T1", description: "D1" }]);
    store.addComment("msg-test-1", "teammate-1", "Hello, lead!");
    store.addComment("msg-test-1", "lead", "Hi there!");
    const comments = store.getComments("msg-test-1");
    assertEquals(comments.length, 2);
    assertEquals(comments[0]!.from, "teammate-1");
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: members CRUD (directory only)", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.registerMember("m1", "swift-ripley", "/tmp/repo");
    const members = store.getMembers();
    assertEquals(members.length, 1);
    assertEquals(members[0]!.name, "swift-ripley");
    assertEquals(members[0]!.directory, "/tmp/repo");
    store.removeMember("m1");
    assertEquals(store.getMembers().length, 0);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: judgment move validation + rework re-enqueues", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("wf-test", "WF", "Workflow test", "open", [], [{ title: "T1", description: "D1" }]);

    const r1 = store.moveTask("wf-test-1", "review");
    assertEquals(r1.ok, true);
    assertEquals(store.getTask("wf-test-1")!.status, "review");
    // review is manual → no active WorkItem.
    assertEquals(store.getActiveWorkItemForTask("wf-test-1"), null);

    assertEquals(store.moveTask("wf-test-1", "nonsense").ok, false);

    // Rework: move back into the agent state → a fresh READY WorkItem.
    assertEquals(store.moveTask("wf-test-1", "in_progress").ok, true);
    assertEquals(store.getActiveWorkItemForTask("wf-test-1")!.state, "READY");

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: reorders tasks and persists new sequence", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("reorder-story", "Reorder", "Testing reorder", "open", [], [
      { title: "Alpha", description: "A" }, { title: "Beta", description: "B" }, { title: "Gamma", description: "C" },
    ]);
    assertEquals(store.reorderTasks("reorder-story", ["reorder-story-3", "reorder-story-1", "reorder-story-2"]), true);
    const after = store.getTasksForStory("reorder-story");
    assertEquals(after.map(t => t.title), ["Gamma", "Alpha", "Beta"]);
    assertEquals(store.reorderTasks("reorder-story", ["reorder-story-1"]), false);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: story auto-completes when all tasks done", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("auto-done", "AD", "AutoDone", "open", [], [{ title: "T1", description: "D1" }]);
    store.updateTaskStatus("auto-done-1", "review");
    store.updateTaskStatus("auto-done-1", "done");
    assertEquals(store.getStory("auto-done")!.status, "done");
    store.moveTask("auto-done-1", "in_progress");
    assertEquals(store.getStory("auto-done")!.status, "open");
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: loadFromDisk rebuilds the queue for agent-state tasks", () => {
  const teamDir = createTempTeamDir();
  try {
    const store1 = new Store(teamDir, DEFAULT_CONFIG);
    store1.createStory("reload-test", "RT", "Reload", "open", [], [{ title: "T1", description: "D1" }]);
    store1.close();

    const store2 = new Store(teamDir, DEFAULT_CONFIG);
    store2.loadFromDisk();
    assertEquals(store2.getStory("reload-test")!.title, "RT");
    // The admitted task's READY WorkItem is rebuilt on load.
    const wi = store2.getActiveWorkItemForTask("reload-test-1");
    assertExists(wi);
    assertEquals(wi.state, "READY");
    store2.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: delete story removes from DB and disk", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("del-test", "DT", "Delete", "open", [], [{ title: "T1", description: "D1" }]);
    const story = store.getStory("del-test");
    assertExists(story);
    assertEquals(store.deleteStory("del-test"), true);
    assertEquals(store.getStory("del-test"), null);
    const exists = (() => { try { Deno.statSync(story.dirPath); return true; } catch { return false; } })();
    assertEquals(exists, false);
    store.close();
  } finally { cleanupDir(teamDir); }
});
