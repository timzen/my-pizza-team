/**
 * tests/store.test.ts — Verifies the SQLite store: CRUD, the WorkItem queue and
 * its terminal-only lifecycle, directory-affinity matching, WorkDefs, cron, and
 * JSON file sync. See docs/DESIGN.md "The WorkItem".
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { normalizeDirectory, workDefType } from "../shared/types.ts";
import * as path from "node:path";

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
    const store = new Store(teamDir, TEST_CONFIG);
    assertExists(store);
    assertEquals(Deno.statSync(path.join(teamDir, "state.db")).isFile, true);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: creates and retrieves a story", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const res = store.setWorkItemState(item.id, "COMPLETE");
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store2 = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, { ...TEST_CONFIG, agentTimeoutSeconds: 0 });
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
    const store = new Store(teamDir, { ...TEST_CONFIG, agentTimeoutSeconds: 0 });
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
    const store = new Store(teamDir, TEST_CONFIG);
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

/** A real temp dir plus a symlink pointing at it (both realpath'd for stable compares). */
function makeSymlinkedDir(): { real: string; link: string; root: string } {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "mpt-symlink-" }));
  const real = path.join(root, "real-repo");
  Deno.mkdirSync(real);
  const link = path.join(root, "link-repo");
  Deno.symlinkSync(real, link);
  return { real, link, root };
}

Deno.test("normalizeDirectory: a symlink and its target normalize to the same path", () => {
  const { real, link, root } = makeSymlinkedDir();
  try {
    assertEquals(normalizeDirectory(link), real);
    assertEquals(normalizeDirectory(link + "/"), real);
    assertEquals(normalizeDirectory(real), real);
  } finally { cleanupDir(root); }
});

Deno.test("normalizeDirectory: a nonexistent path falls back to string normalization without throwing", () => {
  assertEquals(normalizeDirectory("/definitely/not/here-mpt/"), "/definitely/not/here-mpt");
  const home = Deno.env.get("HOME");
  if (home) {
    assertEquals(normalizeDirectory("~/no-such-mpt-dir-xyz/"), home.replace(/\/+$/, "") + "/no-such-mpt-dir-xyz");
  }
});

for (const [label, agentVia, taskVia] of [
  ["real-path agent, symlink-path task", "real", "link"],
  ["symlink-path agent, real-path task", "link", "real"],
] as const) {
  Deno.test(`Store: tier 1 matches across a symlink (${label})`, () => {
    const teamDir = createTempTeamDir();
    const dirs = makeSymlinkedDir();
    try {
      const store = new Store(teamDir, TEST_CONFIG);
      const agentDir = dirs[agentVia];
      // An unrelated online agent elsewhere must not be offered the item: it
      // belongs to an online teammate (the reservation in tier 3).
      store.registerMember("ag-x", "ag-x", "/repo/x");
      store.registerMember("ag-home", "ag-home", agentDir);
      store.createStory("s1", "S", "D", "open", [], [{ title: "T", description: "d" }], "default", undefined, false, dirs[taskVia]);
      // A no-directory item exists too: tier 1 must beat it for the home agent.
      store.createStory("s2", "S2", "D", "open", [], [{ title: "T2", description: "d" }], "default", undefined, false);

      assertEquals(store.getNextWorkItem({ id: "ag-home", directory: agentDir })!.ref.workDefId, "s1-1");
      assertEquals(store.getNextWorkItem({ id: "ag-x", directory: "/repo/x" })!.ref.workDefId, "s2-1");

      store.close();
    } finally { cleanupDir(teamDir); cleanupDir(dirs.root); }
  });
}

Deno.test("Store: legacy rows holding un-resolved symlink paths still match (compare-time normalization)", () => {
  const teamDir = createTempTeamDir();
  const { real, link, root } = makeSymlinkedDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    store.createStory("sl", "L", "D", "open", [], [{ title: "TL", description: "d" }], "default", undefined, false, real);
    store.registerMember("ag-x", "ag-x", "/repo/x");
    store.registerMember("ag-old", "ag-old", real);
    // Simulate rows written before symlink resolution existed.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare("UPDATE work_items SET directory = ?").run(link);
    db.prepare("UPDATE members SET directory = ? WHERE id = 'ag-old'").run(link);

    // The symlinked member still reserves the item from the unrelated agent…
    assertEquals(store.getNextWorkItem({ id: "ag-x", directory: "/repo/x" }), null);
    // …and an agent polling with the real path wins it in tier 1.
    assertEquals(store.getNextWorkItem({ id: "ag-old", directory: real })!.ref.workDefId, "sl-1");

    store.close();
  } finally { cleanupDir(teamDir); cleanupDir(root); }
});

