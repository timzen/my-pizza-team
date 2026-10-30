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
 * - Migration on load: `paused: true` → pending; `backlog/` → `stories/` as
 *   pending; old fields dropped; idempotent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assertEquals, assertExists } from "./_assert.ts";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { migrateLegacyStoryFiles } from "../daemon/store/story-migration.ts";
import type { TeamConfig, WorkflowConfig } from "../shared/types.ts";

/** One agent state: completing it finishes the task (done), admitting the next. */
const SOLO: WorkflowConfig = { states: [{ name: "work", type: "agent" }] };
/** Two agent states: completing `build` enqueues a fresh READY item in `check`. */
const TWO: WorkflowConfig = { states: [{ name: "build", type: "agent" }, { name: "check", type: "agent" }] };

function setup(workflows: Record<string, WorkflowConfig> = { default: SOLO, two: TWO }) {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-story-pending-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...TEST_CONFIG };
  const store = new Store(teamDir, config);
  for (const [name, wf] of Object.entries(workflows)) store.saveWorkflow(name, wf);
  store.registerMember("a1", "neo", "/tmp");
  const app = buildApp(store, config, teamDir);
  const cleanup = () => {
    store.close();
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* */ }
  };
  return { app, store, teamDir, cleanup };
}

function req(method: string, body?: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) };
}

function readStoryFile(teamDir: string, id: string, dir = "stories"): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(teamDir, dir, `${id}.json`), "utf8"));
}

function writeStoryFile(teamDir: string, dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.join(teamDir, dir), { recursive: true });
  fs.writeFileSync(path.join(teamDir, dir, `${data.id}.json`), JSON.stringify(data, null, 2) + "\n");
}

// ─── Dispatch ───────────────────────────────────────────────────────

test("pending story: READY work is not handed out; activating resumes it", () => {
  const { store, cleanup } = setup();
  try {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "T1", description: "d" }], "default");
    const wi = store.getActiveWorkItemForTask("s1-1");
    assertExists(wi);
    assertEquals(wi.state, "READY");

    store.setStoryPending("s1", true);
    assertEquals(store.getStory("s1")!.pending, true);
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" }), null);

    store.setStoryPending("s1", false);
    assertEquals(store.getStory("s1")!.pending, undefined);
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" })?.id, wi.id);
  } finally { cleanup(); }
});

test("pending story created pending: nothing admitted until activated", () => {
  const { store, cleanup } = setup();
  try {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "T1", description: "d" }], "default", true);
    assertEquals(store.getTask("s1-1")!.status, "todo");
    assertEquals(store.getActiveWorkItemForTask("s1-1"), null);
    store.setStoryPending("s1", false);
    assertEquals(store.getTask("s1-1")!.status, "work");
    assertExists(store.getActiveWorkItemForTask("s1-1"));
  } finally { cleanup(); }
});

test("pending mid-flight: the in-progress task finishes; the next task is not admitted", () => {
  const { store, cleanup } = setup();
  try {
    store.createStory("s1", "S1", "d", "open", [], [
      { title: "T1", description: "d" }, { title: "T2", description: "d" },
    ], "default");
    const wi = store.getActiveWorkItemForTask("s1-1")!;
    assertEquals(store.claimWorkItem(wi.id, "a1"), true);

    store.setStoryPending("s1", true);
    // The claimed item is untouched and still completes normally.
    assertEquals(store.getWorkItem(wi.id)!.state, "IN_PROGRESS");
    assertEquals(store.setWorkItemState(wi.id, "COMPLETE").ok, true);
    assertEquals(store.getTask("s1-1")!.status, "done");
    // …but nothing new starts.
    assertEquals(store.getTask("s1-2")!.status, "todo");
    assertEquals(store.getActiveWorkItemForTask("s1-2"), null);

    // Toggling back to active admits and hands out the next task.
    store.setStoryPending("s1", false);
    assertEquals(store.getTask("s1-2")!.status, "work");
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" })?.ref.workDefId, "s1-2");
  } finally { cleanup(); }
});

