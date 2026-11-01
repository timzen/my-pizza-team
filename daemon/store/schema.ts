/**
 * daemon/store/schema.ts — The SQLite schema of `state.db` and its numbered
 * migrations, run in order against `PRAGMA user_version`.
 *
 * `migrateSchema(db)` is the only entry point (the Store constructor calls it
 * before anything touches a table):
 *
 *   - **A new database** (no tables, `user_version` 0) gets `FINAL_SCHEMA`
 *     directly and is stamped `SCHEMA_VERSION`; no migration runs.
 *   - **An existing database** runs every migration numbered above its
 *     `user_version`, each in its own transaction that also bumps the version,
 *     so a crash mid-migration leaves the database at the previous version and
 *     the migration simply runs again on the next boot.
 *   - **A database at `SCHEMA_VERSION`** is left untouched.
 *   - **A database from a newer daemon** (`user_version` above what this code
 *     knows) is left untouched too, with a warning — downgrading isn't migrated.
 *
 * `cleanRetiredData(db)` runs right after it on every boot: row fixes that can't
 * be a one-time migration because such rows can still arrive.
 *
 * Migration 1 is the pre-versioning history folded into one step: every
 * database written before `user_version` was used reads as version 0, in any of
 * its historical shapes, and migration 1 takes it to today's exact schema with
 * the idempotent "add the column if it is missing / drop it if it is retired"
 * checks the Store used to run on every boot.
 *
 * Adding a migration (docs/ARCHITECTURE.md "SQLite schema and migrations"):
 * change `FINAL_SCHEMA` to the new shape, append a function to `MIGRATIONS` that
 * takes a database at the previous version to exactly that shape, and bump
 * nothing else — `SCHEMA_VERSION` is `MIGRATIONS.length`. Never edit a migration
 * that has shipped. tests/schema-migrate.test.ts checks that a migrated database
 * matches a fresh one.
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * Today's schema, as a new database gets it. Columns are listed in the order a
 * database migrated from version 0 ends up with them (later additions at the
 * end), so the two are identical, not just equivalent.
 */
const FINAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    status TEXT DEFAULT 'open',
    depends_on TEXT DEFAULT '[]',
    pending INTEGER DEFAULT 0,
    workflow TEXT,
    task_order TEXT DEFAULT '[]',
    directory TEXT,
    dir_path TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    story_id TEXT REFERENCES stories(id),
    seq INTEGER,
    slug TEXT,
    title TEXT,
    description TEXT,
    status TEXT DEFAULT 'todo',
    result TEXT,
    dir_path TEXT,
    -- WorkDef unification: board tasks are WorkDefs — their authored acceptance
    -- criteria / additional context, cached (docs/DESIGN.md "WorkDefs & Parents").
    acceptance_criteria TEXT,
    additional_context TEXT
  );

  CREATE TABLE IF NOT EXISTS assignments (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    member_id TEXT,
    claimed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT,
    metadata TEXT DEFAULT '{}',   -- opaque harness-owned data (daemon never interprets it)
    protocol_version INTEGER,     -- agent-protocol version the harness speaks (null = pre-handshake)
    harness TEXT,                 -- which harness this agent runs under (e.g. 'pi')
    harness_version TEXT,         -- the harness integration's build version (informational)
    status TEXT DEFAULT 'idle',
    last_heartbeat INTEGER,
    directory TEXT                -- the agent's working directory (docs/DESIGN.md "Work Matching: Directory Affinity")
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The WorkDef ref id (a board task id, or a standalone/Scheduled WorkDef
    -- id). No FK to tasks(id): usage is recorded on the ref, and standalone
    -- WorkDefs have no tasks row. See docs/DESIGN.md "WorkDefs & Parents".
    task_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    model TEXT,
    cost_usd REAL,
    recorded_at INTEGER,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    kind TEXT DEFAULT 'work',     -- work | pairing | chat | other (store/usage.ts)
    member_id TEXT,
    title TEXT                    -- what the run was for, snapshotted
  );

  CREATE TABLE IF NOT EXISTS assistant_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE,
    session_id TEXT,         -- the chat session this belongs to
    role TEXT,               -- 'user' | 'assistant' | 'system'
    content TEXT,
    origin TEXT,             -- 'web' | 'tui' | 'agent' | 'system'
    delivery TEXT,           -- user rows: 'queued'|'delivered'|'read' (receipts)
    state TEXT DEFAULT 'ok', -- assistant rows: 'ok'|'failed'
    reply_to TEXT,           -- id of the message this one quotes
    send_mode TEXT,          -- user rows: 'queue'|'steer' when the sender chose (terminal mode)
    created_at INTEGER
  );

  -- A chat session: one continuous conversation, backed by one Pi session.
  -- Ending a session snapshots it to assistant/sessions/<id>.md; nothing is
  -- ever deleted, which is what makes resume possible. At most one session is
  -- 'active'. See docs/DESIGN.md "Assistant Chat Model".
  CREATE TABLE IF NOT EXISTS assistant_sessions (
    id TEXT PRIMARY KEY,
    persona_id TEXT,         -- persona id, NULL for the default assistant
    persona_title TEXT,      -- denormalized so listings survive persona deletion
    title TEXT,              -- derived from the first user message
    pi_session_path TEXT,    -- backing Pi session file (reported by the extension)
    status TEXT NOT NULL,    -- 'active' | 'ended'
    snapshot_path TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    message_count INTEGER DEFAULT 0
  );

  -- One queue of asks from the daemon to the leader. Not keyed by host: there
  -- is exactly one leader (docs/DESIGN.md "One Host, One Leader", P1c-1).
  CREATE TABLE IF NOT EXISTS leader_directives (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,      -- 'spawn' | 'reset-session' | ...
    member_id TEXT,            -- target agent for actions on an existing member
    params TEXT DEFAULT '{}',  -- action params (e.g. spawn name/cwd/storyId/reason)
    status TEXT DEFAULT 'pending', -- 'pending' | 'done' | 'failed'
    error TEXT,                -- why it failed, so a failure has somewhere visible to live
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,       -- simple daemon-wide key/value settings
    value TEXT
  );

  -- The WorkItem queue: the unit of agent execution. A dumb, terminal-only
  -- attempt pointing at the WorkDef it runs. See docs/DESIGN.md "The WorkItem".
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    title TEXT,
    work_def_id TEXT,          -- the ref: the WorkDef this runs
    directory TEXT,            -- affinity bias, copied from the ref at creation
    state TEXT,                -- READY|IN_PROGRESS|MORIBUND|COMPLETE|FAILED|CANCELED
    read INTEGER DEFAULT 0,
    member_id TEXT,            -- who is/was working it
    enqueued_at INTEGER,
    last_state_change_at INTEGER,
    attempt INTEGER DEFAULT 1, -- n-th try at this ref (retries after an errored session)
    retry_at INTEGER,          -- a READY retry is held until this time (backoff)
    error TEXT,                -- why this attempt's agent session errored
    -- The persona this run was given, snapshotted at claim (never rewritten;
    -- all NULL when it had none). docs/DESIGN.md "The in-flight persona".
    persona_id TEXT,
    persona_title TEXT,
    persona_origin TEXT,       -- team | builtin | package:<name>
    persona_via TEXT,          -- PersonaVia
    persona_fallback_from TEXT -- the id that didn't resolve, when a built-in stood in
  );

  -- The usage dashboard's day rollups (store/usage.ts).
  CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at);
  -- The per-WorkDef execution-count aggregate (getExecutionStats) and the
  -- active-item lookup.
  CREATE INDEX IF NOT EXISTS idx_work_items_work_def ON work_items(work_def_id);
`;

/**
 * The migrations, in order: `MIGRATIONS[n - 1]` takes a database at version
 * `n - 1` to version `n`. Each runs inside a transaction opened by
 * `migrateSchema`, so it must not open its own.
 */
const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
  migrateLegacySchema,
];

/** The schema version this code writes: the number of migrations. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Bring `state.db` to `SCHEMA_VERSION`: create it fresh, run the migrations
 * above its `user_version`, or leave it alone when it is already there (or
 * ahead). Call once, before any other query.
 */
export function migrateSchema(db: DatabaseSync): void {
  const version = userVersion(db);
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    console.warn(`[store] state.db is at schema version ${version}, newer than this daemon's ${SCHEMA_VERSION}; leaving it as is`);
    return;
  }
  if (version === 0 && !hasTables(db)) {
    inTransaction(db, () => {
      db.exec(FINAL_SCHEMA);
      setUserVersion(db, SCHEMA_VERSION);
    });
    return;
  }
  MIGRATIONS.slice(version).forEach((migrate, i) => {
    inTransaction(db, () => {
      migrate(db);
      setUserVersion(db, version + i + 1);
    });
  });
}

/**
 * Data fixes that run on every boot, after `migrateSchema`, whatever the
 * version: unlike a migration they can't be done once, because the rows they
 * fix can still arrive (a `spawn` directive with `reason: "assistant"` can still
 * be POSTed to /api/leader/directives by an old client).
 */
export function cleanRetiredData(db: DatabaseSync): void {
  cancelRetiredDirectives(db);
}

/** The database's `PRAGMA user_version` (0 for one never stamped). */
function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/** Stamp `PRAGMA user_version` (a pragma takes no bound parameters). */
function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
}