Deno.test("Store: tier-3 fallback only when no online agent has that directory", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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

Deno.test("Store: scheduler holds a due job when the target host is not ready, then fires once on recovery", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    // An agent on hostA works /repo/a; the scheduled job targets /repo/a.
    store.registerMember("ag-a", "ag-a", "/repo/a", {});
    const sched = store.createSchedule({ title: "Every minute", cron: "* * * * *" });
    store.createWorkDef(
      { title: "Every minute", goal: "g", acceptanceCriteria: "a", directory: "/repo/a", parent: { kind: "schedule", id: sched.id } },
      false,
    );

    // Host reports not-ready (e.g. expired credentials) → the due job is held,
    // not enqueued, and the schedule is flagged so it keeps retrying.
    store.setTeamReadiness(false, "mwinit credentials expired");
    store.runScheduler(new Date());
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 0);
    assertEquals(store.getSchedule(sched.id)!.heldForReadiness, true);

    // Still not ready a tick later (a new minute): still held, no backlog builds.
    store.runScheduler(new Date(Date.now() + 60_000));
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 0);

    // Host recovers → the held job fires exactly once and the flag clears.
    store.setTeamReadiness(true);
    store.runScheduler(new Date(Date.now() + 120_000));
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);
    assertEquals(store.getSchedule(sched.id)!.heldForReadiness, undefined);

    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: scheduler ignores readiness when no agent is connected (waits for connection, as before)", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    const sched = store.createSchedule({ title: "Every minute", cron: "* * * * *" });
    store.createWorkDef(
      { title: "Every minute", goal: "g", acceptanceCriteria: "a", directory: "/repo/a", parent: { kind: "schedule", id: sched.id } },
      false,
    );
    // No members online at all: readiness gating doesn't apply (it's about
    // connected-but-unable hosts, not absent ones) — the item enqueues.
    store.runScheduler(new Date());
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: thoughts lifecycle — create, edit, archive, restore, delete", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    const t = store.createThought({ content: "first idea" });
    assertEquals(t.status, "active");
    assertEquals(t.color, "yellow");
    assertEquals(t.pinned, false);
    assertEquals(store.getThought(t.id)!.content, "first idea");

    const edited = store.updateThought(t.id, { content: "refined idea", pinned: true });
    assertEquals(edited!.content, "refined idea");
    assertEquals(edited!.pinned, true);

    store.archiveThought(t.id);
    assertEquals(store.getThought(t.id)!.status, "archived");
    assertEquals(store.getThoughts("active").length, 0);
    assertEquals(store.getThoughts("archived").length, 1);

    store.restoreThought(t.id);
    assertEquals(store.getThought(t.id)!.status, "active");

    assertEquals(store.deleteThought(t.id), true);
    assertEquals(store.getThought(t.id), null);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: a thought's updatedAt moves only when its content changes", async () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    const t = store.createThought({ content: "idea" });
    const group = store.createThoughtGroup({ title: "G" });
    const tick = () => new Promise((r) => setTimeout(r, 5));

    // Moving, recoloring, pinning, and filing it are not edits: the list view
    // orders by updatedAt, and none of these should reorder it.
    await tick();
    store.updateThoughtPositions([{ id: t.id, x: 500, y: 500 }]);
    store.updateThought(t.id, { color: "blue", pinned: true, groupId: group.id });
    store.updateThought(t.id, { content: "idea" }); // same text: not an edit either
    assertEquals(store.getThought(t.id)!.updatedAt, t.updatedAt);

    await tick();
    const edited = store.updateThought(t.id, { content: "a better idea" })!;
    assert(edited.updatedAt > t.updatedAt, "a content edit bumps updatedAt");
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: thoughts auto-place below existing content and stack z-index", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    const a = store.createThought({ content: "a", x: 0, y: 0, h: 100 });
    const b = store.createThought({ content: "b" });
    assertEquals(a.x === 0 && a.y === 0, true);
    assertEquals(b.y > a.y, true);
    assertEquals(b.zIndex > a.zIndex, true);

    const moved = store.updateThoughtPositions([{ id: a.id, x: 50, y: 60, w: 240, h: 160 }]);
    assertEquals(moved.length, 1);
    const reloaded = store.getThought(a.id)!;
    assertEquals([reloaded.x, reloaded.y, reloaded.w, reloaded.h], [50, 60, 240, 160]);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: thought groups — membership, rename, ungroup clears members", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    const a = store.createThought({ content: "a" });
    const b = store.createThought({ content: "b" });
    const group = store.createThoughtGroup({ title: "Q3 Planning", memberIds: [a.id, b.id] });
    assertEquals(store.getThought(a.id)!.groupId, group.id);
    assertEquals(store.getThought(b.id)!.groupId, group.id);

    assertEquals(store.updateThoughtGroup(group.id, { title: "Q3" })!.title, "Q3");
    assertEquals(store.updateThought(a.id, { groupId: "grp-nope" })!.groupId, null);

    assertEquals(store.deleteThoughtGroup(group.id), true);
    assertEquals(store.getThoughtGroups().length, 0);
    assertEquals(store.getThought(b.id)!.groupId, null);
    assertEquals(store.getThoughts("active").length, 2);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: comments append to JSONL (task ref)", () => {

  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
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
    const store1 = new Store(teamDir, TEST_CONFIG);
    store1.createStory("reload-test", "RT", "Reload", "open", [], [{ title: "T1", description: "D1" }]);
    store1.close();

    const store2 = new Store(teamDir, TEST_CONFIG);
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
    const store = new Store(teamDir, TEST_CONFIG);
    store.createStory("del-test", "DT", "Delete", "open", [], [{ title: "T1", description: "D1" }]);
    const story = store.getStory("del-test");
    assertExists(story);
    const taskId = store.getTasksForStory("del-test")[0]!.id;
    assertEquals(store.deleteStory("del-test"), true);
    assertEquals(store.getStory("del-test"), null);
    // Flat story file and the child task WorkDef dir are both gone.
    const gone = (p: string) => { try { Deno.statSync(p); return false; } catch { return true; } };
    assertEquals(gone(path.join(teamDir, "stories", "del-test.json")), true);
    assertEquals(gone(path.join(teamDir, "tasks", taskId)), true);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: editing a board task via updateWorkDefDetails syncs the tasks cache", () => {
  // A board task is a WorkDef; editing it through the WorkDef path must keep
  // the tasks table (what /api/stories reads) in sync so the board reflects
  // title/goal/context edits without a reload. See TaskDetailPage unification.
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    store.createStory("bt", "Board Task", "S", "open", [], [{ title: "Old Title", description: "old goal" }]);
    const taskId = store.getTasksForStory("bt")[0]!.id;

    const def = store.updateWorkDefDetails(taskId, {
      title: "New Title", goal: "new goal",
      acceptanceCriteria: "- done", additionalContext: "ctx",
      contextRefs: ["conventions"],
    });
    assertExists(def);
    assertEquals(def!.title, "New Title");
    assertEquals(def!.acceptanceCriteria, "- done");

    // The tasks cache (title/description/context) is updated in lockstep.
    const task = store.getTask(taskId)!;
    assertEquals(task.title, "New Title");
    assertEquals(task.description, "new goal");
    assertEquals(task.context, ["conventions"]);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: pending/activate + archive + delete use flat story files (not dirPath)", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    store.createStory("s-a", "A", "desc a", "open", [], [{ title: "T1", description: "d" }], "default", undefined, false);
    store.createStory("s-b", "B", "desc b", "open", [], [{ title: "T1", description: "d" }], "default", undefined, false);

    // Pending s-a: it stays in stories/ (pending is a flag, not a directory),
    // its file records pending, and the OTHER story's file is untouched.
    store.setStoryPending("s-a", true);
    assertEquals(store.getStory("s-a")!.pending, true);
    assertEquals(JSON.parse(Deno.readTextFileSync(path.join(teamDir, "stories", "s-a.json"))).pending, true);
    assertEquals(store.getStory("s-b")!.pending, undefined); // sibling untouched
    assertEquals(Deno.statSync(path.join(teamDir, "stories", "s-b.json")).isFile, true);

    // Activate brings it back; the file drops the flag.
    store.setStoryPending("s-a", false);
    assertEquals(store.getStory("s-a")!.pending, undefined);
    assertEquals(JSON.parse(Deno.readTextFileSync(path.join(teamDir, "stories", "s-a.json"))).pending, undefined);

    // Archive s-b (mark its task done first).
    const bTask = store.getTasksForStory("s-b")[0]!;
    store.moveTask(bTask.id, "done");
    store.archiveStory("s-b");
    assertEquals(store.getStory("s-b"), null);
    assertEquals(store.getArchivedStories().map((s) => s.id), ["s-b"]);
    assertEquals(Deno.statSync(path.join(teamDir, "archived", "s-b.json")).isFile, true);

    // Delete s-a: flat file gone, sibling data intact.
    store.deleteStory("s-a");
    assertEquals(store.getStory("s-a"), null);
    assertEquals(existsSyncTest(path.join(teamDir, "stories", "s-a.json")), false);
    store.close();
  } finally { cleanupDir(teamDir); }
});

