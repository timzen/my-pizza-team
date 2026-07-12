/**
 * tests/store.test.ts — Verifies the SQLite store CRUD operations,
 * workflow loading, migrations, and JSON file sync.
 */

import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import type { TeamConfig } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";

/** Create a temporary team directory with required structure */
function createTempTeamDir(): string {
  const dir = Deno.makeTempDirSync({ prefix: "mpt-store-test-" });
  Deno.mkdirSync(path.join(dir, "stories"), { recursive: true });
  return dir;
}

/** Clean up a temp team directory */
function cleanupDir(dir: string): void {
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

Deno.test("Store: creates database and initializes schema", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    assertExists(store);
    // DB file should exist
    const stat = Deno.statSync(path.join(teamDir, "state.db"));
    assertEquals(stat.isFile, true);
    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: creates and retrieves a story", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    const { story } = store.createStory(
      "test-story-1",
      "Test Story",
      "A test story",
      "open",
      [],
      [{ title: "Task One", description: "Do something" }]
    );
    assertEquals(story.id, "test-story-1");
    assertEquals(story.title, "Test Story");

    const retrieved = store.getStory("test-story-1");
    assertExists(retrieved);
    assertEquals(retrieved.title, "Test Story");
    assertEquals(retrieved.status, "open");

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: creates tasks with correct initial status", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    const { tasks } = store.createStory(
      "story-tasks",
      "Story with Tasks",
      "Testing task creation",
      "open",
      [],
      [
        { title: "First Task", description: "First" },
        { title: "Second Task", description: "Second" },
      ]
    );
    assertEquals(tasks.length, 2);
    assertEquals(tasks[0]!.status, "todo");
    assertEquals(tasks[0]!.seq, 1);
    assertEquals(tasks[1]!.seq, 2);

    const retrieved = store.getTasksForStory("story-tasks");
    assertEquals(retrieved.length, 2);

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: updates task status and marks dirty", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("s1", "S1", "Desc", "open", [], [
      { title: "T1", description: "D1" },
    ]);

    store.updateTaskStatus("s1-1", "in_progress");
    const task = store.getTask("s1-1");
    assertExists(task);
    assertEquals(task.status, "in_progress");

    // Flush should write to disk
    store.flushToDisk();

    const taskFile = path.join(task.dirPath, "task.json");
    const onDisk = JSON.parse(Deno.readTextFileSync(taskFile));
    assertEquals(onDisk.status, "in_progress");

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: workflow transition validation", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("wf-test", "WF", "Workflow test", "open", [], [
      { title: "T1", description: "D1" },
    ]);

    // todo -> in_progress is allowed for anyone
    const r1 = store.canTransition("wf-test-1", "in_progress", "teammate");
    assertEquals(r1.ok, true);

    // todo -> done is NOT allowed (no direct transition)
    const r2 = store.canTransition("wf-test-1", "done", "teammate");
    assertEquals(r2.ok, false);

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: members CRUD", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.registerMember("m1", "swift-ripley", { directory: "/tmp" }, {});

    const members = store.getMembers();
    assertEquals(members.length, 1);
    assertEquals(members[0]!.name, "swift-ripley");

    store.removeMember("m1");
    assertEquals(store.getMembers().length, 0);

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: claim and release task assignment", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("assign-test", "AT", "Assignment", "open", [], [
      { title: "T1", description: "D1" },
    ]);

    const claimed = store.claimTask("assign-test-1", "m1");
    assertEquals(claimed, true);

    // Can't double-claim
    const claimedAgain = store.claimTask("assign-test-1", "m2");
    assertEquals(claimedAgain, false);

    const assignment = store.getAssignment("assign-test-1");
    assertExists(assignment);
    assertEquals(assignment.memberId, "m1");

    store.releaseTask("assign-test-1");
    assertEquals(store.getAssignment("assign-test-1"), null);

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: comments append to JSONL", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("msg-test", "MT", "Comments", "open", [], [
      { title: "T1", description: "D1" },
    ]);

    store.addComment("msg-test-1", "teammate-1", "Hello, lead!");
    store.addComment("msg-test-1", "lead", "Hi there!");

    const comments = store.getComments("msg-test-1");
    assertEquals(comments.length, 2);
    assertEquals(comments[0]!.from, "teammate-1");
    assertEquals(comments[1]!.from, "lead");

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: loadFromDisk reloads stories and tasks", () => {
  const teamDir = createTempTeamDir();
  try {
    // Create with one store instance
    const store1 = new Store(teamDir, DEFAULT_CONFIG);
    store1.createStory("reload-test", "RT", "Reload", "open", [], [
      { title: "T1", description: "D1" },
    ]);
    store1.close();

    // Open new store and load from disk
    const store2 = new Store(teamDir, DEFAULT_CONFIG);
    store2.loadFromDisk();
    const story = store2.getStory("reload-test");
    assertExists(story);
    assertEquals(story.title, "RT");

    const tasks = store2.getTasksForStory("reload-test");
    assertEquals(tasks.length, 1);
    store2.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: story auto-completes when all tasks done", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("auto-done", "AD", "AutoDone", "open", [], [
      { title: "T1", description: "D1" },
    ]);

    store.updateTaskStatus("auto-done-1", "in_progress");
    store.updateTaskStatus("auto-done-1", "review");
    store.updateTaskStatus("auto-done-1", "done");

    const story = store.getStory("auto-done");
    assertExists(story);
    assertEquals(story.status, "done");

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Store: delete story removes from DB and disk", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.createStory("del-test", "DT", "Delete", "open", [], [
      { title: "T1", description: "D1" },
    ]);

    const story = store.getStory("del-test");
    assertExists(story);

    const deleted = store.deleteStory("del-test");
    assertEquals(deleted, true);
    assertEquals(store.getStory("del-test"), null);

    // Directory should be gone
    const exists = (() => { try { Deno.statSync(story.dirPath); return true; } catch { return false; } })();
    assertEquals(exists, false);

    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});
