/**
 * tests/schema-migrate.test.ts — the versioned schema migrations
 * (daemon/store/schema.ts). Opening a pre-versioning state.db (user_version 0)
 * runs migration 1: it drops the columns of retired models and the retired
 * tables, adds the missing columns, keeps the data that matters, and ends at
 * exactly the schema a fresh database gets. A database already at the latest
 * version is left untouched.
 *
 * Builds the old shapes by hand — the columns as the daemon used to create them,
 * with user_version 0 as every database had before versioning — then opens them
 * with the current Store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import { DatabaseSync } from "node:sqlite";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { SCHEMA_VERSION } from "../daemon/store/schema.ts";
import * as path from "node:path";

const RETIRED: Record<string, string[]> = {
  stories: ["requirements", "categories"],
  tasks: ["substatus", "last_read_at", "dirty"],
  members: ["capabilities", "work_mode", "assigned_story_id"],
  work_items: ["ref_kind", "story_id", "task_id"],
};

function columns(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally { db.close(); }
}

test("an old database loses the retired columns, and old WorkItems keep their ref", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  try {
    // The old shape: today's schema plus the retired columns, added back the way
    // older daemons created them — and a WorkItem from before the ref collapsed,
    // which names its WorkDef only in task_id.
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    const old = new DatabaseSync(dbPath);
    old.exec("PRAGMA user_version = 0"); // from before versioning
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
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("a fresh database never has the retired columns", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  try {
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    for (const [table, retired] of Object.entries(RETIRED)) {
      const cols = columns(path.join(teamDir, "state.db"), table);
      assert(cols.length > 0, `${table} exists`);
      for (const col of retired) assert(!cols.includes(col), `${table}.${col} is not created`);
    }
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

function tables(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  } finally { db.close(); }
}

test("an old database loses the retired comments tables; a fresh one never has them", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  try {
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    for (const t of ["comments", "comments_loaded"]) assert(!tables(dbPath).includes(t), `${t} is not created`);
    // The old shape: the write-only SQLite copy of task threads, as older daemons created it.
    const old = new DatabaseSync(dbPath);
    old.exec("PRAGMA user_version = 0"); // from before versioning
    old.exec(`
      CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id), from_id TEXT, body TEXT, created_at INTEGER);
      CREATE TABLE comments_loaded (task_id TEXT PRIMARY KEY REFERENCES tasks(id), loaded_at INTEGER);
    `);
    old.close();
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    for (const t of ["comments", "comments_loaded"]) assert(!tables(dbPath).includes(t), `${t} should be dropped`);
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("an old work_items table gains the retry columns; old items read as attempt 1", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  try {
    // A work_items table from before errored-session retries (no attempt/retry_at/error).
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE work_items (id TEXT PRIMARY KEY, title TEXT, work_def_id TEXT, directory TEXT, state TEXT,
        read INTEGER DEFAULT 0, member_id TEXT, enqueued_at INTEGER, last_state_change_at INTEGER);
      INSERT INTO work_items (id, title, work_def_id, state, read, enqueued_at, last_state_change_at)
        VALUES ('wi-old', 'Old item', 'def-1', 'COMPLETE', 0, 1, 1);
    `);
    old.close();

    const store = new Store(teamDir, structuredClone(TEST_CONFIG));
    const item = store.getWorkItem("wi-old")!;
    assertEquals(item.attempt, 1);
    assertEquals(item.retryAt, undefined);
    assertEquals(item.error, undefined);
    store.close();
    for (const col of ["attempt", "retry_at", "error"]) assert(columns(dbPath, "work_items").includes(col), `work_items.${col} added`);
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

/** Everything that defines a schema, order-independent: per-table columns, FKs, and the indexes. */
function schemaOf(dbPath: string): Record<string, unknown> {
  const db = new DatabaseSync(dbPath);
  try {
    const out: Record<string, unknown> = {};
    const names = (db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ type: string; name: string }>);
    for (const { type, name } of names) {
      if (type !== "table") { out[`${type}:${name}`] = true; continue; }
      const cols = (db.prepare(`PRAGMA table_info(${name})`).all() as Array<Record<string, unknown>>)
        .map((c) => `${c.name} ${c.type} dflt=${c.dflt_value} notnull=${c.notnull} pk=${c.pk}`).sort();
      const fks = (db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<Record<string, unknown>>)
        .map((f) => `${f.from}->${f.table}.${f.to}`).sort();
      out[`table:${name}`] = { cols, fks };
    }
    return out;
  } finally { db.close(); }
}

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try { return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version); }
  finally { db.close(); }
}