test("pending mid-flight: advancing into the next agent state is not handed out", () => {
  const { store, cleanup } = setup();
  try {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "T1", description: "d" }], "two");
    const wi = store.getActiveWorkItemForTask("s1-1")!;
    assertEquals(store.claimWorkItem(wi.id, "a1"), true);
    store.setStoryPending("s1", true);
    assertEquals(store.setWorkItemState(wi.id, "COMPLETE").ok, true);
    // Advance still happens (it's the finishing task's own move)…
    assertEquals(store.getTask("s1-1")!.status, "check");
    const next = store.getActiveWorkItemForTask("s1-1");
    assertExists(next);
    // …but its fresh READY item waits for activation.
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" }), null);
    store.setStoryPending("s1", false);
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp" })?.id, next.id);
  } finally { cleanup(); }
});

test("a story depending on a pending story waits; it stays on the board", () => {
  const { store, cleanup } = setup();
  try {
    store.createStory("a", "A", "d", "open", [], [{ title: "A1", description: "d" }], "default", true);
    store.createStory("b", "B", "d", "open", ["a"], [{ title: "B1", description: "d" }], "default");
    assertEquals(store.isStoryReady("b"), false);
    assertEquals(store.getTask("b-1")!.status, "todo");
    // Nothing is moved around: b is still an ordinary (active) story.
    assertEquals(store.getStory("b")!.pending, undefined);

    // Activate a and finish it: b is admitted.
    store.setStoryPending("a", false);
    const wi = store.getActiveWorkItemForTask("a-1")!;
    store.claimWorkItem(wi.id, "a1");
    store.setWorkItemState(wi.id, "COMPLETE");
    assertEquals(store.getStory("a")!.status, "done");
    assertEquals(store.getTask("b-1")!.status, "work");
  } finally { cleanup(); }
});

test("pending survives a restart (stories/<id>.json carries it)", () => {
  const { store, teamDir, cleanup } = setup();
  try {
    store.createStory("s1", "S1", "d", "open", [], [{ title: "T1", description: "d" }], "default", true);
    assertEquals(readStoryFile(teamDir, "s1").pending, true);
    store.loadFromDisk();
    assertEquals(store.getStory("s1")!.pending, true);
    assertEquals(store.getActiveWorkItemForTask("s1-1"), null);
  } finally { cleanup(); }
});

// ─── API ────────────────────────────────────────────────────────────

test("API: create/PUT take pending; POST /pending and /activate toggle it", async () => {
  const { app, store, cleanup } = setup();
  try {
    let res = await app.request("/api/stories", req("POST", { id: "s1", title: "S", description: "d", workflow: "default", pending: true, tasks: [{ title: "T", description: "d" }] }));
    assertEquals(res.status, 201);
    assertEquals((await res.json()).story.pending, true);
    assertEquals(store.getTask("s1-1")!.status, "todo");

    const listed = (await (await app.request("/api/stories")).json()).stories;
    assertEquals(listed[0].pending, true);

    res = await app.request("/api/stories/s1/activate", req("POST"));
    assertEquals(await res.json(), { success: true, pending: false });
    assertEquals(store.getStory("s1")!.pending, undefined);
    assertEquals(store.getTask("s1-1")!.status, "work");

    res = await app.request("/api/stories/s1/pending", req("POST"));
    assertEquals(await res.json(), { success: true, pending: true });
    assertEquals(store.getStory("s1")!.pending, true);

    res = await app.request("/api/stories/s1", req("PUT", { pending: false }));
    assertEquals((await res.json()).success, true);
    assertEquals(store.getStory("s1")!.pending, undefined);

    // A PUT without pending leaves the state alone.
    store.setStoryPending("s1", true);
    await app.request("/api/stories/s1", req("PUT", { title: "Renamed" }));
    assertEquals(store.getStory("s1")!.pending, true);

    assertEquals((await app.request("/api/stories/nope/pending", req("POST"))).status, 404);
    assertEquals((await app.request("/api/stories/nope/activate", req("POST"))).status, 404);
  } finally { cleanup(); }
});

