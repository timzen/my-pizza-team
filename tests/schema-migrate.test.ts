/**
 * tests/schema-migrate.test.ts — opening an older state.db drops the columns of
 * retired models (Store.dropRetiredColumns), and keeps the data that matters.
 *
 * Builds the old shape by hand — the columns as the daemon used to create them —
 * then opens it with the current Store.
 */

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import * as path from "@std/path";

const RETIRED: Record<string, string[]> = {
  stories: ["requirements", "categories"],
  tasks: ["substatus", "last_read_at"],
  members: ["capabilities", "work_mode", "assigned_story_id"],
  work_items: ["ref_kind", "story_id", "task_id"],
};

function columns(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally { db.close(); }
}

Deno.test("an old database loses the retired columns, and old WorkItems keep their ref", () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-schema-test-" });
  const dbPath = path.join(teamDir, "state.db");
  try {
    // The old shape: today's schema plus the retired columns, added back the way
    // older daemons created them — and a WorkItem from before the ref collapsed,
    // which names its WorkDef only in task_id.
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    const old = new DatabaseSync(dbPath);
    for (const [table, cols] of Object.entries(RETIRED)) {
      for (const col of cols) old.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
    }
    old.exec(`
      INSERT INTO work_items (id, title, ref_kind, story_id, task_id, work_def_id, state, read, enqueued_at, last_state_change_at)
        VALUES ('wi-old', 'Old item', 'task', 's1', 'old-task-1', NULL, 'COMPLETE', 0, 1, 1),
               ('wi-new', 'New item', NULL, NULL, NULL, 'def-2', 'COMPLETE', 0, 2, 2);
    `);
    old.close();
    for (const [table, cols] of Object.entries(RETIRED)) {
      assert(cols.every((c) => columns(dbPath, table).includes(c)), `fixture has ${table}'s retired columns`);
    }

    const store = new Store(teamDir, structuredClone(TEST_CONFIG));
    const items = store.getWorkItems({}).items;
    assertEquals(items.find((i) => i.id === "wi-old")?.ref.workDefId, "old-task-1", "the task_id ref was carried over");
    assertEquals(items.find((i) => i.id === "wi-new")?.ref.workDefId, "def-2");
    store.close();

    for (const [table, retired] of Object.entries(RETIRED)) {
      const cols = columns(dbPath, table);
      for (const col of retired) assert(!cols.includes(col), `${table}.${col} should be dropped`);
    }
  } finally { Deno.removeSync(teamDir, { recursive: true }); }
});

Deno.test("a fresh database never has the retired columns", () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-schema-test-" });
  try {
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    for (const [table, retired] of Object.entries(RETIRED)) {
      const cols = columns(path.join(teamDir, "state.db"), table);
      assert(cols.length > 0, `${table} exists`);
      for (const col of retired) assert(!cols.includes(col), `${table}.${col} is not created`);
    }
  } finally { Deno.removeSync(teamDir, { recursive: true }); }
});