function existsSyncTest(p: string): boolean {
  try { Deno.statSync(p); return true; } catch { return false; }
}

Deno.test("Store: setWorkItemState does NOT post a comment (agent owns its comments)", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    store.createStory("nc", "NC", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const item = store.getNextWorkItem({ id: "a1", directory: undefined })!;
    store.claimWorkItem(item.id, "a1");
    // Passing no result — the daemon posts nothing; the agent owns its comments.
    store.setWorkItemState(item.id, "COMPLETE");
    assertEquals(store.getComments("nc-1").length, 0);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: WorkDef archive + restore lifecycle", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    const def = store.createWorkDef({
      title: "Archivable task", goal: "test goal", acceptanceCriteria: "- done",
    }, false);

    // Active by default — appears in default listing.
    assertEquals(store.getWorkDefs().length, 1);
    assertEquals(store.getWorkDefs("active").length, 1);
    assertEquals(store.getWorkDefs("archived").length, 0);

    // Archive it.
    const archived = store.archiveWorkDef(def.id);
    assertExists(archived);
    assertEquals(archived.status, "archived");

    // No longer in active list, but in archived list.
    assertEquals(store.getWorkDefs().length, 1);
    assertEquals(store.getWorkDefs("active").length, 0);
    assertEquals(store.getWorkDefs("archived").length, 1);

    // Restore it.
    const restored = store.restoreWorkDef(def.id);
    assertExists(restored);
    assertEquals(restored.status, "active");
    assertEquals(store.getWorkDefs("active").length, 1);
    assertEquals(store.getWorkDefs("archived").length, 0);

    // Round-trips from disk after archive.
    store.archiveWorkDef(def.id);
    store.loadFromDisk();
    const reloaded = store.getWorkDef(def.id);
    assertExists(reloaded);
    assertEquals(reloaded.status, "archived");

    store.close();
  } finally { cleanupDir(teamDir); }
});

