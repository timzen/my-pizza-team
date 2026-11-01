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
 *
 * (A pre-0.36.0 `archived/<id>.json` is no longer migrated; such a team is refused
 * at startup — tests/layout-check.test.ts.)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertExists } from "./_assert.ts";
import { withTeam, jsonInit } from "./_team.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";

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

/** Create a one-task story and finish it (moved to done) so it's archivable. */
function doneStory(store: Store, id: string, dependsOn: string[] = []): void {
  store.createStory(id, `Story ${id}`, "desc", "open", dependsOn, [{ title: "T1", description: "d" }]);
  store.moveTask(`${id}-1`, "done");
}

test("archiveStory: archives in place (archivedAt + synopsis in stories/<id>.json)", () => {
  return withTeam({}, ({ store, teamDir }) => {
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
  });
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
  return withTeam({}, ({ store, teamDir }) => {
    doneStory(store, "stale");
    // Flag it archived by hand while the cache still holds it.
    const data = readJson(teamDir, "stories/stale.json");
    writeJson(teamDir, "stories/stale.json", { ...data, archivedAt: "2026-01-01T00:00:00.000Z", synopsis: "s" });
    store.loadFromDisk();
    assertEquals(store.getStory("stale"), null);
    assertEquals(store.getTask("stale-1"), null);
  });
});

test("routes: archive + /api/archived keep their shapes; archived stories reject edits", async () => {
  await withTeam({}, async ({ store, app, teamDir }) => {
    doneStory(store, "old");
    const res = await app.request("/api/stories/old/archive", jsonInit("POST", {}));
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
    assertEquals((await app.request("/api/stories/old", jsonInit("PUT", { title: "X" }))).status, 404);
    assertEquals((await app.request("/api/stories/old/tasks", jsonInit("POST", { title: "T", description: "d" }))).status, 404);
    assertEquals((await app.request("/api/stories/old/pending", jsonInit("POST"))).status, 404);
    assertEquals((await app.request("/api/stories/old/archive", jsonInit("POST", {}))).status, 404);
    assertEquals((await app.request("/api/stories/old", jsonInit("DELETE"))).status, 404);
    const stories = await (await app.request("/api/stories")).json();
    assertEquals(stories.stories.some((s: { id: string }) => s.id === "old"), false);
    // Its id can't be reused (would clobber the archived file and its tasks).
    const create = await app.request("/api/stories", jsonInit("POST", { id: "old", title: "New", description: "d", workflow: "default" }));
    assertEquals(create.status, 409);
    assertEquals(store.addTask("old", { title: "T", description: "d" }), null);
    assertEquals(store.updateStoryDetails("old", { title: "X" }), false);
    // The file is untouched.
    const file = readJson(teamDir, "stories/old.json");
    assertEquals(file.title, "Story old");
    assertEquals((file.tasks as unknown[]).length, 1);
  });
});

