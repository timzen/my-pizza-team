/**
 * daemon/store/schema.ts — The SQLite schema of `state.db` and its numbered
 * migrations, run in order against `PRAGMA user_version`.
 *
 * `migrateSchema(db)` is the only entry point (the Store constructor calls it
 * before anything touches a table):
 *
 *   - **A new database** (no tables, `user_version` 0) gets `FINAL_SCHEMA`
 *     directly and is stamped `SCHEMA_VERSION`; no migration runs.
 *   - **A database from before 0.36.0** (`user_version` 0 in an older shape than
 *     0.36.0's; `preCutoffSchemaFindings`) is refused with the "upgrade through
 *     0.36.x first" error — not migrated, and not silently rebuilt.
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
 * Migration 1 takes 0.36.0's database — the last release before `user_version`
 * was used, so it reads as version 0 — to today's exact schema. Older shapes are
 * no longer migrated: 0.36.0 is the oldest version a team can upgrade from
 * (`MIN_UPGRADE_FROM_VERSION`).
 *
 * Adding a migration (docs/ARCHITECTURE.md "SQLite schema and migrations"):
 * change `FINAL_SCHEMA` to the new shape, append a function to `MIGRATIONS` that
 * takes a database at the previous version to exactly that shape, and bump
 * nothing else — `SCHEMA_VERSION` is `MIGRATIONS.length`. Never edit a migration
 * that has shipped. tests/schema-migrate.test.ts checks that a migrated database
 * matches a fresh one.
 */

import { DatabaseSync } from "node:sqlite";
import { PRE_CUTOFF_UPGRADE_MESSAGE } from "../../shared/types.ts";

/**
 * Today's schema, as a new database gets it. Columns are listed in the order a
 * database 0.36.0 created ends up with them after migration 1 (later additions
 * at the end), so the two are identical, not just equivalent.
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
    additional_context TEXT,
    -- A poll state's bookkeeping (TaskPollRecord as JSON), cached from the
    -- story's task entry like status (docs/DESIGN.md "Polling States").
    poll TEXT
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
    state TEXT,                -- READY|IN_PROGRESS|MORIBUND|COMPLETE|FAILED|CANCELED|WAITED
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
  migrateFrom036,
  addTaskPoll,
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
  // A version-0 database older than 0.36.0 is refused, never rebuilt: work_items
  // (the Inbox history) lives only here (docs/DESIGN.md "Upgrading from before 0.36.0").
  const tooOld = preCutoffSchemaFindings(db);
  if (tooOld.length > 0) throw new Error(`${PRE_CUTOFF_UPGRADE_MESSAGE}\n${tooOld.map((f) => `  - ${f}`).join("\n")}`);
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

// --- Migration 1: 0.36.0's shape → today's schema ---

/**
 * Migration 1. Takes a database written by 0.36.0 — the last release before
 * `user_version` was used, so it reads as version 0 — to today's exact schema.
 * `migrateSchema` has already refused any version-0 database whose shape is
 * older than 0.36.0's (`preCutoffSchemaFindings`), so only what 0.36.0 still had
 * is left to drop: task `dirty` (it flagged rows for a `task.json` mirror nothing
 * read) and the `comments` / `comments_loaded` tables (a write-only SQLite copy of
 * each task's thread; comments live only in the ref's `comments.jsonl`). A
 * database from a development build between 0.36.0 and versioning may already
 * lack them, so each step checks first.
 */
function migrateFrom036(db: DatabaseSync): void {
  if (columnsOf(db, "tasks").has("dirty")) db.exec("ALTER TABLE tasks DROP COLUMN dirty");
  db.exec("DROP TABLE IF EXISTS comments_loaded");
  db.exec("DROP TABLE IF EXISTS comments");
  db.exec("CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_work_items_work_def ON work_items(work_def_id)");
}

// --- Migration 2: poll states ---

/**
 * Migration 2. Adds `tasks.poll`, the cached poll bookkeeping of a task in a
 * poll state (docs/DESIGN.md "Polling States"). A cache column: the story file
 * is the record, and `loadFromDisk` refills it on every boot.
 */
function addTaskPoll(db: DatabaseSync): void {
  if (!columnsOf(db, "tasks").has("poll")) db.exec("ALTER TABLE tasks ADD COLUMN poll TEXT");
}

// --- Refusing pre-0.36.0 databases ---

/** What 0.36.0 had beyond today's schema; a version-0 database may carry these and still be 0.36.0's. */
const SCHEMA_036_EXTRA_TABLES = new Set(["comments", "comments_loaded"]);
const SCHEMA_036_EXTRA_COLUMNS = new Set(["tasks.dirty"]);
/** Columns added by migrations after 1: a version-0 (0.36.0) database lacks them and is still 0.36.0's. */
const POST_036_COLUMNS = new Set(["tasks.poll"]);

/** Today's tables and their columns, read off `FINAL_SCHEMA` in a scratch in-memory database. */
function finalColumns(): Map<string, Set<string>> {
  const scratch = new DatabaseSync(":memory:");
  try {
    scratch.exec(FINAL_SCHEMA);
    const out = new Map<string, Set<string>>();
    for (const { name } of scratch.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>) {
      out.set(name, columnsOf(scratch, name));
    }
    return out;
  } finally {
    scratch.close();
  }
}

/**
 * Why `db` is older than 0.36.0, or an empty list when it isn't. Only a database
 * from before versioning (`user_version` 0, with tables) can be: every version
 * 0.36.0 boots brought the database to its shape (the idempotent column checks it
 * ran on every start), so a version-0 database that is missing a table or column
 * today's schema has, still has a column or table 0.36.0 had already dropped, or
 * still has `token_usage`'s old foreign key, was last opened by an older version.
 * Read-only; daemon/layout-check.ts reports these, and `migrateSchema` refuses them.
 */
export function preCutoffSchemaFindings(db: DatabaseSync): string[] {
  if (userVersion(db) !== 0 || !hasTables(db)) return [];
  const findings: string[] = [];
  const final = finalColumns();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
  for (const [table, cols] of final) {
    if (!tables.includes(table)) { findings.push(`state.db has no \`${table}\` table`); continue; }
    const have = columnsOf(db, table);
    const missing = [...cols].filter((c) => !have.has(c) && !POST_036_COLUMNS.has(`${table}.${c}`));
    const extra = [...have].filter((c) => !cols.has(c) && !SCHEMA_036_EXTRA_COLUMNS.has(`${table}.${c}`));
    if (missing.length) findings.push(`state.db's \`${table}\` table has no ${missing.map((c) => `\`${c}\``).join(", ")}`);
    if (extra.length) findings.push(`state.db's \`${table}\` table still has the retired ${extra.map((c) => `\`${c}\``).join(", ")}`);
  }
  for (const table of tables) {
    if (!final.has(table) && !SCHEMA_036_EXTRA_TABLES.has(table)) findings.push(`state.db still has the retired \`${table}\` table`);
  }
  if (tables.includes("token_usage") && (db.prepare("PRAGMA foreign_key_list(token_usage)").all() as unknown[]).length > 0) {
    findings.push("state.db's `token_usage` table still has its old foreign key to `tasks`");
  }
  return findings;
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
