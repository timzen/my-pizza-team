/**
 * tests/story-archive.test.ts — Stories archive in place (docs/ARCHITECTURE.md
 * "Team directory"): an archived story stays in `stories/<id>.json` with
 * `archivedAt` + `synopsis` set, like tasks and thoughts archive with a flag.
 *
 * - archiveStory writes the flag in place (no `archived/` dir).
 * - loadFromDisk skips archived stories and their tasks; dependents treat an
 *   archived dependency as done.
 * - The archived list / context and the archive + /api/archived routes still work.
 * - The regular story routes refuse an archived story (404 / 409 on its id).
 * - Migration: legacy `archived/<id>.json` moves into `stories/`, idempotent,
 *   and a conflicting id is left in place and reported.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertExists } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { migrateLegacyStoryFiles } from "../daemon/store/story-migration.ts";

function tempTeamDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-story-archive-test-"));
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  return dir;
}

function readJson(teamDir: string, rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(teamDir, rel), "utf8"));
}

function writeJson(teamDir: string, rel: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(path.join(teamDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(teamDir, rel), JSON.stringify(data, null, 2) + "\n");
}

function req(method: string, body?: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) };
}

/** Create a one-task story and finish it (moved to done) so it's archivable. */
function doneStory(store: Store, id: string, dependsOn: string[] = []): void {
  store.createStory(id, `Story ${id}`, "desc", "open", dependsOn, [{ title: "T1", description: "d" }]);
  store.moveTask(`${id}-1`, "done");
}

