/**
 * tests/context.test.ts — Verifies context-library persistence:
 * frontmatter round-tripping, CRUD, and client-side-friendly listing.
 */

import { assertEquals, assertExists } from "@std/assert";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import * as path from "@std/path";

function createTempTeamDir(): string {
  const dir = Deno.makeTempDirSync({ prefix: "mpt-context-test-" });
  Deno.mkdirSync(path.join(dir, "stories"), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

Deno.test("Context: save then read round-trips metadata and body", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    const saved = store.saveContextEntry({
      title: "Coding Standards",
      description: "House style for all code",
      tags: ["coding", "review"],
      content: "Always write tests.",
    });
    assertEquals(saved.id, "coding-standards");
    assertEquals(saved.title, "Coding Standards");
    assertEquals(saved.description, "House style for all code");
    assertEquals(saved.tags, ["coding", "review"]);
    assertEquals(saved.content, "Always write tests.");

    const fetched = store.getContextEntry("coding-standards");
    assertExists(fetched);
    assertEquals(fetched!.title, "Coding Standards");
    assertEquals(fetched!.tags, ["coding", "review"]);
    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Context: list returns all entries sorted by id", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.saveContextEntry({ title: "Beta", content: "b" });
    store.saveContextEntry({ title: "Alpha", content: "a" });
    const entries = store.getContextEntries();
    assertEquals(entries.map((e) => e.id), ["alpha", "beta"]);
    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Context: update mutates fields in place", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.saveContextEntry({ title: "Notes", description: "old", tags: ["a"], content: "x" });
    const updated = store.updateContextEntry("notes", { description: "new", tags: ["a", "b"] });
    assertExists(updated);
    assertEquals(updated!.description, "new");
    assertEquals(updated!.tags, ["a", "b"]);
    assertEquals(updated!.content, "x");
    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Context: delete removes the entry", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.saveContextEntry({ title: "Temp", content: "x" });
    assertEquals(store.deleteContextEntry("temp"), true);
    assertEquals(store.getContextEntry("temp"), null);
    assertEquals(store.deleteContextEntry("temp"), false);
    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});

Deno.test("Context: attached to stories/tasks and resolved for prompts", () => {
  const teamDir = createTempTeamDir();
  try {
    const store = new Store(teamDir, DEFAULT_CONFIG);
    store.saveContextEntry({ title: "Style Guide", content: "tabs not spaces" });
    store.saveContextEntry({ title: "API Rules", content: "REST only" });

    const { story } = store.createStory(
      "s1", "Story One", "desc", "open", [],
      [{ title: "Task A", description: "do a", context: ["api-rules"] }],
      undefined, undefined, ["style-guide"],
    );
    assertEquals(story.context, ["style-guide"]);

    // Story-level attachment persists and reloads from disk.
    const reloaded = store.getStory("s1");
    assertEquals(reloaded!.context, ["style-guide"]);
    const task = store.getTasksForStory("s1")[0]!;
    assertEquals(task.context, ["api-rules"]);

    // Resolution merges story + task, dedupes, drops unknown ids.
    const resolved = store.resolveTaskContext(story.context, task.context);
    assertEquals(resolved.map((r) => r.title), ["Style Guide", "API Rules"]);

    const deduped = store.resolveTaskContext(["style-guide", "missing"], ["style-guide"]);
    assertEquals(deduped.map((r) => r.title), ["Style Guide"]);
    store.close();
  } finally {
    cleanupDir(teamDir);
  }
});
