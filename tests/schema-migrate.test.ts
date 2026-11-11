/**
 * tests/schema-migrate.test.ts — the versioned schema migrations
 * (daemon/store/schema.ts).
 *
 * - A fresh database is created at the latest version.
 * - A database 0.36.0 wrote (user_version 0, 0.36.0's exact shape — the oldest a
 *   team can upgrade from) runs migration 1: it ends at exactly the schema a
 *   fresh database gets and keeps its rows.
 * - A user_version-0 database in an older shape (a column 0.36.0 had already
 *   added or dropped, a retired table, token_usage's old foreign key) is
 *   refused with the "upgrade through 0.36.x first" error and left untouched —
 *   never rebuilt.
 * - A database already at the latest version is left untouched.
 *
 * Builds the old shapes by hand, then opens them with the current Store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { DatabaseSync } from "node:sqlite";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { preCutoffSchemaFindings, SCHEMA_VERSION } from "../daemon/store/schema.ts";
import { PRE_CUTOFF_UPGRADE_MESSAGE } from "../shared/types.ts";
import * as path from "node:path";

/**
 * The schema 0.36.0 left a database in (its initSchema: the CREATEs, then the
 * columns it added to existing tables — which a database it created also got,
 * at the end, in this order).
 */
const SCHEMA_036 = `
  CREATE TABLE stories (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT DEFAULT 'open',
    depends_on TEXT DEFAULT '[]', pending INTEGER DEFAULT 0, workflow TEXT, task_order TEXT DEFAULT '[]',
    directory TEXT, dir_path TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, story_id TEXT REFERENCES stories(id), seq INTEGER, slug TEXT, title TEXT,
    description TEXT, status TEXT DEFAULT 'todo', result TEXT, dir_path TEXT, dirty INTEGER DEFAULT 0);
  CREATE TABLE assignments (task_id TEXT PRIMARY KEY REFERENCES tasks(id), member_id TEXT, claimed_at INTEGER);
  CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id), from_id TEXT,
    body TEXT, created_at INTEGER);
  CREATE TABLE comments_loaded (task_id TEXT PRIMARY KEY REFERENCES tasks(id), loaded_at INTEGER);
  CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT, metadata TEXT DEFAULT '{}', protocol_version INTEGER,
    harness TEXT, harness_version TEXT, status TEXT DEFAULT 'idle', last_heartbeat INTEGER);
  CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, input_tokens INTEGER,
    output_tokens INTEGER, model TEXT, cost_usd REAL, recorded_at INTEGER);
  CREATE TABLE assistant_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, session_id TEXT, role TEXT,
    content TEXT, origin TEXT, delivery TEXT, state TEXT DEFAULT 'ok', reply_to TEXT, send_mode TEXT, created_at INTEGER);
  CREATE TABLE assistant_sessions (id TEXT PRIMARY KEY, persona_id TEXT, persona_title TEXT, title TEXT,
    pi_session_path TEXT, status TEXT NOT NULL, snapshot_path TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
    message_count INTEGER DEFAULT 0);
  CREATE TABLE leader_directives (id TEXT PRIMARY KEY, action TEXT NOT NULL, member_id TEXT, params TEXT DEFAULT '{}',
    status TEXT DEFAULT 'pending', error TEXT, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE work_items (id TEXT PRIMARY KEY, title TEXT, work_def_id TEXT, directory TEXT, state TEXT,
    read INTEGER DEFAULT 0, member_id TEXT, enqueued_at INTEGER, last_state_change_at INTEGER,
    attempt INTEGER DEFAULT 1, retry_at INTEGER, error TEXT, persona_id TEXT, persona_title TEXT,
    persona_origin TEXT, persona_via TEXT, persona_fallback_from TEXT);
  ALTER TABLE token_usage ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
  ALTER TABLE token_usage ADD COLUMN cache_write_tokens INTEGER DEFAULT 0;
  ALTER TABLE token_usage ADD COLUMN kind TEXT DEFAULT 'work';
  ALTER TABLE token_usage ADD COLUMN member_id TEXT;
  ALTER TABLE token_usage ADD COLUMN title TEXT;
  CREATE INDEX idx_token_usage_recorded_at ON token_usage(recorded_at);
  ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;
  ALTER TABLE tasks ADD COLUMN additional_context TEXT;
  ALTER TABLE members ADD COLUMN directory TEXT;
  CREATE INDEX idx_work_items_work_def ON work_items(work_def_id);
`;