/** Does the database have any table yet? (A new file has none.) */
function hasTables(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== undefined;
}

/** Run `fn` in one immediate transaction: all of it lands, or none of it. */
function inTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The column names of `table` (empty when it doesn't exist). */
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

// --- Migration 1: every pre-versioning shape → today's schema ---

/**
 * Migration 1. Takes a database from before `user_version` — any of its
 * historical shapes, including one missing whole tables — to today's exact
 * schema. Every step is idempotent (it checks before it changes), because a
 * version-0 database may already be partly or wholly up to date: this is what
 * used to run on every boot.
 */
function migrateLegacySchema(db: DatabaseSync): void {
  // Missing tables are created in their final shape; the checks below then
  // find nothing to do for them.
  db.exec(FINAL_SCHEMA.replace(/CREATE INDEX[^;]*;/g, ""));

  // The token-usage ledger lost its FK and grew cache/kind/member/title columns.
  migrateUsageTable(db);

  // Errored-session retries (docs/DESIGN.md "Errored Sessions Retry") and the
  // in-flight persona snapshot (docs/DESIGN.md "The in-flight persona").
  addMissingColumns(db, "work_items", [
    ["attempt", "INTEGER DEFAULT 1"], ["retry_at", "INTEGER"], ["error", "TEXT"],
    ["persona_id", "TEXT"], ["persona_title", "TEXT"], ["persona_origin", "TEXT"],
    ["persona_via", "TEXT"], ["persona_fallback_from", "TEXT"],
  ]);

  // Pending stories (docs/DESIGN.md "Pending: Write, Review, Activate"; the
  // `paused` column it replaced is dropped below), and the story's working
  // directory as plain data (docs/DESIGN.md "The Work Model").
  addMissingColumns(db, "stories", [
    ["workflow", "TEXT"], ["pending", "INTEGER DEFAULT 0"], ["task_order", "TEXT DEFAULT '[]'"], ["directory", "TEXT"],
  ]);

  // Assistant chat: sessions + real delivery receipts. The v1 turn model they
  // replaced is dropped rather than carried (P1c-5 — no deployment ever
  // carried v1 data).
  const asst = columnsOf(db, "assistant_messages");
  addMissingColumns(db, "assistant_messages", [
    ["session_id", "TEXT"], ["origin", "TEXT"], ["delivery", "TEXT"],
    ["state", "TEXT DEFAULT 'ok'"], ["reply_to", "TEXT"], ["send_mode", "TEXT"],
  ]);
  db.exec("DROP TABLE IF EXISTS assistant_turns");
  if (asst.has("turn_id")) db.exec("ALTER TABLE assistant_messages DROP COLUMN turn_id");
  if (asst.has("status")) db.exec("ALTER TABLE assistant_messages DROP COLUMN status");

  // WorkDef unification: board tasks cache their authored fields
  // (docs/DESIGN.md "WorkDefs & Parents").
  addMissingColumns(db, "tasks", [["acceptance_criteria", "TEXT"], ["additional_context", "TEXT"]]);

  // Directory-affinity matching (docs/DESIGN.md "Work Matching: Directory
  // Affinity") and the version handshake (docs/DESIGN.md "One Protocol, One
  // Version" — a null protocol_version is a pre-handshake harness, reported
  // rather than refused).
  addMissingColumns(db, "members", [
    ["metadata", "TEXT DEFAULT '{}'"], ["directory", "TEXT"], ["protocol_version", "INTEGER"],
    ["harness", "TEXT"], ["harness_version", "TEXT"],
  ]);
  // Host routing removed (P1c-2): one machine, so there is nothing to route.
  if (columnsOf(db, "members").has("host_id")) db.exec("ALTER TABLE members DROP COLUMN host_id");

  // One leader, so the directive queue is no longer keyed by host (P1c-1). The
  // column was NOT NULL, so it has to go rather than simply being ignored. The
  // daemon realizes spawns itself now (P3-1), so a failure needs a home that a
  // human sees rather than a log line nobody reads.
  if (columnsOf(db, "leader_directives").has("host_id")) db.exec("ALTER TABLE leader_directives DROP COLUMN host_id");
  addMissingColumns(db, "leader_directives", [["error", "TEXT"]]);

  dropRetiredColumns(db);
  dropRetiredTables(db);

  // After the column migrations, so `work_def_id` and `recorded_at` exist.
  db.exec("CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_work_items_work_def ON work_items(work_def_id)");
}

/** `ALTER TABLE … ADD COLUMN` each `[name, type]` the table doesn't have yet. */
function addMissingColumns(db: DatabaseSync, table: string, cols: Array<[string, string]>): void {
  const have = columnsOf(db, table);
  for (const [name, type] of cols) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Bring an older `token_usage` table up to date:
 *
 * 1. **Drop the foreign key.** Early databases declared `task_id REFERENCES
 *    tasks(id)`; the schema has since removed it (usage is recorded on WorkDef
 *    refs, and standalone WorkDefs, archived tasks, and chat runs have no
 *    `tasks` row), but `CREATE TABLE IF NOT EXISTS` never touched existing
 *    tables — so on those DBs every such insert failed the constraint.
 *    SQLite can't drop a constraint in place, so the table is rebuilt, keeping
 *    its rows.
 * 2. Add the columns the ledger grew (cache tokens, kind, member, title).
 */
function migrateUsageTable(db: DatabaseSync): void {
  const fks = db.prepare("PRAGMA foreign_key_list(token_usage)").all() as unknown[];
  if (fks.length > 0) {
    db.exec(`CREATE TABLE token_usage_rebuilt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      model TEXT,
      cost_usd REAL,
      recorded_at INTEGER
    )`);
    db.exec(`INSERT INTO token_usage_rebuilt (id, task_id, input_tokens, output_tokens, model, cost_usd, recorded_at)
             SELECT id, task_id, input_tokens, output_tokens, model, cost_usd, recorded_at FROM token_usage`);
    db.exec("DROP TABLE token_usage");
    db.exec("ALTER TABLE token_usage_rebuilt RENAME TO token_usage");
  }
  addMissingColumns(db, "token_usage", [
    ["cache_read_tokens", "INTEGER DEFAULT 0"],
    ["cache_write_tokens", "INTEGER DEFAULT 0"],
    // Rows from before kinds existed were all teammate work-item runs.
    ["kind", "TEXT DEFAULT 'work'"],
    ["member_id", "TEXT"],
    ["title", "TEXT"],
  ]);
}

/**
 * Drop columns from models the daemon no longer has: capability matching
 * (`requirements`, `capabilities`), work modes (`work_mode`,
 * `assigned_story_id`), task substatus and read tracking (`substatus`,
 * `last_read_at`), story `categories` (replaced by context), story `paused`
 * (replaced by `pending`; the cache is rebuilt from files), story and task
 * `context` (the context library, removed for personas), task `dirty` (it
 * flagged rows for a `task.json` mirror nothing read), and the old
 * task|workdef WorkItem ref (`ref_kind`, `story_id`, `task_id`). Nothing reads
 * or writes them, but a column that still exists invites someone to.
 *
 * WorkItems are the one table not rebuilt from files (they are the Inbox's
 * history), so an item from before the ref collapsed may name its WorkDef only in
 * `task_id`; that is copied into `work_def_id` before the column goes.
 */
function dropRetiredColumns(db: DatabaseSync): void {
  if (columnsOf(db, "work_items").has("task_id")) {
    db.exec("UPDATE work_items SET work_def_id = task_id WHERE work_def_id IS NULL AND task_id IS NOT NULL");
  }
  const retired: Array<[string, string]> = [
    ["stories", "requirements"], ["stories", "categories"], ["stories", "paused"], ["stories", "context"],
    ["tasks", "substatus"], ["tasks", "last_read_at"], ["tasks", "context"], ["tasks", "dirty"],
    ["members", "capabilities"], ["members", "work_mode"], ["members", "assigned_story_id"],
    ["work_items", "ref_kind"], ["work_items", "story_id"], ["work_items", "task_id"],
  ];
  for (const [table, col] of retired) {
    if (columnsOf(db, table).has(col)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  }
}

/**
 * Drop tables the daemon no longer has: `comments` / `comments_loaded`, a
 * write-only SQLite copy of each task's thread. Comments live only in the ref's
 * `comments.jsonl` (Store.getCommentsForRef); nothing ever read the copy.
 */
function dropRetiredTables(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS comments_loaded");
  db.exec("DROP TABLE IF EXISTS comments");
}

// --- Every boot ---

/**
 * Cancel pending spawns for the retired assistant role. The leader is the chat
 * agent now, but a database from before that can still hold a pending
 * `spawn` with `reason: "assistant"`. Left alone it would be realized as a
 * teammate, listed as a pending spawn, and counted toward the team size — so it is
 * cancelled at boot (`cleanRetiredData`), instead of every reader having to skip it.
 */
function cancelRetiredDirectives(db: DatabaseSync): void {
  db.prepare(
    `UPDATE leader_directives SET status = 'cancelled', updated_at = ?
     WHERE action = 'spawn' AND status = 'pending' AND json_extract(params, '$.reason') = 'assistant'`,
  ).run(Date.now());
}