test("a fresh database is created at the latest schema version", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  try {
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    assert(SCHEMA_VERSION >= 1, "there is at least one migration");
    assertEquals(userVersion(path.join(teamDir, "state.db")), SCHEMA_VERSION);
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("a database already at the latest version is left untouched", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  try {
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    // A retired column, which migration 1 would drop — so if it survives, no
    // migration ran.
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE stories ADD COLUMN requirements TEXT");
    db.close();
    const before = schemaOf(dbPath);

    new Store(teamDir, structuredClone(TEST_CONFIG)).close();

    assertEquals(JSON.stringify(schemaOf(dbPath)), JSON.stringify(before), "schema unchanged");
    assert(columns(dbPath, "stories").includes("requirements"), "the retired column is still there");
    assertEquals(userVersion(dbPath), SCHEMA_VERSION);
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("an old-shape database is migrated to exactly the fresh schema", () => {
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  try {
    new Store(freshDir, structuredClone(TEST_CONFIG)).close();
    const fresh = schemaOf(path.join(freshDir, "state.db"));

    // An early database: before stories had workflow/pending/order/directory,
    // tasks their cached WorkDef fields, members the handshake and directory,
    // directives an error column (but still a NOT NULL host_id), WorkItems
    // retries, personas or a work_def_id-only ref, chat sessions and receipts
    // (but the v1 turn model), usage its extra columns (but an FK to tasks) —
    // plus the retired comments tables, and with some tables not yet existing.
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE stories (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT DEFAULT 'open',
        depends_on TEXT DEFAULT '[]', dir_path TEXT, requirements TEXT, categories TEXT, paused INTEGER DEFAULT 0, context TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, story_id TEXT REFERENCES stories(id), seq INTEGER, slug TEXT, title TEXT,
        description TEXT, status TEXT DEFAULT 'todo', result TEXT, dir_path TEXT, substatus TEXT, last_read_at INTEGER,
        context TEXT DEFAULT '[]', dirty INTEGER);
      CREATE TABLE assignments (task_id TEXT PRIMARY KEY REFERENCES tasks(id), member_id TEXT, claimed_at INTEGER);
      CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT, host_id TEXT, status TEXT DEFAULT 'idle', last_heartbeat INTEGER,
        capabilities TEXT, work_mode TEXT, assigned_story_id TEXT);
      CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id), input_tokens INTEGER,
        output_tokens INTEGER, model TEXT, cost_usd REAL, recorded_at INTEGER);
      CREATE TABLE assistant_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, role TEXT, content TEXT,
        turn_id TEXT, status TEXT, created_at INTEGER);
      CREATE TABLE assistant_turns (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE leader_directives (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, action TEXT NOT NULL, member_id TEXT,
        params TEXT DEFAULT '{}', status TEXT DEFAULT 'pending', created_at INTEGER, updated_at INTEGER);
      CREATE TABLE work_items (id TEXT PRIMARY KEY, title TEXT, ref_kind TEXT, story_id TEXT, task_id TEXT, work_def_id TEXT,
        directory TEXT, state TEXT, read INTEGER DEFAULT 0, member_id TEXT, enqueued_at INTEGER, last_state_change_at INTEGER);
      CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id), from_id TEXT, body TEXT, created_at INTEGER);
      CREATE TABLE comments_loaded (task_id TEXT PRIMARY KEY REFERENCES tasks(id), loaded_at INTEGER);

      INSERT INTO leader_directives (id, host_id, action, params, status, created_at, updated_at)
        VALUES ('d-asst', 'h1', 'spawn', '{"reason":"assistant"}', 'pending', 1, 1),
               ('d-team', 'h1', 'spawn', '{"reason":"pool"}', 'pending', 1, 1);
      INSERT INTO work_items (id, title, ref_kind, task_id, state, read, enqueued_at, last_state_change_at)
        VALUES ('wi-old', 'Old item', 'task', 'old-task-1', 'COMPLETE', 0, 1, 1);
    `);
    assertEquals(userVersion(dbPath), 0);
    old.close();

    const store = new Store(teamDir, structuredClone(TEST_CONFIG));
    const item = store.getWorkItem("wi-old")!;
    assertEquals(item.ref.workDefId, "old-task-1", "the task_id ref was carried over");
    assertEquals(item.attempt, 1);
    store.close();

    assertEquals(userVersion(dbPath), SCHEMA_VERSION);
    const migrated = schemaOf(dbPath);
    for (const key of new Set([...Object.keys(fresh), ...Object.keys(migrated)])) {
      assertEquals(JSON.stringify(migrated[key]), JSON.stringify(fresh[key]), `${key} matches the fresh schema`);
    }
    const check = new DatabaseSync(dbPath);
    try {
      const status = (id: string) => (check.prepare("SELECT status FROM leader_directives WHERE id = ?").get(id) as { status: string }).status;
      assertEquals(status("d-asst"), "cancelled", "the retired assistant spawn is cancelled");
      assertEquals(status("d-team"), "pending", "a teammate spawn is kept");
    } finally { check.close(); }
  } finally {
    fs.rmSync(freshDir, { recursive: true, force: true });
    fs.rmSync(teamDir, { recursive: true, force: true });
  }
});