/** A team dir holding a state.db built by `sql` (user_version 0 — from before versioning). */
function oldTeam(sql: string): { teamDir: string; dbPath: string } {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
  return { teamDir, dbPath };
}

function columns(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally { db.close(); }
}

function tables(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  } finally { db.close(); }
}

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

test("a fresh database is created at the latest schema version, without 0.36.0's leftovers", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  try {
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    assert(SCHEMA_VERSION >= 1, "there is at least one migration");
    assertEquals(userVersion(dbPath), SCHEMA_VERSION);
    assert(!columns(dbPath, "tasks").includes("dirty"), "tasks.dirty is not created");
    for (const t of ["comments", "comments_loaded"]) assert(!tables(dbPath).includes(t), `${t} is not created`);
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("a 0.36.0 database is migrated to exactly the fresh schema and keeps its rows", () => {
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const { teamDir, dbPath } = oldTeam(SCHEMA_036 + `
    INSERT INTO work_items (id, title, work_def_id, state, read, enqueued_at, last_state_change_at)
      VALUES ('wi-old', 'Old item', 'def-1', 'COMPLETE', 0, 1, 1);
    INSERT INTO leader_directives (id, action, params, status, created_at, updated_at)
      VALUES ('d-asst', 'spawn', '{"reason":"assistant"}', 'pending', 1, 1),
             ('d-team', 'spawn', '{"reason":"pool"}', 'pending', 1, 1);
    INSERT INTO comments (task_id, from_id, body, created_at) VALUES (NULL, 'me', 'hi', 1);
  `);
  try {
    new Store(freshDir, structuredClone(TEST_CONFIG)).close();
    const fresh = schemaOf(path.join(freshDir, "state.db"));
    assertEquals(userVersion(dbPath), 0);

    const store = new Store(teamDir, structuredClone(TEST_CONFIG));
    const item = store.getWorkItem("wi-old")!;
    assertEquals(item.ref.workDefId, "def-1", "the Inbox history is kept");
    assertEquals(item.attempt, 1);
    store.close();

    assertEquals(userVersion(dbPath), SCHEMA_VERSION);
    const migrated = schemaOf(dbPath);
    for (const key of new Set([...Object.keys(fresh), ...Object.keys(migrated)])) {
      assertEquals(JSON.stringify(migrated[key]), JSON.stringify(fresh[key]), `${key} matches the fresh schema`);
    }
    // Identical, not just equivalent: the column order matches too.
    assertEquals(columns(dbPath, "tasks"), columns(path.join(freshDir, "state.db"), "tasks"));
    const check = new DatabaseSync(dbPath);
    try {
      const status = (id: string) => (check.prepare("SELECT status FROM leader_directives WHERE id = ?").get(id) as { status: string }).status;
      assertEquals(status("d-asst"), "cancelled", "the retired assistant spawn is cancelled (every boot)");
      assertEquals(status("d-team"), "pending", "a teammate spawn is kept");
    } finally { check.close(); }
  } finally {
    fs.rmSync(freshDir, { recursive: true, force: true });
    fs.rmSync(teamDir, { recursive: true, force: true });
  }
});

test("a version-1 database gets tasks.poll (migration 2) and keeps its task rows", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  try {
    // A fresh database, taken back to version 1's shape: no `tasks.poll`.
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    const fresh = schemaOf(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE tasks DROP COLUMN poll");
    db.exec("INSERT INTO tasks (id, story_id, status) VALUES ('t-keep', NULL, 'todo')");
    db.exec("PRAGMA user_version = 1");
    db.close();
    assert(!columns(dbPath, "tasks").includes("poll"));

    new Store(teamDir, structuredClone(TEST_CONFIG)).close();

    assertEquals(userVersion(dbPath), SCHEMA_VERSION);
    assertEquals(JSON.stringify(schemaOf(dbPath)), JSON.stringify(fresh), "matches the fresh schema");
    const check = new DatabaseSync(dbPath);
    try { assertEquals((check.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = 't-keep'").get() as { n: number }).n, 1); }
    finally { check.close(); }
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});

/** Older-than-0.36.0 shapes, each a 0.36.0 database with one thing changed. */
const PRE_036: Array<[string, string, string]> = [
  ["a missing column", SCHEMA_036.replace("ALTER TABLE members ADD COLUMN directory TEXT;", ""), "`members` table has no `directory`"],
  ["a retired column", SCHEMA_036 + "ALTER TABLE stories ADD COLUMN paused INTEGER DEFAULT 0;", "`stories` table still has the retired `paused`"],
  ["a retired column on work_items", SCHEMA_036 + "ALTER TABLE work_items ADD COLUMN task_id TEXT;", "`work_items` table still has the retired `task_id`"],
  ["a retired table", SCHEMA_036 + "CREATE TABLE assistant_turns (id TEXT PRIMARY KEY, status TEXT);", "retired `assistant_turns` table"],
  ["a missing table", SCHEMA_036.replace(/CREATE TABLE assistant_sessions[^;]*;/, ""), "no `assistant_sessions` table"],
  ["token_usage's old FK", SCHEMA_036.replace("CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,", "CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id),"), "old foreign key"],
];

for (const [name, sql, expected] of PRE_036) {
  test(`a pre-0.36.0 database (${name}) is refused with the upgrade message and left untouched`, () => {
    const { teamDir, dbPath } = oldTeam(sql + "INSERT INTO work_items (id, title, state) VALUES ('wi-keep', 'Keep me', 'COMPLETE');");
    try {
      const before = schemaOf(dbPath);
      let error: Error | null = null;
      try { new Store(teamDir, structuredClone(TEST_CONFIG)).close(); } catch (e) { error = e as Error; }
      assert(error !== null, "the Store refuses to open it");
      assertStringIncludes(error!.message, PRE_CUTOFF_UPGRADE_MESSAGE);
      assertStringIncludes(error!.message, expected);
      assertEquals(userVersion(dbPath), 0, "not stamped");
      assertEquals(JSON.stringify(schemaOf(dbPath)), JSON.stringify(before), "not migrated or rebuilt");
      const db = new DatabaseSync(dbPath);
      try { assertEquals((db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n, 1, "rows kept"); }
      finally { db.close(); }
    } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
  });
}

test("preCutoffSchemaFindings: nothing for a 0.36.0, a fresh, or a versioned database", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assertEquals(preCutoffSchemaFindings(db), [], "no tables yet");
    db.exec(SCHEMA_036);
    assertEquals(preCutoffSchemaFindings(db), [], "0.36.0's shape");
    db.exec("ALTER TABLE stories ADD COLUMN paused INTEGER");
    assertEquals(preCutoffSchemaFindings(db).length, 1);
    db.exec("PRAGMA user_version = 1");
    assertEquals(preCutoffSchemaFindings(db), [], "versioned databases are the migrations' business");
  } finally { db.close(); }
});

test("a database already at the latest version is left untouched", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-schema-test-"));
  const dbPath = path.join(teamDir, "state.db");
  try {
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    // A column no migration knows; if it survives, nothing ran (and nothing refused).
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE stories ADD COLUMN requirements TEXT");
    db.close();
    const before = schemaOf(dbPath);

    new Store(teamDir, structuredClone(TEST_CONFIG)).close();

    assertEquals(JSON.stringify(schemaOf(dbPath)), JSON.stringify(before), "schema unchanged");
    assert(columns(dbPath, "stories").includes("requirements"), "the extra column is still there");
    assertEquals(userVersion(dbPath), SCHEMA_VERSION);
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});