test("API: the deprecated `paused` field is accepted as an alias of pending", async () => {
  const { app, store, cleanup } = setup();
  try {
    await app.request("/api/stories", req("POST", { id: "s1", title: "S", description: "d", workflow: "default", paused: true }));
    assertEquals(store.getStory("s1")!.pending, true);
    await app.request("/api/stories/s1", req("PUT", { paused: false }));
    assertEquals(store.getStory("s1")!.pending, undefined);
    // Responses only carry `pending`.
    const listed = (await (await app.request("/api/stories")).json()).stories;
    assertEquals("paused" in listed[0], false);
  } finally { cleanup(); }
});

test("API: the backlog routes are gone", async () => {
  const { app, store, cleanup } = setup();
  try {
    store.createStory("s1", "S", "d", "open", [], [], "default");
    assertEquals((await app.request("/api/backlog")).status, 404);
    assertEquals((await app.request("/api/stories/s1/backlog", req("POST"))).status, 404);
    assertEquals((await app.request("/api/backlog/s1/restore", req("POST"))).status, 404);
  } finally { cleanup(); }
});

// ─── Migration ──────────────────────────────────────────────────────

test("migration: paused stories and backlog/ stories load as pending; old fields dropped", () => {
  const { store, teamDir, cleanup } = setup();
  try {
    // A board task for the backlogged story: its WorkDef lives in tasks/ (never moved).
    store.createStory("shelved", "Shelved", "d", "open", [], [{ title: "T", description: "d" }], "default");
    const shelved = readStoryFile(teamDir, "shelved");
    fs.rmSync(path.join(teamDir, "stories", "shelved.json"));
    writeStoryFile(teamDir, "backlog", { ...shelved, backloggedAt: "2026-01-01T00:00:00.000Z" });

    writeStoryFile(teamDir, "stories", { id: "held", title: "Held", description: "d", status: "open", dependsOn: [], tasks: [], paused: true });
    writeStoryFile(teamDir, "stories", { id: "running", title: "Running", description: "d", status: "open", dependsOn: [], tasks: [], paused: false });

    store.loadFromDisk();

    assertEquals(store.getStory("held")!.pending, true);
    assertEquals(store.getStory("running")!.pending, undefined);
    assertEquals(store.getStory("shelved")!.pending, true);
    assertEquals(store.getTasksForStory("shelved").map((t) => t.id), ["shelved-1"]);

    const held = readStoryFile(teamDir, "held");
    assertEquals(held.pending, true);
    assertEquals("paused" in held, false);
    assertEquals("paused" in readStoryFile(teamDir, "running"), false);
    assertEquals("pending" in readStoryFile(teamDir, "running"), false);
    const moved = readStoryFile(teamDir, "shelved");
    assertEquals(moved.pending, true);
    assertEquals("backloggedAt" in moved, false);
    assertEquals(existsSync(path.join(teamDir, "backlog")), false);
  } finally { cleanup(); }
});

test("migration: idempotent, and never clobbers an active story with a backlog copy", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-story-migration-test-"));
  try {
    writeStoryFile(teamDir, "stories", { id: "dup", title: "Live", description: "d", status: "open", dependsOn: [], tasks: [] });
    writeStoryFile(teamDir, "backlog", { id: "dup", title: "Old copy", description: "d", status: "open", dependsOn: [], tasks: [], backloggedAt: "x" });
    writeStoryFile(teamDir, "stories", { id: "p", title: "P", description: "d", status: "open", dependsOn: [], tasks: [], paused: true });

    const first = migrateLegacyStoryFiles(teamDir);
    assertEquals(first.rewritten, ["p"]);
    assertEquals(first.unbacklogged, []);
    assertEquals(first.conflicts, ["dup"]);
    assertEquals(readStoryFile(teamDir, "dup").title, "Live");
    assertEquals(existsSync(path.join(teamDir, "backlog", "dup.json")), true);

    const second = migrateLegacyStoryFiles(teamDir);
    assertEquals(second.rewritten, []);
    assertEquals(second.unbacklogged, []);
    assertEquals(readStoryFile(teamDir, "p").pending, true);
  } finally {
    fs.rmSync(teamDir, { recursive: true, force: true });
  }
});