// --- Dependency admission: a story reaching done (or leaving the active set)
// admits the stories that depend on it, with no restart. See docs/DESIGN.md
// "Admission (CONWIP, WIP = 1 per story)".

/** Drive a story's single task to done the way a run does: claim → COMPLETE → review → done. */
function finishOnlyTask(store: Store, taskId: string): void {
  const item = store.getActiveWorkItemForTask(taskId);
  assertExists(item);
  assertEquals(store.claimWorkItem(item.id, "m1"), true);
  assertEquals(store.setWorkItemState(item.id, "COMPLETE").ok, true);
  store.moveTask(taskId, "done");
}

Deno.test("Store: completing a dependency's last task admits its dependent", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    store.registerMember("m1", "swift-ripley", "/tmp/repo");
    store.createStory("dep-a", "A", "A", "open", [], [{ title: "A1", description: "a" }]);
    store.createStory("dep-b", "B", "B", "open", ["dep-a"], [{ title: "B1", description: "b" }]);
    assertEquals(store.getTask("dep-b-1")!.status, "todo");
    assertEquals(store.getActiveWorkItemForTask("dep-b-1"), null);

    finishOnlyTask(store, "dep-a-1");
    assertEquals(store.getStory("dep-a")!.status, "done");
    assertEquals(store.getTask("dep-b-1")!.status, "in_progress");
    const wi = store.getActiveWorkItemForTask("dep-b-1");
    assertExists(wi);
    assertEquals(wi.state, "READY");
    // Idempotent: re-running admission doesn't double-enqueue.
    store.runAdmission("dep-b");
    assertEquals(store.getActiveWorkItemForTask("dep-b-1")!.id, wi.id);
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: archiving or deleting a dependency admits its dependent", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    store.registerMember("m1", "swift-ripley", "/tmp/repo");
    // Archive: A's tasks are done but the story was reopened (so done-admission
    // never fired for B); archiving A is what satisfies B.
    store.createStory("arc-a", "A", "A", "open", [], [{ title: "A1", description: "a" }]);
    store.createStory("arc-b", "B", "B", "open", ["arc-a"], [{ title: "B1", description: "b" }], undefined, undefined, true);
    finishOnlyTask(store, "arc-a-1");
    store.updateStoryDetails("arc-a", { status: "open" });
    store.updateStoryDetails("arc-b", { pending: false });
    assertEquals(store.getTask("arc-b-1")!.status, "todo");
    store.archiveStory("arc-a");
    assertEquals(store.getTask("arc-b-1")!.status, "in_progress");
    assertExists(store.getActiveWorkItemForTask("arc-b-1"));

    // Delete: an open dependency removed from the board stops blocking.
    store.createStory("del-a", "A", "A", "open", [], [{ title: "A1", description: "a" }]);
    store.createStory("del-b", "B", "B", "open", ["del-a"], [{ title: "B1", description: "b" }]);
    assertEquals(store.getTask("del-b-1")!.status, "todo");
    assertEquals(store.deleteStory("del-a"), true);
    assertEquals(store.getTask("del-b-1")!.status, "in_progress");
    assertExists(store.getActiveWorkItemForTask("del-b-1"));
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: a dependent with two dependencies waits for both", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    store.registerMember("m1", "swift-ripley", "/tmp/repo");
    store.createStory("two-a", "A", "A", "open", [], [{ title: "A1", description: "a" }]);
    store.createStory("two-c", "C", "C", "open", [], [{ title: "C1", description: "c" }]);
    store.createStory("two-b", "B", "B", "open", ["two-a", "two-c"], [{ title: "B1", description: "b" }]);

    finishOnlyTask(store, "two-a-1");
    assertEquals(store.getTask("two-b-1")!.status, "todo");
    assertEquals(store.getActiveWorkItemForTask("two-b-1"), null);

    finishOnlyTask(store, "two-c-1");
    assertEquals(store.getTask("two-b-1")!.status, "in_progress");
    assertExists(store.getActiveWorkItemForTask("two-b-1"));
    store.close();
  } finally { cleanupDir(teamDir); }
});

Deno.test("Store: a pending dependent (story or first task) is not admitted when its dependency completes", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, TEST_CONFIG);
    store.registerMember("m1", "swift-ripley", "/tmp/repo");
    store.createStory("hold-a", "A", "A", "open", [], [{ title: "A1", description: "a" }]);
    store.createStory("hold-p", "P", "Pending story", "open", ["hold-a"], [{ title: "P1", description: "p" }], undefined, undefined, true);
    store.createStory("hold-d", "D", "Pending task", "open", ["hold-a"], [{ title: "D1", description: "d", pending: true }]);

    finishOnlyTask(store, "hold-a-1");
    assertEquals(store.getTask("hold-p-1")!.status, "todo");
    assertEquals(store.getActiveWorkItemForTask("hold-p-1"), null);
    assertEquals(store.getTask("hold-d-1")!.status, "todo");
    assertEquals(store.getActiveWorkItemForTask("hold-d-1"), null);

    // Activating then admits it (the existing trigger still works).
    store.updateStoryDetails("hold-p", { pending: false });
    assertEquals(store.getTask("hold-p-1")!.status, "in_progress");
    store.close();
  } finally { cleanupDir(teamDir); }
});