test("archiveStory: archives in place (archivedAt + synopsis in stories/<id>.json)", () => {
  const teamDir = tempTeamDir();
  const store = new Store(teamDir, TEST_CONFIG);
  try {
    doneStory(store, "arc");
    store.archiveStory("arc");

    const data = readJson(teamDir, "stories/arc.json");
    assertEquals(typeof data.archivedAt, "string");
    assertEquals(String(data.synopsis).includes("Story arc"), true);
    assertEquals((data.tasks as Array<{ id: string }>).map((t) => t.id), ["arc-1"]);
    assertEquals(existsSync(path.join(teamDir, "archived")), false);
    // Out of the active cache; the task WorkDef stays on disk.
    assertEquals(store.getStory("arc"), null);
    assertEquals(store.getTask("arc-1"), null);
    assertExists(store.getWorkDef("arc-1"));
    assertEquals(store.isStoryArchived("arc"), true);
    // Archived list + context read it back from stories/.
    assertEquals(store.getArchivedStories(), [{ id: "arc", title: "Story arc", synopsis: data.synopsis as string }]);
    const ctx = store.getArchivedStoryContext("arc")!;
    assertEquals(ctx.story.archivedAt, data.archivedAt);
    assertEquals(ctx.tasks.map((t) => t.id), ["arc-1"]);
    // An active story isn't archived.
    store.createStory("live", "Live", "d", "open", [], [{ title: "T", description: "d" }]);
    assertEquals(store.getArchivedStoryContext("live"), null);
    assertEquals(store.getArchivedStories().map((s) => s.id), ["arc"]);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("loadFromDisk: skips archived stories and their tasks; dependents treat them as done", () => {
  const teamDir = tempTeamDir();
  const first = new Store(teamDir, TEST_CONFIG);
  doneStory(first, "base");
  first.archiveStory("base");
  first.close();

  // A dependent written by hand, waiting on the archived story.
  writeJson(teamDir, "stories/dep.json", { id: "dep", title: "Dep", description: "d", status: "open", dependsOn: ["base"], tasks: [] });
  fs.rmSync(path.join(teamDir, "state.db"), { force: true });

  const store = new Store(teamDir, TEST_CONFIG);
  try {
    store.loadFromDisk();
    assertEquals(store.getStories().map((s) => s.id), ["dep"]);
    assertEquals(store.getStory("base"), null);
    assertEquals(store.getTask("base-1"), null);
    assertEquals(store.isStoryReady("dep"), true);
    // Adding a task to the dependent admits it: the archived dependency is done.
    store.addTask("dep", { title: "D1", description: "d" });
    assertEquals(store.getTask("dep-1")!.status, "in_progress");
    assertEquals(store.getArchivedStories().map((s) => s.id), ["base"]);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("loadFromDisk: a stale cache row for an archived story is dropped", () => {
  const teamDir = tempTeamDir();
  const store = new Store(teamDir, TEST_CONFIG);
  try {
    doneStory(store, "stale");
    // Flag it archived by hand while the cache still holds it.
    const data = readJson(teamDir, "stories/stale.json");
    writeJson(teamDir, "stories/stale.json", { ...data, archivedAt: "2026-01-01T00:00:00.000Z", synopsis: "s" });
    store.loadFromDisk();
    assertEquals(store.getStory("stale"), null);
    assertEquals(store.getTask("stale-1"), null);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("routes: archive + /api/archived keep their shapes; archived stories reject edits", async () => {
  const teamDir = tempTeamDir();
  const store = new Store(teamDir, TEST_CONFIG);
  const app = buildApp(store, TEST_CONFIG, teamDir);
  try {
    doneStory(store, "old");
    const res = await app.request("/api/stories/old/archive", req("POST", {}));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(String(body.synopsis).includes("Story old"), true);

    const list = await (await app.request("/api/archived")).json();
    assertEquals(list.stories.length, 1);
    assertEquals(list.stories[0].id, "old");
    assertEquals(list.stories[0].title, "Story old");
    assertEquals(list.stories[0].synopsis, body.synopsis);
    assertEquals(list.stories[0].archivedAt, readJson(teamDir, "stories/old.json").archivedAt);

    // The regular story routes see no such (active) story.
    assertEquals((await app.request("/api/stories/old", req("PUT", { title: "X" }))).status, 404);
    assertEquals((await app.request("/api/stories/old/tasks", req("POST", { title: "T", description: "d" }))).status, 404);
    assertEquals((await app.request("/api/stories/old/pending", req("POST"))).status, 404);
    assertEquals((await app.request("/api/stories/old/archive", req("POST", {}))).status, 404);
    assertEquals((await app.request("/api/stories/old", req("DELETE"))).status, 404);
    const stories = await (await app.request("/api/stories")).json();
    assertEquals(stories.stories.some((s: { id: string }) => s.id === "old"), false);
    // Its id can't be reused (would clobber the archived file and its tasks).
    const create = await app.request("/api/stories", req("POST", { id: "old", title: "New", description: "d", workflow: "default" }));
    assertEquals(create.status, 409);
    assertEquals(store.addTask("old", { title: "T", description: "d" }), null);
    assertEquals(store.updateStoryDetails("old", { title: "X" }), false);
    // The file is untouched.
    const file = readJson(teamDir, "stories/old.json");
    assertEquals(file.title, "Story old");
    assertEquals((file.tasks as unknown[]).length, 1);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: archived/<id>.json moves into stories/ (still archived), idempotent", () => {
  const teamDir = tempTeamDir();
  try {
    writeJson(teamDir, "archived/legacy.json", {
      id: "legacy", title: "Legacy", description: "d", status: "done", dependsOn: [],
      tasks: [{ id: "legacy-1", status: "done" }], archivedAt: "2025-06-01T00:00:00.000Z", synopsis: "# Legacy",
    });
    const first = migrateLegacyStoryFiles(teamDir);
    assertEquals(first.unarchivedDir, ["legacy"]);
    assertEquals(first.conflicts, []);
    const moved = readJson(teamDir, "stories/legacy.json");
    assertEquals(moved.archivedAt, "2025-06-01T00:00:00.000Z");
    assertEquals(moved.synopsis, "# Legacy");
    assertEquals(existsSync(path.join(teamDir, "archived")), false);

    const second = migrateLegacyStoryFiles(teamDir);
    assertEquals(second, { rewritten: [], unbacklogged: [], unarchivedDir: [], conflicts: [] });
    assertEquals(readJson(teamDir, "stories/legacy.json"), moved);

    // Through the store: not on the board, but in the archived list.
    const store = new Store(teamDir, TEST_CONFIG);
    try {
      store.loadFromDisk();
      assertEquals(store.getStory("legacy"), null);
      assertEquals(store.getArchivedStories(), [{ id: "legacy", title: "Legacy", synopsis: "# Legacy" }]);
      assertEquals(store.getArchivedStoryContext("legacy")!.story.archivedAt, "2025-06-01T00:00:00.000Z");
    } finally { store.close(); }
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: an archived/ file whose id is already in stories/ is left in place and reported", () => {
  const teamDir = tempTeamDir();
  try {
    writeJson(teamDir, "stories/dup.json", { id: "dup", title: "Live", description: "d", status: "open", dependsOn: [], tasks: [] });
    writeJson(teamDir, "archived/dup.json", { id: "dup", title: "Old", description: "d", status: "done", dependsOn: [], tasks: [], archivedAt: "x", synopsis: "s" });
    writeJson(teamDir, "archived/ok.json", { id: "ok", title: "Ok", description: "d", status: "done", dependsOn: [], tasks: [], archivedAt: "y", synopsis: "s" });

    const first = migrateLegacyStoryFiles(teamDir);
    assertEquals(first.unarchivedDir, ["ok"]);
    assertEquals(first.conflicts, ["dup"]);
    assertEquals(readJson(teamDir, "stories/dup.json").title, "Live");
    assertEquals(readJson(teamDir, "archived/dup.json").title, "Old");
    assertEquals(existsSync(path.join(teamDir, "archived", "ok.json")), false);

    // Still reported, nothing else changes.
    const second = migrateLegacyStoryFiles(teamDir);
    assertEquals(second.unarchivedDir, []);
    assertEquals(second.conflicts, ["dup"]);
    assertEquals(existsSync(path.join(teamDir, "archived", "dup.json")), true);
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});
