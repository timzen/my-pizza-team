/**
 * daemon/store.ts — SQLite store + JSON file sync (Deno port).
 *
 * Core data layer for the team lead. Uses Deno's built-in node:sqlite
 * (DatabaseSync) — no external FFI .so required. Maintains the same schema,
 * CRUD operations, migrations, workflow loading, and JSON file sync as the
 * original.
 *
 * Key invariants:
 * - JSON files are the source of truth for story/task definitions
 * - SQLite is the runtime engine for fast atomic reads/writes
 * - Comments are always appended to JSONL immediately (never lost)
 * - Assignments and members are ephemeral (never written to JSON)
 * - The `dirty` flag on tasks tracks what needs flushing to disk
 */

import { DatabaseSync } from "node:sqlite";
import {
  slugify,
  DEFAULT_CONFIG,
  generateTeammateName,
  normalizeDirectory,
  TODO_STATE,
  DONE_STATE,
  ACTIVE_WORK_ITEM_STATES,
  STORIES_DIR,
  WORKDEFS_DIR,
  CONFIG_FILE,
  resolveMinTeammates,
  type Comment,
  type Story,
  type StoryTaskRef,
  type TeamConfig,
  type WorkflowConfig,
  type WorkItem,
  type WorkItemState,
  type WorkItemRef,
  type WorkDef,
  type WorkDefParent,
  type Schedule,
  type Template,
  type Thought,
  type ThoughtStatus,
  type ThoughtGroup,
  DEFAULT_THOUGHT_COLOR,
  DEFAULT_GROUP_SIZE,
  type Member,
  type MemberSessionStats,
  resolveTriage,
  TRIAGE_INSTRUCTIONS_FILE,
  type TeamReadiness,
  type Assignment,
} from "../shared/types.ts";
import { isAgentState, isActiveState, isValidPosition, firstActiveState, nextState, validateWorkflow } from "./workflow-engine.ts";
import { listContextEntries, getContextEntry, saveContextEntry, updateContextEntry, deleteContextEntry, type ContextEntry } from "./store/context.ts";
import { listWorkDefs, getWorkDef, saveWorkDef, updateWorkDef, deleteWorkDef, writeWorkDef, workDefDir } from "./store/workdefs.ts";
import { listSchedules, getSchedule, saveSchedule, updateSchedule, deleteSchedule } from "./store/schedules.ts";
import { listTemplates, getTemplate, saveTemplate, updateTemplate, deleteTemplate } from "./store/templates.ts";
import { listThoughts, getThought as ioGetThought, writeThought, deleteThoughtFile, listThoughtGroups, writeThoughtGroups } from "./store/thoughts.ts";
import { isTriageDue, triageSkipReason, triageWorkDefId, triageWorkDefTitle, triageWorkItemTitle, type TriageSkipReason } from "./triage.ts";
import {
  AssistantChat,
  type AssistantDelivery,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantOrigin,
  type AssistantSession,
  type InboxMessage,
} from "./store/assistant-chat.ts";
import { isCronDue } from "./cron.ts";
import { commitTeamDir } from "./store/git-sync.ts";
import { TeammateTranscripts } from "./store/transcripts.ts";
import { TeammatePairing } from "./store/pairing.ts";
import { migrateUsageColumns, recordUsage, dailyUsage, runsOnDay, syncUsageLedger, type UsageEntry, type UsageDay, type UsageRun } from "./store/usage.ts";
import * as path from "@std/path";
import { existsSync } from "@std/fs";

/**
 * Directive actions an agent realizes itself rather than via its host leader.
 * These need in-process Pi APIs (session replacement), which tmux keystrokes
 * cannot express. See docs/DESIGN.md "Assistant Chat Model".
 */
export const SELF_HANDLED_ACTIONS = new Set(["new-session", "resume-session"]);

/**
 * Reserved singleton identity for the leader: the agent that realizes directives
 * (spawning windows, resetting sessions) *and* answers the chat. Matched by name
 * so a leader is never mistaken for a pool teammate.
 *
 * There is no separate "assistant" agent: the leader's session holds no human work
 * (nobody types in it) and chat v2's mirror is role-agnostic, so the leader is the
 * chat participant. See DESIGN.md "One Agent to Talk To". This replaced a second
 * constant, CHAT_ROLE_NAME, that held the same value for the same reason.
 */
export const LEADER_MEMBER_NAME = "leader";

/**
 * Is this member part of the generalist teammate **pool** (the thing
 * `minTeammates` sizes)? Roles are a name convention: the leader is a singleton
 * with a reserved name; everything else is a teammate.
 */
export function isPoolTeammate(name: string): boolean {
  const n = name.toLowerCase();
  return !n.includes(LEADER_MEMBER_NAME);
}

/**
 * Internal board-task view: a WorkDef whose parent is a story, joined with its
 * workflow position (from the story's `tasks` list). This is a runtime cache
 * shape only — the persisted model is the WorkDef (`tasks/<id>/workdef.md`) plus
 * the story's `tasks: [{id, status}]` (see docs/DESIGN.md "WorkDefs & Parents"). The
 * WorkDef body's Goal is surfaced as `description` for the (pre-unification) API.
 */
export interface Task {
  id: string;
  title: string;
  /** The WorkDef's Goal (kept as `description` for API back-compat). */
  description: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  status: string;
  context?: string[];
}

export interface TaskWithMeta extends Task {
  storyId: string;
  seq: number;
  slug: string;
  /** The WorkDef directory (`tasks/<id>/`) — comments/attachments live here. */
  dirPath: string;
}

/** Serialize a Story to the on-disk story.json shape (omitting empty fields). */
function serializeStory(story: Story): Story {
  const data: Story = {
    id: story.id,
    title: story.title,
    description: story.description,
    status: story.status,
    dependsOn: story.dependsOn,
    tasks: story.tasks || [],
  };
  if (story.directory) data.directory = story.directory;
  if (story.paused) data.paused = true;
  if (story.workflow) data.workflow = story.workflow;
  if (story.context && story.context.length > 0) data.context = story.context;
  if (story.archivedAt) data.archivedAt = story.archivedAt;
  return data;
}

/**
 * Derive a task's creation counter (`seq`) from its stable id. Task IDs are
 * `${storyId}-${seq}`; strip the story-id prefix and parse the numeric suffix.
 * Returns null for hand-authored non-numeric ids (caller falls back to order).
 */
function taskSeqFromId(storyId: string, taskId: string): number | null {
  const prefix = `${storyId}-`;
  if (!taskId.startsWith(prefix)) return null;
  const suffix = taskId.slice(prefix.length);
  const n = parseInt(suffix, 10);
  return String(n) === suffix ? n : null;
}

/**
 * Serialize a TeamConfig to the on-disk config.json shape. Preserves all
 * persistable fields (workflows live in the workflows/ dir, so they are
 * intentionally omitted here). Every route that saves config comes through here,
 * so a field missing from this list is erased on the next save — add new
 * TeamConfig fields here and to tests/config-persist.test.ts.
 */
function serializeConfig(config: TeamConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    port: config.port,
    tmuxSession: config.tmuxSession,
    defaultWorkflow: config.defaultWorkflow,
    autosave: config.autosave,
    maxTeammates: config.maxTeammates,
  };
  // Only persist an *explicit* size: unset means "half of maxTeammates", and
  // writing the derived value would freeze it (see resolveMinTeammates).
  if (config.minTeammates !== undefined) out.minTeammates = config.minTeammates;
  if (config.agentTimeoutSeconds !== undefined) out.agentTimeoutSeconds = config.agentTimeoutSeconds;
  if (config.apiToken) out.apiToken = config.apiToken;
  if (config.teammates && Object.keys(config.teammates).length > 0) out.teammates = config.teammates;
  if (config.readinessProbe) out.readinessProbe = config.readinessProbe;
  // Harness templates have no editor in the UI, so nothing re-sends them: dropping
  // them here erased a team's custom templates on any Config save or team-size
  // change (tests/config-persist.test.ts).
  if (config.harnesses) out.harnesses = config.harnesses;
  if (config.defaultHarness) out.defaultHarness = config.defaultHarness;
  if (config.experimental && Object.keys(config.experimental).length > 0) out.experimental = config.experimental;
  if (config.triage && Object.keys(config.triage).length > 0) out.triage = config.triage;
  return out;
}

export class Store {
  private db: DatabaseSync;
  private teamDir: string;
  private config: TeamConfig;
  private workflows: Record<string, WorkflowConfig> = {};
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private triageTimer: ReturnType<typeof setInterval> | null = null;
  private transitionInstructionsCache: Map<string, { content: string; mtime: number; cachedAt: number }> = new Map();
  private transitionCacheTTL = 30000; // 30 seconds
  /**
   * The team's readiness, from the daemon's own probe (daemon/readiness.ts) or a
   * harness's `POST /api/readiness` (see TeamReadiness). Held in memory only: like
   * member connections, it's live state a freshly-booted daemon has no knowledge
   * of — with no report yet the team is treated as ready until the probe's first
   * run says otherwise (at startup).
   */
  private teamReadiness: TeamReadiness | undefined;
  /**
   * Each live agent's session stats (context fill, session cost), as last
   * reported. In memory only, like readiness: it describes a running process,
   * and a restarted daemon hears again after the agent's next turn.
   */
  private sessionStats = new Map<string, MemberSessionStats>();
  /**
   * Ids explicitly dismissed by a human (tombstones). A dismissed id's next
   * heartbeat is told to shut down; an unknown-but-not-dismissed id is told to
   * re-register. In-memory only — a daemon restart clears it (and also wipes
   * members), so after a restart every agent simply re-registers.
   */
  private dismissedIds: Set<string> = new Set();

  /**
   * The assistant conversation (sessions, messages, receipts, inbox, thoughts,
   * SSE). Delegated wholesale to store/assistant-chat.ts — see
   * docs/DESIGN.md "Assistant Chat Model".
   */
  private chat!: AssistantChat;
  /**
   * Live teammate transcripts for the watch view (docs/DESIGN.md "Watching and Pairing with a Teammate").
   * In-memory only; routes use it directly — it has no DB or config coupling.
   */
  readonly transcripts = new TeammateTranscripts();
  /** Web-UI pairing intent per teammate (docs/DESIGN.md "Watching and Pairing with a Teammate"). In-memory. */
  readonly pairing = new TeammatePairing();

  constructor(teamDir: string, config: TeamConfig) {
    this.teamDir = teamDir;
    this.config = config;
    const dbPath = path.join(teamDir, "state.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();
    // Persona titles come from the context library, which the Store owns.
    this.chat = new AssistantChat(this.db, teamDir, (id) => this.getContextEntry(id)?.title ?? null);
    // Usage: the `usage/*.jsonl` files are the source of truth; rebuild the
    // SQLite cache from them (migrating the pre-files ledger on first boot).
    syncUsageLedger(this.db, teamDir);
    this.resetConnectionsForBoot();
    this.loadWorkflows();
  }

  /**
   * Clear ephemeral connection state on daemon boot. Members and assignments
   * are connection state, not durable records (see the file header) — but they
   * live in SQLite, so without this a freshly-started daemon (which holds zero
   * live agent connections) would keep listing the previous run's agents as
   * "offline" forever. Agents re-register when they reconnect.
   *
   * Any WorkItem left IN_PROGRESS lost its holder across the restart, so it's
   * moved to MORIBUND — honest about the lost connection and recoverable by a
   * human (force-fail / re-enqueue) or by the same agent reconnecting and
   * completing it (setWorkItemState accepts MORIBUND). Its `member_id` is kept
   * so that path still authorizes.
   */
  private resetConnectionsForBoot(): void {
    this.db.prepare("UPDATE work_items SET state = 'MORIBUND', last_state_change_at = ? WHERE state = 'IN_PROGRESS'").run(Date.now());
    this.db.exec("DELETE FROM assignments");
    this.db.exec("DELETE FROM members");
  }

  /** Load workflows from the workflows/ directory (falls back to the built-in default). */
  private loadWorkflows(): void {
    const workflowsDir = path.join(this.teamDir, "workflows");
    this.workflows = {};

    if (existsSync(workflowsDir)) {
      for (const entry of Deno.readDirSync(workflowsDir)) {
        if (!entry.isDirectory) continue;
        const wfDir = path.join(workflowsDir, entry.name);
        const wfFile = path.join(wfDir, "workflow.json");
        if (!existsSync(wfFile)) continue;
        try {
          const wf: WorkflowConfig = JSON.parse(Deno.readTextFileSync(wfFile));
          // Only accept the ordered-states shape (see docs/DESIGN.md "The Work Model");
          // malformed or legacy transition-matrix files are skipped.
          if (validateWorkflow(wf) === null) this.workflows[entry.name] = wf;
        } catch {
          // Skip malformed workflow files
        }
      }
    }

    // Fall back to the built-in default workflow when none are defined on disk.
    if (Object.keys(this.workflows).length === 0) {
      this.workflows = { ...DEFAULT_CONFIG.workflows };
    }
  }

  /** Get all loaded workflows */
  getWorkflows(): Record<string, WorkflowConfig> {
    return this.workflows;
  }

  /** Reload workflows from disk (called after config changes) */
  reloadWorkflows(): void {
    this.loadWorkflows();
  }

  /** Save a workflow to its directory */
  saveWorkflow(name: string, wf: WorkflowConfig): void {
    const workflowsDir = path.join(this.teamDir, "workflows");
    const wfDir = path.join(workflowsDir, name);
    Deno.mkdirSync(wfDir, { recursive: true });
    Deno.writeTextFileSync(path.join(wfDir, "workflow.json"), JSON.stringify(wf, null, 2) + "\n");
    this.workflows[name] = wf;
  }

  /** Delete a workflow directory */
  deleteWorkflow(name: string): boolean {
    const wfDir = path.join(this.teamDir, "workflows", name);
    if (!existsSync(wfDir)) return false;
    Deno.removeSync(wfDir, { recursive: true });
    delete this.workflows[name];
    return true;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        status TEXT DEFAULT 'open',
        depends_on TEXT DEFAULT '[]',
        paused INTEGER DEFAULT 0,
        workflow TEXT,
        context TEXT DEFAULT '[]',
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
        context TEXT DEFAULT '[]',
        dir_path TEXT,
        dirty INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS assignments (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        member_id TEXT,
        claimed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id),
        from_id TEXT,
        body TEXT,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS comments_loaded (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        loaded_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        name TEXT,
        metadata TEXT DEFAULT '{}',   -- opaque harness-owned data (daemon never interprets it)
        protocol_version INTEGER,     -- agent-protocol version the harness speaks (null = pre-handshake)
        harness TEXT,                 -- which harness this agent runs under (e.g. 'pi')
        harness_version TEXT,         -- the harness integration's build version (informational)
        status TEXT DEFAULT 'idle',
        last_heartbeat INTEGER
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
        recorded_at INTEGER
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
        created_at INTEGER
      );

      -- A chat session: one continuous conversation, backed by one Pi session.
      -- Ending a session snapshots it to assistant/sessions/<id>.md; nothing is
      -- ever deleted, which is what makes resume possible. At most one session is
      -- 'active'. See docs/DESIGN.md "Assistant Chat Model".
      CREATE TABLE IF NOT EXISTS assistant_sessions (
        id TEXT PRIMARY KEY,
        persona_id TEXT,         -- context-entry id, NULL for the default assistant
        persona_title TEXT,      -- denormalized so listings survive entry deletion
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
        last_state_change_at INTEGER
      );
    `);

    // Migration: add columns if they don't exist (for existing databases)
    // The token-usage ledger grew cache/kind/member/title columns (store/usage.ts).
    migrateUsageColumns(this.db);

    const storyColumns = this.db.prepare("PRAGMA table_info(stories)").all() as Array<Record<string, unknown>>;
    if (!storyColumns.some((col) => col.name === "workflow")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN workflow TEXT");
    }
    // Context-library attachments.
    if (!storyColumns.some((col) => col.name === "context")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN context TEXT DEFAULT '[]'");
    }
    if (!storyColumns.some((col) => col.name === "paused")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN paused INTEGER DEFAULT 0");
    }
    if (!storyColumns.some((col) => col.name === "task_order")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN task_order TEXT DEFAULT '[]'");
    }
    // Work-model: the story's working directory is plain data (see docs/DESIGN.md "The Work Model").
    if (!storyColumns.some((col) => col.name === "directory")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN directory TEXT");
    }

    // Assistant chat: sessions + real delivery receipts. These columns are added
    // for databases created before them; the v1 turn model they replaced is gone
    // entirely (P1c-5 — no deployment ever carried v1 data).
    const asstColumns = this.db.prepare("PRAGMA table_info(assistant_messages)").all() as Array<Record<string, unknown>>;
    const hasAsstColumn = (name: string) => asstColumns.some((col) => col.name === name);
    if (!hasAsstColumn("session_id")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN session_id TEXT");
    if (!hasAsstColumn("origin")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN origin TEXT");
    if (!hasAsstColumn("delivery")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN delivery TEXT");
    if (!hasAsstColumn("state")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN state TEXT DEFAULT 'ok'");
    if (!hasAsstColumn("reply_to")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN reply_to TEXT");
    // Vestiges of the v1 turn model, dropped rather than carried.
    this.db.exec("DROP TABLE IF EXISTS assistant_turns");
    if (hasAsstColumn("turn_id")) this.db.exec("ALTER TABLE assistant_messages DROP COLUMN turn_id");
    if (hasAsstColumn("status")) this.db.exec("ALTER TABLE assistant_messages DROP COLUMN status");

    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<Record<string, unknown>>;
    if (!taskColumns.some((col) => col.name === "context")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN context TEXT DEFAULT '[]'");
    }
    // WorkDef unification: board tasks are WorkDefs — cache their authored
    // acceptance criteria / additional context (see docs/DESIGN.md "WorkDefs & Parents").
    if (!taskColumns.some((col) => col.name === "acceptance_criteria")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT");
    }
    if (!taskColumns.some((col) => col.name === "additional_context")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN additional_context TEXT");
    }

    const memberColumns = this.db.prepare("PRAGMA table_info(members)").all() as Array<Record<string, unknown>>;
    if (!memberColumns.some((col) => col.name === "metadata")) {
      this.db.exec("ALTER TABLE members ADD COLUMN metadata TEXT DEFAULT '{}'");
    }
    // Directory-affinity matching: the agent's working directory (docs/DESIGN.md "Work Matching: Directory Affinity").
    if (!memberColumns.some((col) => col.name === "directory")) {
      this.db.exec("ALTER TABLE members ADD COLUMN directory TEXT");
    }
    // Version handshake (docs/DESIGN.md "One Protocol, One Version"). Null protocol_version means a
    // pre-handshake harness, which is reported rather than refused.
    if (!memberColumns.some((col) => col.name === "protocol_version")) {
      this.db.exec("ALTER TABLE members ADD COLUMN protocol_version INTEGER");
    }
    if (!memberColumns.some((col) => col.name === "harness")) {
      this.db.exec("ALTER TABLE members ADD COLUMN harness TEXT");
    }
    if (!memberColumns.some((col) => col.name === "harness_version")) {
      this.db.exec("ALTER TABLE members ADD COLUMN harness_version TEXT");
    }
    // Host routing removed (P1c-2): one machine, so there is nothing to route.
    if (memberColumns.some((col) => col.name === "host_id")) {
      this.db.exec("ALTER TABLE members DROP COLUMN host_id");
    }

    // One leader, so the directive queue is no longer keyed by host (P1c-1). The
    // column was NOT NULL, so it has to go rather than simply being ignored.
    const directiveColumns = this.db.prepare("PRAGMA table_info(leader_directives)").all() as Array<Record<string, unknown>>;
    if (directiveColumns.some((col) => col.name === "host_id")) {
      this.db.exec("ALTER TABLE leader_directives DROP COLUMN host_id");
    }
    // The daemon realizes spawns itself now (P3-1), so a failure needs a home that a
    // human sees rather than a log line nobody reads.
    if (!directiveColumns.some((col) => col.name === "error")) {
      this.db.exec("ALTER TABLE leader_directives ADD COLUMN error TEXT");
    }

    this.dropRetiredColumns();
    this.cancelRetiredDirectives();
  }

  /**
   * Cancel pending spawns for the retired assistant role. The leader is the chat
   * agent now, but a database from before that can still hold a pending
   * `spawn` with `reason: "assistant"`. Left alone it would be realized as a
   * teammate, listed as a pending spawn, and counted toward the team size — so it is
   * cancelled once, here, instead of every reader having to skip it.
   */
  private cancelRetiredDirectives(): void {
    this.db.prepare(
      `UPDATE leader_directives SET status = 'cancelled', updated_at = ?
       WHERE action = 'spawn' AND status = 'pending' AND json_extract(params, '$.reason') = 'assistant'`,
    ).run(Date.now());
  }

  /**
   * Drop columns from models the daemon no longer has, from databases created
   * before they went: capability matching (`requirements`, `capabilities`), work
   * modes (`work_mode`, `assigned_story_id`), task substatus and read tracking
   * (`substatus`, `last_read_at`), story `categories` (replaced by context), and the
   * old task|workdef WorkItem ref (`ref_kind`, `story_id`, `task_id`). Nothing reads
   * or writes them, but a column that still exists invites someone to.
   *
   * WorkItems are the one table not rebuilt from files (they are the Inbox's
   * history), so an item from before the ref collapsed may name its WorkDef only in
   * `task_id`; that is copied into `work_def_id` before the column goes.
   */
  private dropRetiredColumns(): void {
    const has = (table: string, col: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).some((c) => c.name === col);
    if (has("work_items", "task_id")) {
      this.db.exec("UPDATE work_items SET work_def_id = task_id WHERE work_def_id IS NULL AND task_id IS NOT NULL");
    }
    const retired: Array<[string, string]> = [
      ["stories", "requirements"], ["stories", "categories"],
      ["tasks", "substatus"], ["tasks", "last_read_at"],
      ["members", "capabilities"], ["members", "work_mode"], ["members", "assigned_story_id"],
      ["work_items", "ref_kind"], ["work_items", "story_id"], ["work_items", "task_id"],
    ];
    for (const [table, col] of retired) {
      if (has(table, col)) this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
    }
  }

  // --- Load from filesystem ---

  loadFromDisk(): void {
    const storiesDir = path.join(this.teamDir, STORIES_DIR);

    // Read flat story files (stories/<id>.json).
    const stories: Story[] = [];
    if (existsSync(storiesDir)) {
      for (const entry of Deno.readDirSync(storiesDir)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        try { stories.push(JSON.parse(Deno.readTextFileSync(path.join(storiesDir, entry.name))) as Story); }
        catch { /* skip malformed */ }
      }
    }

    // Index board WorkDefs (parent.kind === "story") by their story.
    const boardByStory = new Map<string, WorkDef[]>();
    for (const def of listWorkDefs(this.teamDir)) {
      if (def.parent?.kind === "story") {
        const arr = boardByStory.get(def.parent.id) || [];
        arr.push(def);
        boardByStory.set(def.parent.id, arr);
      }
    }

    for (const story of stories) {
      // Reconcile story.tasks against the board WorkDefs actually on disk:
      // keep listed ones that still exist (in order), append orphans as todo.
      const defs = boardByStory.get(story.id) || [];
      const defById = new Map(defs.map((d) => [d.id, d]));
      const listed = (story.tasks || []).filter((t) => defById.has(t.id));
      const listedIds = new Set(listed.map((t) => t.id));
      const orphans = defs.filter((d) => !listedIds.has(d.id)).map((d) => ({ id: d.id, status: TODO_STATE }));
      story.tasks = [...listed, ...orphans];
      this.upsertStory(story);

      let seq = 0;
      for (const t of story.tasks) {
        seq += 1;
        this.upsertTask(defById.get(t.id)!, story.id, t.status, seq);
      }
    }

    // Run admission so every ready story has its one in-flight task (CONWIP),
    // then reconcile the WorkItem queue: every task in an agent state must have
    // an active (READY/IN_PROGRESS/MORIBUND) WorkItem (rebuilds after a restart).
    for (const story of this.getStories()) this.runAdmission(story.id);
    this.reconcileQueue();
  }

  /** Absolute path of a story's flat json file (`stories/<id>.json`). */
  private storyFile(id: string): string {
    return path.join(this.teamDir, STORIES_DIR, `${id}.json`);
  }

  /** Write a story to its flat json file. */
  private writeStory(story: Story): void {
    Deno.mkdirSync(path.join(this.teamDir, STORIES_DIR), { recursive: true });
    Deno.writeTextFileSync(this.storyFile(story.id), JSON.stringify(serializeStory(story), null, 2) + "\n");
  }

  /**
   * Ensure every task currently in an agent state has an active WorkItem. Creates
   * a READY item for any agent-state task that has none (e.g. after a restart, a
   * hand-edit, or a task admitted before the queue existed). Never touches tasks
   * in buckets/manual states, and never resurrects terminal WorkItems.
   */
  private reconcileQueue(): void {
    for (const story of this.getStories()) {
      const wf = this.getWorkflowForStory(story.id);
      for (const task of this.getTasksForStory(story.id)) {
        if (isAgentState(wf, task.status) && !this.getActiveWorkItemForTask(task.id)) {
          this.enqueueFor(task.id);
        }
      }
    }
  }

  private upsertStory(story: Story): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO stories (id, title, description, status, depends_on, paused, workflow, context, task_order, directory, dir_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      story.id, story.title, story.description, story.status,
      JSON.stringify(story.dependsOn),
      story.paused ? 1 : 0,
      story.workflow || null, JSON.stringify(story.context || []),
      JSON.stringify((story.tasks || []).map((t) => t.id)), story.directory || null,
      path.join(this.teamDir, STORIES_DIR),
    );
  }

  /** Cache a board WorkDef (+ its story-owned status) into the tasks index. */
  private upsertTask(def: WorkDef, storyId: string, status: string, seq: number): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO tasks (id, story_id, seq, slug, title, description, acceptance_criteria, additional_context, status, context, dir_path, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      def.id, storyId, seq, slugify(def.title), def.title, def.goal,
      def.acceptanceCriteria || "", def.additionalContext || null,
      status, JSON.stringify(def.contextRefs || []), workDefDir(this.teamDir, def.id),
    );
  }

  // --- Stories ---

  /** Map a raw SQLite row to a Story object (tasks[] joined from the task index). */
  private rowToStory(row: Record<string, unknown>): Story & { dirPath: string } {
    const order: string[] = row.task_order && (row.task_order as string) !== "[]" ? JSON.parse(row.task_order as string) : [];
    const taskRows = this.db.prepare("SELECT id, status, seq FROM tasks WHERE story_id = ?").all(row.id as string) as Array<Record<string, unknown>>;
    const statusById = new Map(taskRows.map((t) => [t.id as string, t.status as string]));
    const ids = order.filter((id) => statusById.has(id));
    for (const t of [...taskRows].sort((a, b) => (a.seq as number) - (b.seq as number))) {
      if (!ids.includes(t.id as string)) ids.push(t.id as string);
    }
    return {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      status: row.status as "open" | "done",
      dependsOn: JSON.parse(row.depends_on as string),
      paused: row.paused ? true : undefined,
      workflow: (row.workflow as string) || undefined,
      context: row.context && (row.context as string) !== "[]" ? JSON.parse(row.context as string) : undefined,
      directory: (row.directory as string) || undefined,
      tasks: ids.map((id) => ({ id, status: statusById.get(id) ?? TODO_STATE })),
      dirPath: path.join(this.teamDir, STORIES_DIR),
    };
  }

  /** Map a raw SQLite row to a TaskWithMeta object */
  private rowToTask(row: Record<string, unknown>): TaskWithMeta {
    return {
      id: row.id as string,
      storyId: row.story_id as string,
      seq: row.seq as number,
      slug: row.slug as string,
      title: row.title as string,
      description: row.description as string,
      acceptanceCriteria: (row.acceptance_criteria as string) || undefined,
      additionalContext: (row.additional_context as string) || undefined,
      status: row.status as string,
      context: row.context && (row.context as string) !== "[]" ? JSON.parse(row.context as string) : undefined,
      dirPath: row.dir_path as string,
    };
  }

  getStories(): (Story & { dirPath: string })[] {
    const rows = this.db.prepare("SELECT * FROM stories ORDER BY id").all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToStory(row));
  }

  hasStory(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM stories WHERE id = ?").get(id);
    return !!row;
  }

  createStory(
    id: string,
    title: string,
    description: string,
    status: "open" | "done" = "open",
    dependsOn: string[] = [],
    tasks?: Array<{ title: string; description: string; context?: string[] }>,
    workflow?: string,
    context?: string[],
    paused?: boolean,
    directory?: string
  ): { story: Story; tasks: TaskWithMeta[] } {
    const storyData: Story = { id, title, description, status, dependsOn, tasks: [] };
    if (directory) storyData.directory = normalizeDirectory(directory);
    if (paused) storyData.paused = true;
    if (workflow) storyData.workflow = workflow;
    if (context && context.length > 0) storyData.context = context;

    // Insert the story row first so task rows can satisfy the story_id FK.
    this.upsertStory(storyData);

    const createdTasks: TaskWithMeta[] = [];
    // Every task starts in the implicit `todo` bucket; admission (CONWIP) pulls
    // the first one into the workflow's first active state below.
    if (tasks && tasks.length > 0) {
      for (let i = 0; i < tasks.length; i++) {
        const taskDef = tasks[i]!;
        const seq = i + 1;
        const taskId = `${id}-${seq}`;
        // A board task is a WorkDef whose parent is this story. Its Goal is the
        // task's description (goal/acceptance-criteria authoring lands in the UI).
        const def = saveWorkDef(this.teamDir, {
          id: taskId,
          title: taskDef.title,
          parent: { kind: "story", id },
          goal: taskDef.description,
          acceptanceCriteria: "",
          contextRefs: taskDef.context && taskDef.context.length > 0 ? taskDef.context : undefined,
        });
        storyData.tasks.push({ id: taskId, status: TODO_STATE });
        this.upsertTask(def, id, TODO_STATE, seq);
        createdTasks.push({
          id: taskId, title: def.title, description: def.goal,
          acceptanceCriteria: def.acceptanceCriteria, status: TODO_STATE,
          context: def.contextRefs, storyId: id, seq, slug: slugify(def.title),
          dirPath: workDefDir(this.teamDir, taskId),
        });
      }
    }

    this.writeStory(storyData);
    this.upsertStory(storyData);

    // Admit the first task into the pipeline (no-op for paused/dependent stories).
    this.runAdmission(id);

    return { story: storyData, tasks: createdTasks };
  }

  /** Append a board task (a WorkDef parented to the story) in the `todo` bucket. */
  addTask(storyId: string, input: { title: string; description: string; context?: string[] }): TaskWithMeta | null {
    const story = this.getStory(storyId);
    if (!story) return null;
    const existing = this.getTasksForStory(storyId);
    const nextSeq = existing.length > 0 ? Math.max(...existing.map((t) => t.seq)) + 1 : 1;
    const taskId = `${storyId}-${nextSeq}`;
    const def = saveWorkDef(this.teamDir, {
      id: taskId, title: input.title, parent: { kind: "story", id: storyId },
      goal: input.description, acceptanceCriteria: "",
      contextRefs: input.context && input.context.length > 0 ? input.context : undefined,
    });
    const tasks = [...story.tasks, { id: taskId, status: TODO_STATE }];
    this.writeStory({ ...story, tasks });
    this.upsertStory({ ...story, tasks });
    this.upsertTask(def, storyId, TODO_STATE, nextSeq);
    this.runAdmission(storyId);
    return {
      id: taskId, title: def.title, description: def.goal, acceptanceCriteria: def.acceptanceCriteria,
      status: TODO_STATE, context: def.contextRefs, storyId, seq: nextSeq,
      slug: slugify(def.title), dirPath: workDefDir(this.teamDir, taskId),
    };
  }

  getStory(id: string): (Story & { dirPath: string }) | null {
    const row = this.db.prepare("SELECT * FROM stories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToStory(row);
  }

  isStoryReady(storyId: string): boolean {
    const story = this.getStory(storyId);
    if (!story || story.status === "done") return false;
    if (story.dependsOn.length === 0) return true;

    for (const depId of story.dependsOn) {
      const dep = this.getStory(depId);
      // If dep is missing from active stories, it was archived (= done)
      if (!dep) continue;
      if (dep.status !== "done") return false;
    }
    return true;
  }

  updateStoryDetails(storyId: string, updates: {
    title?: string;
    description?: string;
    status?: "open" | "done";
    dependsOn?: string[];
    paused?: boolean;
    workflow?: string | null;
    context?: string[] | null;
    directory?: string | null;
  }): boolean {
    const story = this.getStory(storyId);
    if (!story) return false;

    const newTitle = updates.title ?? story.title;
    const newDescription = updates.description ?? story.description;
    const newStatus = updates.status ?? story.status;
    const newDependsOn = updates.dependsOn ?? story.dependsOn;
    const newPaused = updates.paused !== undefined ? updates.paused : (story.paused || false);
    const newWorkflow = updates.workflow !== undefined ? (updates.workflow || null) : (story.workflow || null);
    const newContext = updates.context !== undefined ? (updates.context || []) : (story.context || []);
    const newDirectory = updates.directory !== undefined
      ? (updates.directory ? normalizeDirectory(updates.directory) : null)
      : (story.directory || null);

    this.db.prepare(
      `UPDATE stories SET title = ?, description = ?, status = ?, depends_on = ?, paused = ?, workflow = ?, context = ?, directory = ? WHERE id = ?`
    ).run(newTitle, newDescription, newStatus, JSON.stringify(newDependsOn), newPaused ? 1 : 0, newWorkflow, JSON.stringify(newContext), newDirectory, storyId);

    // Write back to disk
    this.writeStory({
      id: storyId,
      title: newTitle,
      description: newDescription,
      status: newStatus,
      dependsOn: newDependsOn,
      directory: newDirectory || undefined,
      paused: newPaused,
      workflow: newWorkflow || undefined,
      context: newContext,
      tasks: story.tasks,
    });

    // Unpausing (or dependency edits) may make the story admissible.
    this.runAdmission(storyId);

    return true;
  }

  updateStoryStatus(storyId: string, status: "open" | "done"): void {
    this.db.prepare("UPDATE stories SET status = ? WHERE id = ?").run(status, storyId);
    const story = this.getStory(storyId);
    if (story) this.writeStory({ ...story, status });
  }

  // --- Tasks ---

  /**
   * Reconcile a task list against a story-owned order (array of task IDs):
   * listed tasks first (in order, skipping danglers), then any orphan tasks not
   * in the list, appended by their stable creation `seq`. This tolerates
   * hand-edits to story.json and task dirs.
   */
  private orderTasks(taskOrder: string[] | undefined, tasks: TaskWithMeta[]): TaskWithMeta[] {
    const bySeq = (a: TaskWithMeta, b: TaskWithMeta) => a.seq - b.seq;
    if (!taskOrder || taskOrder.length === 0) return [...tasks].sort(bySeq);
    const byId = new Map(tasks.map(t => [t.id, t]));
    const ordered: TaskWithMeta[] = [];
    const used = new Set<string>();
    for (const id of taskOrder) {
      const t = byId.get(id);
      if (t && !used.has(id)) { ordered.push(t); used.add(id); }
    }
    const orphans = tasks.filter(t => !used.has(t.id)).sort(bySeq);
    return [...ordered, ...orphans];
  }

  /** Persist a story's task order (reorders `story.tasks` by the given ids). */
  private persistTaskOrder(storyId: string, ids: string[]): void {
    const story = this.getStory(storyId);
    if (!story) return;
    this.db.prepare("UPDATE stories SET task_order = ? WHERE id = ?").run(JSON.stringify(ids), storyId);
    const byId = new Map(story.tasks.map((t) => [t.id, t]));
    const reordered: StoryTaskRef[] = [];
    for (const id of ids) { const t = byId.get(id); if (t) reordered.push(t); }
    for (const t of story.tasks) if (!ids.includes(t.id)) reordered.push(t);
    this.writeStory({ ...story, tasks: reordered });
  }

  getTasksForStory(storyId: string): TaskWithMeta[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE story_id = ? ORDER BY seq").all(storyId) as Array<Record<string, unknown>>;
    const tasks = rows.map((row) => this.rowToTask(row));
    const story = this.getStory(storyId);
    return this.orderTasks(story?.tasks.map((t) => t.id), tasks);
  }

  getTask(taskId: string): TaskWithMeta | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * Low-level position setter: writes status [+ result], keeps the story's
   * open/done status in sync, and ensures the WorkItem queue reflects the new
   * position. All position changes flow through here.
   *
   * WorkItem sync: landing in an agent state creates a READY WorkItem (unless
   * one is already active for the task). Leaving an agent state (or any
   * non-agent landing) abandons the task's active WorkItem as CANCELED — a
   * position change out from under an in-flight attempt is a human override.
   * `keepWorkItem` skips that abandonment (used by the WorkItem's own COMPLETE
   * advance, which already terminated the item).
   */
  private setTaskPosition(taskId: string, status: string, keepWorkItem = false): void {
    const before = this.getTask(taskId);
    this.db.prepare("UPDATE tasks SET status = ?, dirty = 1 WHERE id = ?").run(status, taskId);

    const task = this.getTask(taskId);
    if (!task) return;
    const story = this.getStory(task.storyId);
    if (!story) return;
    const wf = this.getWorkflowForStory(task.storyId);

    // Persist the new position to the story's owned tasks[] on disk.
    this.writeStory(story);

    // Abandon a now-stale WorkItem when the task's position changed out from
    // under it (unless the caller already handled the item).
    if (!keepWorkItem && before && before.status !== status) {
      this.abandonActiveWorkItem(taskId);
    }
    // Landing in an agent state ⇒ ensure a READY WorkItem exists.
    if (isAgentState(wf, status) && !this.getActiveWorkItemForTask(taskId)) {
      this.enqueueFor(taskId);
    }

    if (status === DONE_STATE) {
      const tasks = this.getTasksForStory(task.storyId);
      if (tasks.every((t) => t.status === DONE_STATE)) this.updateStoryStatus(task.storyId, "done");
    } else if (story.status === "done") {
      // A task moved back out of `done` reopens the story.
      this.updateStoryStatus(task.storyId, "open");
    }
  }

  /**
   * Set a task's status. (Compatibility wrapper; judgment moves should use
   * `moveTask`.)
   */
  updateTaskStatus(taskId: string, status: string): void {
    if (!this.getTask(taskId)) return;
    this.setTaskPosition(taskId, status);
  }

  /**
   * Judgment move (human or leader agent): put a task anywhere in its
   * workflow's positions. Any active WorkItem is abandoned (CANCELED) and,
   * when entering an agent state, a fresh READY WorkItem is created — re-entry
   * ≡ first entry (rework path). Runs admission excluding the moved task, so
   * shelving a task to `todo` doesn't bounce it straight back in.
   */
  moveTask(taskId: string, newStatus: string): { ok: boolean; error?: string } {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: "Task not found" };
    const wf = this.getWorkflowForStory(task.storyId);
    if (!isValidPosition(wf, newStatus)) {
      return { ok: false, error: `"${newStatus}" is not a state in this story's workflow` };
    }
    this.setTaskPosition(taskId, newStatus);
    this.releaseTask(taskId);
    this.runAdmission(task.storyId, taskId);
    return { ok: true };
  }

  deleteTask(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const storyId = task.storyId;
    // Cancel any active WorkItem for this task before removing it.
    this.abandonActiveWorkItem(taskId);
    this.removeTaskData(taskId);

    // Remove the WorkDef directory (workdef.md + comments + attachments).
    deleteWorkDef(this.teamDir, taskId);

    // Drop the task from the story's owned tasks[] (keeps story.json clean).
    const story = this.getStory(storyId);
    if (story?.tasks.some((t) => t.id === taskId)) {
      this.writeStory({ ...story, tasks: story.tasks.filter((t) => t.id !== taskId) });
    }

    // Deleting the in-flight task frees the CONWIP token.
    this.runAdmission(storyId);

    return true;
  }

  /**
   * Reorder a story's tasks. `orderedIds` must be a permutation of the story's
   * current task IDs. Order is owned by the story (persisted as `taskOrder` in
   * story.json + the DB) — task IDs, titles, and on-disk directories are left
   * untouched, so comments/attachments and stable IDs are unaffected.
   */
  reorderTasks(storyId: string, orderedIds: string[]): boolean {
    const tasks = this.getTasksForStory(storyId);
    if (tasks.length === 0) return false;

    // Require a strict permutation of the existing task IDs.
    const existing = new Set(tasks.map(t => t.id));
    if (orderedIds.length !== tasks.length || !orderedIds.every(id => existing.has(id))) return false;

    this.persistTaskOrder(storyId, orderedIds);
    return true;
  }

  // --- WorkItem queue ---
  //
  // A WorkItem is the unit of agent execution: a dumb, terminal-only attempt
  // pointing at a story task or a WorkDef. It drives the task: a COMPLETE item
  // advances its task, a FAILED/CANCELED one leaves the task stuck for a human.
  // See docs/DESIGN.md "The WorkItem".

  private rowToWorkItem(row: Record<string, unknown>): WorkItem {
    const ref: WorkItemRef = { workDefId: row.work_def_id as string };
    return {
      id: row.id as string,
      title: (row.title as string) || "",
      ref,
      directory: (row.directory as string) || undefined,
      state: row.state as WorkItemState,
      read: !!row.read,
      memberId: (row.member_id as string) || undefined,
      enqueuedAt: new Date(row.enqueued_at as number).toISOString(),
      lastStateChangeAt: new Date(row.last_state_change_at as number).toISOString(),
    };
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToWorkItem(row) : null;
  }

  /** List WorkItems, optionally filtered by state(s)/read, newest-first, paginated. */
  getWorkItems(opts?: { states?: WorkItemState[]; read?: boolean; limit?: number; offset?: number }): { items: WorkItem[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts?.states && opts.states.length > 0) {
      where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
      params.push(...opts.states);
    }
    if (opts?.read !== undefined) { where.push("read = ?"); params.push(opts.read ? 1 : 0); }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM work_items ${clause}`).get(...params) as { n: number }).n;
    let sql = `SELECT * FROM work_items ${clause} ORDER BY enqueued_at DESC`;
    if (opts?.limit !== undefined) { sql += " LIMIT ?"; params.push(opts.limit); if (opts?.offset) { sql += " OFFSET ?"; params.push(opts.offset); } }
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return { items: rows.map((r) => this.rowToWorkItem(r)), total };
  }

  /** The active (READY/IN_PROGRESS/MORIBUND) WorkItem for a WorkDef, if any. */
  getActiveWorkItemForTask(workDefId: string): WorkItem | null {
    const row = this.db.prepare(
      `SELECT * FROM work_items WHERE work_def_id = ? AND state IN (${ACTIVE_WORK_ITEM_STATES.map(() => "?").join(",")}) LIMIT 1`
    ).get(workDefId, ...ACTIVE_WORK_ITEM_STATES) as Record<string, unknown> | undefined;
    return row ? this.rowToWorkItem(row) : null;
  }

  private getActiveWorkItemForRef(ref: WorkItemRef): WorkItem | null {
    return this.getActiveWorkItemForTask(ref.workDefId);
  }

  /**
   * The single WorkItem creator: enqueue a READY item for any WorkDef (board,
   * Solitary, or Scheduled). Board WorkDefs inherit their story's directory
   * when they don't set one. Caller ensures none is already active.
   */
  private enqueueFor(workDefId: string): WorkItem | null {
    const def = this.getWorkDef(workDefId);
    if (!def) return null;
    let directory = def.directory;
    let title = def.title;
    if (!directory && def.parent?.kind === "story") {
      directory = this.getStory(def.parent.id)?.directory;
    }
    if (def.parent?.kind === "thought") {
      // A triage WorkDef is an empty container: its title and where it runs are
      // resolved now, from the note and the leader (TODO.md "Auto Triage").
      const note = this.getThought(def.parent.id);
      if (note) title = triageWorkItemTitle(note);
      // The leader's repo is the one place with project context; with no leader
      // registered the item has no directory, so any teammate may take it.
      directory = directory || this.getLeader()?.directory;
    }
    const id = `wi-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO work_items (id, title, work_def_id, directory, state, read, member_id, enqueued_at, last_state_change_at)
       VALUES (?, ?, ?, ?, 'READY', 0, NULL, ?, ?)`
    ).run(id, title, def.id, directory || null, now, now);
    return this.getWorkItem(id)!;
  }

  private setWorkItemStateRow(id: string, state: WorkItemState, memberId?: string | null): void {
    if (memberId === undefined) {
      this.db.prepare("UPDATE work_items SET state = ?, last_state_change_at = ? WHERE id = ?").run(state, Date.now(), id);
    } else {
      this.db.prepare("UPDATE work_items SET state = ?, member_id = ?, last_state_change_at = ? WHERE id = ?").run(state, memberId, Date.now(), id);
    }
  }

  /** Cancel a task's active WorkItem (internal override on position changes). */
  private abandonActiveWorkItem(taskId: string): void {
    const item = this.getActiveWorkItemForTask(taskId);
    if (item) this.setWorkItemStateRow(item.id, "CANCELED");
  }

  /**
   * Pick the next READY WorkItem for a polling agent using directory affinity
   * (docs/DESIGN.md "Work Matching: Directory Affinity"). Eligibility: task refs must belong to a ready,
   * unpaused story. Priority tiers:
   *   1. item.directory == agent.directory  (my repo's work)
   *   2. item has no directory              (anyone's)
   *   3. item.directory != agent.directory AND no online agent has that dir
   * Oldest-first within a tier.
   */
  getNextWorkItem(agent: { id?: string; directory?: string }): WorkItem | null {
    const rows = this.db.prepare("SELECT * FROM work_items WHERE state = 'READY' ORDER BY enqueued_at ASC").all() as Array<Record<string, unknown>>;
    const candidates = rows.map((r) => this.rowToWorkItem(r)).filter((wi) => this.isWorkItemEligible(wi));
    if (candidates.length === 0) return null;

    const agentDir = agent.directory ? normalizeDirectory(agent.directory) : undefined;
    const onlineDirs = new Set(
      this.getMembers()
        .filter((m) => m.status !== "offline" && m.directory)
        .map((m) => normalizeDirectory(m.directory!)),
    );

    const tier1 = candidates.filter((wi) => agentDir && wi.directory === agentDir);
    if (tier1[0]) return tier1[0];
    const tier2 = candidates.filter((wi) => !wi.directory);
    if (tier2[0]) return tier2[0];
    const tier3 = candidates.filter((wi) => wi.directory && wi.directory !== agentDir && !onlineDirs.has(wi.directory));
    return tier3[0] ?? null;
  }

  /** A READY WorkItem is eligible if its backing work still wants doing. */
  private isWorkItemEligible(wi: WorkItem): boolean {
    const task = this.getTask(wi.ref.workDefId);
    if (task) {
      const story = this.getStory(task.storyId);
      if (!story || story.paused || !this.isStoryReady(story.id)) return false;
      const wf = this.getWorkflowForStory(story.id);
      return isAgentState(wf, task.status);
    }
    const def = this.getWorkDef(wi.ref.workDefId);
    if (!def) return false;
    // Triage: only while its note is still there and active (archiving a note
    // archives its WorkDef, but an in-flight item must stop being handed out).
    if (def.parent?.kind === "thought") {
      const note = this.getThought(def.parent.id);
      return note !== null && note.status === "active";
    }
    // Standalone (Solitary/Scheduled) WorkDef: eligible while it exists.
    return true;
  }

  /** Lease a READY WorkItem to a member (→ IN_PROGRESS). Board tasks also get an assignment row. */
  claimWorkItem(id: string, memberId: string): boolean {
    const item = this.getWorkItem(id);
    if (!item || item.state !== "READY") return false;
    this.setWorkItemStateRow(id, "IN_PROGRESS", memberId);
    if (this.getTask(item.ref.workDefId)) {
      this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(item.ref.workDefId);
      this.db.prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)").run(item.ref.workDefId, memberId, Date.now());
    }
    return true;
  }

  /**
   * Agent-facing terminal transition (the single state-setter). COMPLETE on a
   * board task advances it; FAILED leaves it stuck. The daemon posts NO comment
   * — the agent composes its own completion/failure comment (via the comment
   * routes) before setting state. Returns the resulting task position for board
   * tasks.
   */
  setWorkItemState(id: string, state: "COMPLETE" | "FAILED"): { ok: boolean; error?: string; newStatus?: string; completed?: boolean } {
    const item = this.getWorkItem(id);
    if (!item) return { ok: false, error: "WorkItem not found" };
    if (item.state !== "IN_PROGRESS" && item.state !== "MORIBUND") {
      return { ok: false, error: `WorkItem is ${item.state}, not in flight` };
    }
    this.setWorkItemStateRow(id, state);
    // The daemon posts nothing: the agent composes its own completion/failure
    // comment (see the teammate loop / fail tool) before calling this.
    if (this.getTask(item.ref.workDefId)) {
      this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(item.ref.workDefId);
      if (state === "COMPLETE") {
        const advance = this.advanceTask(item.ref.workDefId);
        return { ok: true, ...advance };
      }
      // FAILED: leave the task in place (stuck) with no active WorkItem.
    }
    return { ok: true };
  }

  /**
   * Advance a task out of its current agent state to the next state (or `done`),
   * then re-run admission (finishing the last state frees the CONWIP token).
   * `keepWorkItem` on setTaskPosition avoids abandoning the item we just closed.
   */
  private advanceTask(taskId: string): { newStatus?: string; completed?: boolean } {
    const task = this.getTask(taskId);
    if (!task) return {};
    const wf = this.getWorkflowForStory(task.storyId);
    const next = nextState(wf, task.status);
    this.setTaskPosition(taskId, next, true);
    this.runAdmission(task.storyId);
    return { newStatus: next, completed: next === DONE_STATE };
  }

  /** Cancel a READY WorkItem (human). */
  cancelWorkItem(id: string): boolean {
    const item = this.getWorkItem(id);
    if (!item || item.state !== "READY") return false;
    this.setWorkItemStateRow(id, "CANCELED");
    if (this.getTask(item.ref.workDefId)) this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(item.ref.workDefId);
    return true;
  }

  /** Force a MORIBUND item to FAILED (human decided the agent is truly gone). */
  forceFailWorkItem(id: string, reEnqueue = false): { ok: boolean; error?: string; newItem?: WorkItem | null } {
    const item = this.getWorkItem(id);
    if (!item || item.state !== "MORIBUND") return { ok: false, error: "WorkItem is not moribund" };
    this.setWorkItemStateRow(id, "FAILED");
    if (this.getTask(item.ref.workDefId)) this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(item.ref.workDefId);
    let newItem: WorkItem | null = null;
    if (reEnqueue) newItem = this.reEnqueueRef(item.ref);
    return { ok: true, newItem };
  }

  /** Create a fresh READY WorkItem for a ref that has no active one. */
  reEnqueueRef(ref: WorkItemRef): WorkItem | null {
    if (this.getActiveWorkItemForRef(ref)) return null;
    return this.enqueueFor(ref.workDefId);
  }

  /** Mark a WorkItem read/unread (Inbox). */
  markWorkItemRead(id: string, read = true): boolean {
    const item = this.getWorkItem(id);
    if (!item) return false;
    this.db.prepare("UPDATE work_items SET read = ? WHERE id = ?").run(read ? 1 : 0, id);
    return true;
  }

  // --- Mechanical rules: admission (CONWIP) + advance ---

  /**
   * CONWIP admission: pull the next task (story order) from `todo` into the
   * workflow's first active state — but only when the story has no task
   * anywhere in its active section (WIP = 1 per story). `excludeTaskId` keeps
   * a just-shelved task from being re-admitted by its own move.
   */
  runAdmission(storyId: string, excludeTaskId?: string): void {
    const story = this.getStory(storyId);
    if (!story || story.status !== "open" || story.paused) return;
    if (!this.isStoryReady(storyId)) return;

    const wf = this.getWorkflowForStory(storyId);
    const first = firstActiveState(wf);
    if (!first) return; // empty workflow: nothing to admit into

    const tasks = this.getTasksForStory(storyId);
    // Token taken: something is already in the active section.
    if (tasks.some((t) => isActiveState(wf, t.status))) return;

    const candidate = tasks.find((t) => t.status === TODO_STATE && t.id !== excludeTaskId);
    if (!candidate) return;

    // setTaskPosition creates the READY WorkItem when landing in an agent state.
    this.setTaskPosition(candidate.id, first);
  }

  /** Release a task's assignment row (does not change its position). */
  releaseTask(taskId: string): void {
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
  }

  getAssignment(taskId: string): Assignment | null {
    const row = this.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { taskId: row.task_id as string, memberId: row.member_id as string, claimedAt: row.claimed_at as number };
  }

  getAssignmentForMember(memberId: string): (Assignment & { task: TaskWithMeta }) | null {
    const row = this.db.prepare("SELECT * FROM assignments WHERE member_id = ?").get(memberId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const task = this.getTask(row.task_id as string);
    if (!task) return null;
    return { taskId: row.task_id as string, memberId: row.member_id as string, claimedAt: row.claimed_at as number, task };
  }

  // --- Comments ---

  private ensureCommentsLoaded(taskId: string): void {
    const loaded = this.db.prepare("SELECT * FROM comments_loaded WHERE task_id = ?").get(taskId);
    if (loaded) return;

    const task = this.getTask(taskId);
    if (!task) return;

    const commentsFile = path.join(task.dirPath, "comments.jsonl");
    if (existsSync(commentsFile)) {
      const content = Deno.readTextFileSync(commentsFile);
      const lines = content.split("\n").filter(Boolean);
      const insert = this.db.prepare(
        "INSERT INTO comments (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)"
      );
      for (const line of lines) {
        const comment: Comment = JSON.parse(line);
        insert.run(taskId, comment.from, comment.body, new Date(comment.at).getTime());
      }
    }

    this.db.prepare("INSERT INTO comments_loaded (task_id, loaded_at) VALUES (?, ?)").run(taskId, Date.now());
  }

  getComments(taskId: string): Comment[] {
    // Read directly from JSONL for full fidelity (includes attachments)
    const task = this.getTask(taskId);
    if (!task) return [];
    const commentsFile = path.join(task.dirPath, "comments.jsonl");
    if (!existsSync(commentsFile)) return [];
    const content = Deno.readTextFileSync(commentsFile);
    const lines = content.split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as Comment);
  }

  addComment(taskId: string, from: string, body: string, attachments?: Array<{ name: string; size: number; type: string }>): void {
    const now = Date.now();
    this.ensureCommentsLoaded(taskId);
    this.db.prepare("INSERT INTO comments (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)").run(taskId, from, body, now);

    // Immediately append to JSONL file
    const task = this.getTask(taskId);
    if (task) {
      const commentsFile = path.join(task.dirPath, "comments.jsonl");
      const comment: Comment = { from, body, at: new Date(now).toISOString() };
      if (attachments && attachments.length > 0) comment.attachments = attachments;
      Deno.writeTextFileSync(commentsFile, JSON.stringify(comment) + "\n", { append: true });
    }
  }

  /** Save an attachment file for a task */
  saveAttachment(taskId: string, filename: string, data: Uint8Array | string): string | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    return this.saveAttachmentInDir(path.join(task.dirPath, "attachments"), filename, data);
  }

  /** Get an attachment file path */
  getAttachmentPath(taskId: string, filename: string): string | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    return this.resolveAttachmentInDir(path.join(task.dirPath, "attachments"), filename);
  }

  /**
   * List attachments for a task, newest first. Uploads are stored as
   * `<epoch-ms>-<name>` (see saveAttachment), so the upload time is recovered
   * from the stored name; files placed by other means fall back to mtime.
   * Teammates often upload the same display name repeatedly — addedAt is how
   * the UI tells them apart.
   */
  getAttachments(taskId: string): Array<{ name: string; storedName: string; size: number; addedAt: number }> {
    const task = this.getTask(taskId);
    if (!task) return [];
    return this.listAttachmentsInDir(path.join(task.dirPath, "attachments"));
  }

  /** Delete an attachment file from a task */
  deleteAttachment(taskId: string, storedName: string): boolean {
    const filePath = this.getAttachmentPath(taskId, storedName);
    if (!filePath) return false;
    try {
      Deno.removeSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // Shared attachment-directory primitives (used by both the task-scoped and
  // ref-scoped helpers — a board task's dir IS its WorkDef ref dir).
  private saveAttachmentInDir(attachDir: string, filename: string, data: Uint8Array | string): string {
    Deno.mkdirSync(attachDir, { recursive: true });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
    const storedName = `${Date.now()}-${safeName}`;
    const filePath = path.join(attachDir, storedName);
    if (typeof data === "string") Deno.writeTextFileSync(filePath, data);
    else Deno.writeFileSync(filePath, data);
    return storedName;
  }

  private resolveAttachmentInDir(attachDir: string, filename: string): string | null {
    const filePath = path.join(attachDir, filename);
    if (!existsSync(filePath)) return null;
    // Security: the resolved path must stay within the attachments directory.
    const resolved = path.resolve(filePath);
    const base = path.resolve(attachDir);
    if (!resolved.startsWith(base)) return null;
    return resolved;
  }

  private listAttachmentsInDir(attachDir: string): Array<{ name: string; storedName: string; size: number; addedAt: number }> {
    if (!existsSync(attachDir)) return [];
    const results: Array<{ name: string; storedName: string; size: number; addedAt: number }> = [];
    for (const entry of Deno.readDirSync(attachDir)) {
      if (!entry.isFile) continue;
      const stat = Deno.statSync(path.join(attachDir, entry.name));
      const displayName = entry.name.replace(/^\d+-/, "");
      const tsPrefix = entry.name.match(/^(\d+)-/);
      const addedAt = tsPrefix ? Number(tsPrefix[1]) : (stat.mtime?.getTime() ?? 0);
      results.push({ name: displayName, storedName: entry.name, size: stat.size, addedAt });
    }
    return results.sort((a, b) => b.addedAt - a.addedAt);
  }


  // --- Token Usage ---

  /**
   * Record a run's usage against a ref (a board task / WorkDef id). `extra`
   * carries the ledger's newer fields — cache tokens, kind, member, title
   * (store/usage.ts). Board tasks also flip `dirty` so task.json picks it up.
   */
  addTokenUsage(
    taskId: string, inputTokens: number, outputTokens: number, model: string, costUsd: number,
    extra: Omit<Partial<UsageEntry>, "refId" | "inputTokens" | "outputTokens" | "model" | "costUsd"> = {},
  ): void {
    recordUsage(this.db, { ...extra, refId: taskId, inputTokens, outputTokens, model, costUsd }, this.teamDir);
    this.db.prepare("UPDATE tasks SET dirty = 1 WHERE id = ?").run(taskId);
  }

  /** Record a run's usage that isn't for any ref (the leader's chat, a teammate between items). */
  recordRunUsage(entry: UsageEntry): void {
    recordUsage(this.db, entry, this.teamDir);
  }

  /** Usage per local day since `sinceMs` (the Usage dashboard's grid). */
  getDailyUsage(opts: { sinceMs: number; tzOffsetMin: number }): UsageDay[] {
    return dailyUsage(this.db, opts);
  }

  /** Every run on one local day, most expensive first. */
  getUsageRunsOnDay(opts: { date: string; tzOffsetMin: number }): UsageRun[] {
    return runsOnDay(this.db, opts);
  }

  getTokenUsage(taskId: string): Array<{ inputTokens: number; outputTokens: number; model: string; costUsd: number; at: string }> {
    const rows = this.db.prepare("SELECT * FROM token_usage WHERE task_id = ? ORDER BY recorded_at").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      model: row.model as string,
      costUsd: row.cost_usd as number,
      at: new Date(row.recorded_at as number).toISOString(),
    }));
  }

  getTokenUsageSummary(taskId: string): { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null {
    const row = this.db.prepare(
      "SELECT SUM(input_tokens) as inp, SUM(output_tokens) as out, SUM(cost_usd) as cost FROM token_usage WHERE task_id = ?"
    ).get(taskId) as Record<string, unknown> | undefined;
    if (!row || row.cost === null) return null;
    return { totalCostUsd: row.cost as number, totalInputTokens: row.inp as number, totalOutputTokens: row.out as number };
  }

  // --- Members ---

  registerMember(
    id: string,
    name: string,
    directory?: string,
    metadata: Record<string, unknown> = {},
    handshake?: { protocolVersion?: number; harness?: string; harnessVersion?: string },
  ): void {
    // (Re)registering clears any dismiss tombstone for this id.
    this.dismissedIds.delete(id);
    // …and any session stats: a registration is a fresh harness session.
    this.sessionStats.delete(id);
    this.db.prepare(
      `INSERT OR REPLACE INTO members (id, name, directory, metadata, protocol_version, harness, harness_version, status, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?)`
    ).run(
      id,
      name,
      directory ? normalizeDirectory(directory) : null,
      JSON.stringify(metadata || {}),
      handshake?.protocolVersion ?? null,
      handshake?.harness || null,
      handshake?.harnessVersion || null,
      Date.now(),
    );

    // A leader arriving (daemon start, host reconnect) is the first moment a
    // pool spawn can actually be realized — fill the pool now instead of waiting
    // for the next heartbeat tick.
    if (name.toLowerCase().includes(LEADER_MEMBER_NAME)) this.reconcileTeammatePool();
  }

  updateMemberStatus(id: string, status: string): void {
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
  }

  /**
   * Record a heartbeat. A previously-reaped agent coming back restores its
   * MORIBUND WorkItems to IN_PROGRESS — it was alive after all (see
   * docs/DESIGN.md "Reaping").
   */
  heartbeat(id: string, status: string): void {
    const prev = this.getMember(id);
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
    if (prev && prev.status === "offline" && status !== "offline") {
      const rows = this.db.prepare("SELECT id FROM work_items WHERE member_id = ? AND state = 'MORIBUND'").all(id) as Array<Record<string, unknown>>;
      for (const row of rows) this.setWorkItemStateRow(row.id as string, "IN_PROGRESS");
    }
  }

  private rowToMember(row: Record<string, unknown>): Member {
    return {
      id: row.id as string,
      name: row.name as string,
      directory: (row.directory as string) || undefined,
      metadata: row.metadata && (row.metadata as string) !== "{}" ? JSON.parse(row.metadata as string) : {},
      protocolVersion: (row.protocol_version as number) ?? undefined,
      harness: (row.harness as string) || undefined,
      harnessVersion: (row.harness_version as string) || undefined,
      status: row.status as Member["status"],
      lastHeartbeat: row.last_heartbeat as number,
    };
  }

  getMembers(): Member[] {
    const rows = this.db.prepare("SELECT * FROM members ORDER BY name").all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMember(row));
  }

  getMember(id: string): Member | null {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToMember(row);
  }

  removeMember(id: string): void {
    this.db.prepare("DELETE FROM assignments WHERE member_id = ?").run(id);
    this.db.prepare("UPDATE work_items SET member_id = NULL WHERE member_id = ?").run(id);
    this.db.prepare("DELETE FROM members WHERE id = ?").run(id);
    this.transcripts.forget(id);
    this.pairing.forget(id);
    this.sessionStats.delete(id);
  }

  /** Record an agent's session stats (context fill, session cost); stamps `at`. */
  setMemberSessionStats(id: string, stats: Omit<MemberSessionStats, "at">): void {
    this.sessionStats.set(id, { ...stats, at: Date.now() });
  }

  /** An agent's last-reported session stats, if it has reported any this session. */
  getMemberSessionStats(id: string): MemberSessionStats | undefined {
    return this.sessionStats.get(id);
  }

  /**
   * Explicitly dismiss a member (a human clicked "dismiss"): remove it AND leave
   * an in-memory tombstone so its next heartbeat is told `dismissed` (shut down),
   * not `reregister`. This is the ONLY path that makes an agent exit — a mere
   * unknown member (e.g. after a daemon restart wiped the members table) gets
   * `reregister` instead, so restarts/upgrades don't kill running teammates.
   */
  dismissMember(id: string): void {
    this.dismissedIds.add(id);
    this.removeMember(id);
  }

  /** True when `id` was explicitly dismissed (tombstoned) and not since re-registered. */
  isDismissed(id: string): boolean {
    return this.dismissedIds.has(id);
  }

  /**
   * Check all registered agents for heartbeat timeout.
   * If an agent's last heartbeat is older than agentTimeoutSeconds:
   * - Move its in-flight WorkItems to MORIBUND (the lease is kept — see
   *   docs/DESIGN.md "Reaping")
   * - Mark it offline
   * - Log a warning
   *
   * Returns the list of agent IDs that were marked offline.
   */
  reapOfflineAgents(): string[] {
    const timeoutMs = (this.config.agentTimeoutSeconds ?? 90) * 1000;
    const cutoff = Date.now() - timeoutMs;
    const reaped: string[] = [];

    const rows = this.db.prepare(
      "SELECT * FROM members WHERE status != 'offline' AND last_heartbeat < ?"
    ).all(cutoff) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const id = row.id as string;
      const name = row.name as string;
      const lastHb = row.last_heartbeat as number;
      const agoSec = Math.round((Date.now() - lastHb) / 1000);

      // Move any in-flight WorkItem to MORIBUND (the agent went quiet, but we
      // don't declare failure or hand its work to someone else — see
      // docs/DESIGN.md "Reaping"). The lease is kept; a human force-fails
      // it, or the agent reconnects and its item is restored to IN_PROGRESS.
      const inflight = this.db.prepare(
        "SELECT id FROM work_items WHERE member_id = ? AND state = 'IN_PROGRESS'"
      ).all(id) as Array<Record<string, unknown>>;
      for (const wi of inflight) this.setWorkItemStateRow(wi.id as string, "MORIBUND");
      if (inflight.length > 0) {
        console.warn(
          `⚠️  Agent "${name}" (${id}) timed out (no heartbeat for ${agoSec}s). ` +
          `${inflight.length} work item(s) marked MORIBUND.`
        );
      } else {
        console.warn(
          `⚠️  Agent "${name}" (${id}) timed out (no heartbeat for ${agoSec}s). Marked offline.`
        );
      }

      // Mark offline
      this.db.prepare("UPDATE members SET status = 'offline' WHERE id = ?").run(id);
      reaped.push(id);
    }

    return reaped;
  }

  // --- Flush to disk ---

  flushToDisk(): void {
    const dirtyTasks = this.db.prepare("SELECT * FROM tasks WHERE dirty = 1").all() as Array<Record<string, unknown>>;
    for (const row of dirtyTasks) {
      const taskFile = path.join(row.dir_path as string, "task.json");
      try {
        // Ensure task directory exists before writing
        const taskDir = path.dirname(taskFile);
        if (!existsSync(taskDir)) {
          Deno.mkdirSync(taskDir, { recursive: true });
        }
        const tokenUsage = this.getTokenUsage(row.id as string);
        const taskData: Record<string, unknown> = {
          id: row.id,
          title: row.title,
          description: row.description,
          status: row.status,
          result: row.result,
        };
        if (row.context && (row.context as string) !== "[]") {
          taskData.context = JSON.parse(row.context as string);
        }
        if (tokenUsage.length > 0) {
          taskData.tokenUsage = tokenUsage;
        }
        Deno.writeTextFileSync(taskFile, JSON.stringify(taskData, null, 2) + "\n");
      } catch {
        // Task directory may have been removed externally; skip
      }
    }
    if (dirtyTasks.length > 0) {
      this.db.prepare("UPDATE tasks SET dirty = 0 WHERE dirty = 1").run();
    }
  }

  // --- Autosave timers ---

  startTimers(): void {
    const flushMs = this.config.autosave.flushIntervalMinutes * 60 * 1000;
    this.flushTimer = setInterval(() => {
      this.flushToDisk();
      // Commit after each flush if autoCommit is enabled
      if (this.config.autosave.autoCommit) {
        this.commitToGit();
      }
    }, flushMs);

    if (this.config.autosave.autoCommit) {
      // Also run a commit on a longer interval as a safety net
      const commitMs = this.config.autosave.commitIntervalHours * 60 * 60 * 1000;
      this.commitTimer = setInterval(() => this.commitToGit(), commitMs);
    }

    // Check for offline agents every 30 seconds, then top the teammate pool back
    // up to `minTeammates` (reaping first means a lost teammate is replaced on
    // the same tick it goes offline).
    this.heartbeatCheckTimer = setInterval(() => {
      this.reapOfflineAgents();
      // Keep the active chat's markdown snapshot fresh so a crash loses minutes,
      // not the whole conversation (docs/DESIGN.md "Assistant Chat Model").
      this.refreshAssistantSnapshot();
      this.reconcileTeammatePool();
    }, 30_000);

    // Cron scheduler: enqueue due Scheduled WorkDefs, checked every 30s
    // (matching is minute-granular and deduped per minute; see cron.ts).
    this.schedulerTimer = setInterval(() => this.runScheduler(), 30_000);

    // Auto-triage sweep: one pass over the notes every `intervalMinutes`. Its own
    // timer rather than a Schedule, because a Schedule enqueues one WorkDef and a
    // sweep enqueues many (TODO.md "Auto Triage").
    const triage = resolveTriage(this.config);
    if (triage.enabled) {
      this.triageTimer = setInterval(() => this.runTriageSweep(), triage.intervalMinutes * 60 * 1000);
    }
  }

  stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.commitTimer) clearInterval(this.commitTimer);
    if (this.heartbeatCheckTimer) clearInterval(this.heartbeatCheckTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.triageTimer) clearInterval(this.triageTimer);
  }

  /** The team's config, as resolved at startup. */
  getConfig(): TeamConfig {
    return this.config;
  }

  /**
   * Whether this daemon process realizes spawns itself, or leaves them to the leader.
   *
   * Held in memory and reported via /health so `mpt doctor` can say which path is
   * live. Otherwise "the daemon can't reach tmux" would present as spawns simply not
   * happening — the class of silent failure this plan exists to remove.
   */
  private spawnCapability: { canSpawn: boolean; reason?: string; fix?: string } = { canSpawn: false, reason: "not probed" };

  setSpawnCapability(capability: { canSpawn: boolean; reason?: string; fix?: string }): void {
    this.spawnCapability = capability;
  }

  getSpawnCapability(): { canSpawn: boolean; reason?: string; fix?: string } {
    return this.spawnCapability;
  }

  // --- Team readiness (see TeamReadiness) ---

  /** Record the team's readiness (the daemon's probe, or a harness's report). */
  setTeamReadiness(ready: boolean, reason?: string): void {
    this.teamReadiness = { ready, reason: ready ? undefined : reason, at: Date.now() };
  }

  /** The last-reported readiness, or undefined if nothing has reported yet. */
  getTeamReadiness(): TeamReadiness | undefined {
    return this.teamReadiness;
  }

  /** With no report yet, the team is treated as ready. */
  private isTeamReady(): boolean {
    return this.teamReadiness ? this.teamReadiness.ready : true;
  }

  /**
   * Should the cron scheduler enqueue right now?
   *
   * Gating exists so a machine that is connected but *unable* (e.g. expired
   * credentials) doesn't turn an overnight cron into a pile of FAILED runs. Two
   * conditions, both deliberate:
   *
   *   - **No agents online → allow.** That is not a readiness problem; the queue
   *     has always simply waited for an agent to connect. Readiness gating is
   *     about connected-but-unable, not absent.
   *   - **Otherwise → the team's last report**, defaulting to ready.
   *
   * This used to roll directory-affinity tiers up to the set of *hosts* that could
   * run an item and hold only when every one of them was not-ready. With one host
   * (P1c) readiness is a single team-level fact, so the rollup is gone — the
   * observable behaviour is unchanged, because the rollup always resolved to the
   * one host anyway.
   */
  private canScheduleNow(): boolean {
    const anyOnline = this.getMembers().some((m) => m.status !== "offline");
    if (!anyOnline) return true;
    return this.isTeamReady();
  }

  /**
   * Enqueue a WorkItem for every Scheduled WorkDef whose cron is due now (and
   * that isn't already in flight). Stamps `lastEnqueuedAt` for per-minute dedupe.
   *
   * Readiness gating (see docs/ARCHITECTURE.md): a due child whose target host
   * is not ready is *held* rather than enqueued, and the schedule is flagged
   * `heldForReadiness` so it re-attempts every tick (independent of the cron
   * window) until the host recovers — firing exactly one catch-up run instead of
   * a per-occurrence backlog.
   */
  runScheduler(now: Date = new Date()): void {
    // Group WorkDefs by their schedule parent (skip archived ones).
    const childrenBySchedule = new Map<string, WorkDef[]>();
    for (const def of listWorkDefs(this.teamDir)) {
      if (def.parent?.kind !== "schedule") continue;
      if (def.status === "archived") continue;
      const arr = childrenBySchedule.get(def.parent.id) || [];
      arr.push(def);
      childrenBySchedule.set(def.parent.id, arr);
    }
    for (const sched of listSchedules(this.teamDir)) {
      const due = isCronDue(sched.cron, now, sched.lastEnqueuedAt);
      const held = sched.heldForReadiness === true;
      // A schedule is worked either when its cron fires, or when it has work held
      // back for readiness that we keep retrying until the host recovers.
      if (!due && !held) continue;

      let anyHeld = false;
      for (const def of childrenBySchedule.get(sched.id) || []) {
        if (this.getActiveWorkItemForRef({ workDefId: def.id })) continue;
        if (!this.canScheduleNow()) { anyHeld = true; continue; }
        this.enqueueFor(def.id);
      }

      const patch: { lastEnqueuedAt?: string; heldForReadiness?: boolean } = {};
      // Advance the cron cursor only for a genuine cron firing (dedupes within
      // the minute). Recovery of held work is driven by `heldForReadiness`, not
      // the cron window, so a job held past its minute still fires once on recovery.
      if (due) patch.lastEnqueuedAt = now.toISOString();
      if (anyHeld !== held) patch.heldForReadiness = anyHeld;
      if (patch.lastEnqueuedAt !== undefined || patch.heldForReadiness !== undefined) {
        updateSchedule(this.teamDir, sched.id, patch);
      }
    }
  }

  // --- Auto triage (TODO.md "Auto Triage") ---
  //
  // A note is a WorkDef parent: its triage WorkDef is an empty container that owns
  // the thread, and the prompt is built from the note's *current* text at claim
  // time. The turn rule (only a content edit is the author's turn) is in
  // daemon/triage.ts; the note's frontmatter holds the version last handed over.

  /**
   * One triage pass over the notes: enqueue a WorkItem for every note whose text
   * has moved on since its last analysis. Returns the items enqueued.
   *
   * Every non-archived, non-empty note is eligible and there is no per-sweep cap,
   * so the first sweep after enabling triage covers the whole board (Decisions 1–2).
   */
  runTriageSweep(now: number = Date.now()): WorkItem[] {
    const { enabled, quietMinutes } = resolveTriage(this.config);
    if (!enabled) return [];
    const out: WorkItem[] = [];
    for (const note of this.getThoughts("active")) {
      if (!isTriageDue({ note, inFlight: this.hasTriageInFlight(note.id), now, quietMinutes })) continue;
      const item = this.enqueueTriage(note.id);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * Enqueue a triage run for one note now, skipping the quiet period and the
   * "unchanged" rule — this is the **Triage now** button, and the only way to
   * retry a note whose last run failed (its version was already stamped).
   * Refuses only when a run is already in flight, or the note can't be triaged.
   */
  triageNow(thoughtId: string): { ok: true; workItem: WorkItem } | { ok: false; error: string } {
    const note = this.getThought(thoughtId);
    if (!note) return { ok: false, error: `Thought "${thoughtId}" not found` };
    const reason = triageSkipReason({ note, inFlight: this.hasTriageInFlight(thoughtId), now: 0, quietMinutes: 0 });
    // "unchanged"/"too-fresh" are what this button exists to override.
    if (reason === "archived") return { ok: false, error: "An archived note isn't triaged" };
    if (reason === "empty") return { ok: false, error: "An empty note has nothing to triage" };
    if (reason === "in-flight") return { ok: false, error: "This note is already being triaged" };
    const item = this.enqueueTriage(thoughtId);
    return item ? { ok: true, workItem: item } : { ok: false, error: "Could not enqueue triage" };
  }

  /** Why the sweep would skip this note right now (null = it's due). */
  triageStatusFor(thoughtId: string, now: number = Date.now()): TriageSkipReason | null {
    const note = this.getThought(thoughtId);
    if (!note) return "archived";
    const { quietMinutes } = resolveTriage(this.config);
    return triageSkipReason({ note, inFlight: this.hasTriageInFlight(thoughtId), now, quietMinutes });
  }

  /** A note's triage WorkDef, created on first use (never for a note that's never analysed). */
  ensureTriageWorkDef(thoughtId: string): WorkDef | null {
    const note = this.getThought(thoughtId);
    if (!note) return null;
    const id = triageWorkDefId(thoughtId);
    const existing = getWorkDef(this.teamDir, id);
    if (existing) {
      // A note un-archived after its WorkDef was archived: bring it back.
      if (existing.status === "archived" && note.status === "active") {
        return updateWorkDef(this.teamDir, id, { status: "active" });
      }
      return existing;
    }
    // Authored content only, and there is none: the instructions live in
    // triage.md and the note's text is injected at claim time.
    return saveWorkDef(this.teamDir, {
      id,
      title: triageWorkDefTitle(thoughtId),
      parent: { kind: "thought", id: thoughtId },
      goal: "",
      acceptanceCriteria: "",
    });
  }

  /** Is a triage run for this note queued or running? */
  private hasTriageInFlight(thoughtId: string): boolean {
    return this.getActiveWorkItemForRef({ workDefId: triageWorkDefId(thoughtId) }) !== null;
  }

  /**
   * Create the WorkDef if needed, enqueue a WorkItem, and stamp the note with the
   * version handed over. Stamping **at enqueue** is what makes an edit during a
   * run survive (it lands after the stamp, so the note is due again) and a failed
   * run not retry every sweep.
   */
  private enqueueTriage(thoughtId: string): WorkItem | null {
    const note = this.getThought(thoughtId);
    if (!note) return null;
    if (!this.ensureTriageWorkDef(thoughtId)) return null;
    const item = this.enqueueFor(triageWorkDefId(thoughtId));
    if (!item) return null;
    const fresh = ioGetThought(this.teamDir, thoughtId);
    if (fresh) {
      fresh.triagedVersion = fresh.updatedAt;
      writeThought(this.teamDir, fresh);
    }
    return item;
  }

  /**
   * The team's triage instructions (`triage.md`), or undefined when it has none —
   * the prompt builder then uses its built-in default. One file for the team, so
   * changing how triage works is one edit rather than one per note.
   */
  getTriageInstructions(): string | undefined {
    const file = path.join(this.teamDir, TRIAGE_INSTRUCTIONS_FILE);
    try {
      if (!existsSync(file)) return undefined;
      const content = Deno.readTextFileSync(file);
      return content.trim() ? content : undefined;
    } catch {
      return undefined;
    }
  }

  /** Write `triage.md` (empty clears it, restoring the built-in default). */
  setTriageInstructions(content: string): void {
    const file = path.join(this.teamDir, TRIAGE_INSTRUCTIONS_FILE);
    if (content.trim() === "") {
      try { Deno.removeSync(file); } catch { /* already absent */ }
      return;
    }
    Deno.writeTextFileSync(file, content.endsWith("\n") ? content : content + "\n");
  }

  commitToGit(message?: string): void {
    commitTeamDir(this.teamDir, this.config.autosave, message);
  }

  // --- Transition Instructions ---

  /**
   * The persona for an agent state: the markdown file `workflows/<wf>/<state>.md`
   * (the former "state instructions" — same storage, same editing API). Injected
   * into the claim prompt as the worker's role framing for that state.
   */
  getStatePersona(workflowName: string | undefined, state: string): string | undefined {
    const wfName = workflowName || this.config.defaultWorkflow;
    return this.readInstructionFile(wfName, `${state}.md`);
  }

  /** Read an instruction file from the workflow's directory */
  private readInstructionFile(workflowName: string, filename: string): string | undefined {
    const filePath = path.join(this.teamDir, "workflows", workflowName, filename);
    const cacheKey = workflowName + "/" + filename;

    const cached = this.transitionInstructionsCache.get(cacheKey);
    if (cached) {
      try {
        const stat = Deno.statSync(filePath);
        const mtime = stat.mtime?.getTime() ?? 0;
        if (mtime === cached.mtime && Date.now() - cached.cachedAt < this.transitionCacheTTL) {
          return cached.content;
        }
      } catch {
        this.transitionInstructionsCache.delete(cacheKey);
        return undefined;
      }
    }

    try {
      if (!existsSync(filePath)) return undefined;
      const content = Deno.readTextFileSync(filePath);
      const stat = Deno.statSync(filePath);
      const mtime = stat.mtime?.getTime() ?? 0;
      this.transitionInstructionsCache.set(cacheKey, { content, mtime, cachedAt: Date.now() });
      return content;
    } catch {
      return undefined;
    }
  }

  // --- Archive ---

  /** Build the archive SYNOPSIS markdown for a story (stored inline in the
   * flat archived json). */
  private buildSynopsis(story: Story, tasks: TaskWithMeta[], archivedAt: string): string {
    const date = archivedAt.split("T")[0];
    const lines: string[] = [
      `# ${story.title}`,
      "",
      `**Archived**: ${date}`,
      `**ID**: ${story.id}`,
      "",
      "## Description",
      "",
      story.description,
      "",
      "## Tasks",
      "",
    ];
    for (const task of tasks) lines.push(`- ${task.title}`);
    lines.push("");
    return lines.join("\n");
  }

  /**
   * Remove a task's live data from SQLite (assignments, comments, task row).
   * Token usage is deliberately kept: it's a ledger of spend that happened, and
   * archiving/backlogging a story used to erase it from all history
   * (store/usage.ts).
   */
  private removeTaskData(taskId: string): void {
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM comments WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM comments_loaded WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  }

  /** Remove a story and all its tasks from SQLite (does not touch disk) */
  private removeStoryFromDb(storyId: string): void {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      const tasks = this.getTasksForStory(storyId);
      for (const task of tasks) {
        this.removeTaskData(task.id);
      }
      this.db.prepare("DELETE FROM stories WHERE id = ?").run(storyId);
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  /** Delete a story and all its tasks, removing from SQLite and disk */
  deleteStory(storyId: string): boolean {
    const story = this.getStory(storyId);
    if (!story) return false;

    const tasks = this.getTasksForStory(storyId);
    const activeTasks = tasks.filter((t) => !!this.getAssignment(t.id));
    if (activeTasks.length > 0) {
      throw new Error(`Cannot delete story "${storyId}": ${activeTasks.length} task(s) are currently assigned`);
    }

    // Delete the story's child task WorkDefs (tasks/<id>/), then the flat story
    // file (stories/<id>.json), then its SQLite rows.
    for (const t of tasks) deleteWorkDef(this.teamDir, t.id);
    this.removeStoryFromDb(storyId);
    const file = this.storyFile(storyId);
    if (existsSync(file)) Deno.removeSync(file);

    return true;
  }

  isStoryArchivable(storyId: string): boolean {
    const tasks = this.getTasksForStory(storyId);
    if (tasks.length === 0) return false;
    return tasks.every((t) => t.status === DONE_STATE);
  }

  archiveStory(storyId: string): void {
    if (!this.isStoryArchivable(storyId)) {
      throw new Error(`Cannot archive story "${storyId}": not all tasks are done`);
    }

    const story = this.getStory(storyId);
    if (!story) throw new Error(`Story "${storyId}" not found`);

    const archivedDir = path.join(this.teamDir, "archived");
    Deno.mkdirSync(archivedDir, { recursive: true });
    const archivedAt = new Date().toISOString();
    const tasks = this.getTasksForStory(storyId);

    // Flat model: write archived/<id>.json (story fields + archivedAt + an
    // inline synopsis). The child task WorkDefs stay in tasks/ (hidden once the
    // story leaves stories/); getArchivedStoryContext reads them back by id.
    const src = this.storyFile(storyId);
    const data = existsSync(src)
      ? JSON.parse(Deno.readTextFileSync(src)) as Record<string, unknown>
      : serializeStory(story) as unknown as Record<string, unknown>;
    data.archivedAt = archivedAt;
    data.synopsis = this.buildSynopsis(story, tasks, archivedAt);
    Deno.writeTextFileSync(path.join(archivedDir, `${storyId}.json`), JSON.stringify(data, null, 2) + "\n");
    if (existsSync(src)) Deno.removeSync(src);

    this.removeStoryFromDb(storyId);
  }

  getArchivedStories(): Array<{ id: string; title: string; synopsis: string }> {
    const archivedDir = path.join(this.teamDir, "archived");
    if (!existsSync(archivedDir)) return [];

    const results: Array<{ id: string; title: string; synopsis: string }> = [];
    for (const entry of Deno.readDirSync(archivedDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(Deno.readTextFileSync(path.join(archivedDir, entry.name)));
        results.push({ id: data.id, title: data.title, synopsis: data.synopsis || data.description || "" });
      } catch { /* skip malformed */ }
    }
    return results;
  }

  getArchivedStoryContext(storyId: string): { story: Record<string, unknown>; tasks: Record<string, unknown>[]; comments: Record<string, Comment[]> } | null {
    const file = path.join(this.teamDir, "archived", `${storyId}.json`);
    if (!existsSync(file)) return null;

    const story = JSON.parse(Deno.readTextFileSync(file));
    const tasks: Record<string, unknown>[] = [];
    const comments: Record<string, Comment[]> = {};

    // The archived story lists its task ids; their WorkDefs + comments still
    // live under tasks/<id>/ (flat model doesn't move them on archive).
    for (const t of (story.tasks as Array<{ id: string; status: string }> | undefined) ?? []) {
      const def = getWorkDef(this.teamDir, t.id);
      if (def) tasks.push({ id: def.id, title: def.title, goal: def.goal, acceptanceCriteria: def.acceptanceCriteria, status: t.status });
      const commentsFile = path.join(workDefDir(this.teamDir, t.id), "comments.jsonl");
      if (existsSync(commentsFile)) {
        const lines = Deno.readTextFileSync(commentsFile).split("\n").filter(Boolean);
        comments[t.id] = lines.map((line: string) => JSON.parse(line) as Comment);
      }
    }

    return { story, tasks, comments };
  }

  /** Resolve the effective workflow for a story (story override → defaultWorkflow) */
  getWorkflowForStory(storyId: string): WorkflowConfig {
    const story = this.getStory(storyId);
    const workflowName = story?.workflow || this.config.defaultWorkflow;
    return this.workflows[workflowName] || this.workflows[this.config.defaultWorkflow]!;
  }

  /** Resolve the effective workflow for a task (via its parent story) */
  getWorkflowForTask(taskId: string): WorkflowConfig {
    const task = this.getTask(taskId);
    if (!task) return this.workflows[this.config.defaultWorkflow]!;
    return this.getWorkflowForStory(task.storyId);
  }

  // --- Backlog ---

  /**
   * Move a story to the backlog. Also moves any stories that depend on it
   * (transitively) to prevent broken dependency chains on the active board.
   */
  moveToBacklog(storyId: string): string[] {
    const story = this.getStory(storyId);
    if (!story) throw new Error(`Story "${storyId}" not found`);

    const tasks = this.getTasksForStory(storyId);
    const activeTasks = tasks.filter((t) => !!this.getAssignment(t.id));
    if (activeTasks.length > 0) {
      throw new Error(`Cannot backlog story "${storyId}": ${activeTasks.length} task(s) are currently assigned`);
    }

    const toMove = this.getDependentStoriesTransitive(storyId);
    toMove.unshift(storyId);

    const backlogDir = path.join(this.teamDir, "backlog");
    Deno.mkdirSync(backlogDir, { recursive: true });

    for (const id of toMove) {
      const src = this.storyFile(id);
      if (!existsSync(src)) continue;
      const data = JSON.parse(Deno.readTextFileSync(src)) as Record<string, unknown>;
      data.backloggedAt = new Date().toISOString();
      Deno.writeTextFileSync(path.join(backlogDir, `${id}.json`), JSON.stringify(data, null, 2) + "\n");
      Deno.removeSync(src);
      this.removeStoryFromDb(id);
    }

    return toMove;
  }

  /** Move a story from backlog back to active stories. */
  moveFromBacklog(storyId: string): void {
    const src = path.join(this.teamDir, "backlog", `${storyId}.json`);
    if (!existsSync(src)) {
      throw new Error(`Story "${storyId}" not found in backlog`);
    }
    const data = JSON.parse(Deno.readTextFileSync(src)) as Record<string, unknown>;
    delete data.backloggedAt;
    Deno.mkdirSync(path.join(this.teamDir, STORIES_DIR), { recursive: true });
    Deno.writeTextFileSync(this.storyFile(storyId), JSON.stringify(data, null, 2) + "\n");
    Deno.removeSync(src);
    this.loadFromDisk();
  }

  /** Get all stories in the backlog */
  getBacklogStories(): Array<{ id: string; title: string; description: string; dependsOn: string[]; backloggedAt?: string }> {
    const backlogDir = path.join(this.teamDir, "backlog");
    if (!existsSync(backlogDir)) return [];

    const results: Array<{ id: string; title: string; description: string; dependsOn: string[]; backloggedAt?: string }> = [];
    for (const entry of Deno.readDirSync(backlogDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(Deno.readTextFileSync(path.join(backlogDir, entry.name)));
        results.push({
          id: data.id,
          title: data.title,
          description: data.description || "",
          dependsOn: data.dependsOn || [],
          backloggedAt: data.backloggedAt,
        });
      } catch { /* skip malformed */ }
    }
    return results;
  }

  /** Find all stories that transitively depend on the given story */
  private getDependentStoriesTransitive(storyId: string): string[] {
    const allStories = this.getStories();
    const result: string[] = [];
    const visited = new Set<string>();

    const findDependents = (id: string) => {
      for (const s of allStories) {
        if (s.dependsOn.includes(id) && !visited.has(s.id)) {
          visited.add(s.id);
          result.push(s.id);
          findDependents(s.id);
        }
      }
    };

    findDependents(storyId);
    return result;
  }

  // --- Assistant Conversation (chat v2) ---
  //
  // Delegated to store/assistant-chat.ts. The daemon mirrors the agent's Pi
  // session: user messages are queued for the extension to hand to Pi, and the
  // agent's own prose is mirrored back as bubbles. There are no response turns
  // and the composer never locks. See docs/DESIGN.md "Assistant Chat Model".

  /** Subscribe to chat events for the SSE stream. Returns an unsubscribe fn. */
  subscribeAssistantEvents(fn: (event: AssistantEvent) => void): () => void {
    return this.chat.subscribe(fn);
  }

  /** Messages for one session (defaults to the active session), oldest first. */
  getAssistantMessages(sessionId?: string): AssistantMessage[] {
    return this.chat.getMessages(sessionId);
  }

  getAssistantMessage(id: string): AssistantMessage | null {
    return this.chat.getMessage(id);
  }

  /**
   * Append a user message. Always succeeds (the composer never blocks) and
   * creates the active session on demand under the current persona.
   */
  appendUserMessage(content: string, opts: { replyTo?: string | null; origin?: AssistantOrigin } = {}): AssistantMessage {
    return this.chat.appendUserMessage(content, {
      personaId: this.getAssistantPersonaId(),
      replyTo: opts.replyTo ?? null,
      origin: opts.origin,
    });
  }

  /** Mirror one bubble of the agent's reply into the chat. */
  appendAssistantMessage(content: string, failed = false): AssistantMessage {
    return this.chat.appendAssistantBubble(content, { personaId: this.getAssistantPersonaId(), failed });
  }

  deleteAssistantMessage(id: string): boolean {
    return this.chat.deleteMessage(id);
  }

  // --- Assistant inbox (agent-facing) ---

  /** User messages not yet handed to Pi, oldest first. */
  getAssistantInbox(): InboxMessage[] {
    return this.chat.getInbox();
  }

  /** Advance delivery receipts (queued -> delivered -> read). */
  ackAssistantInbox(ids: string[], state: AssistantDelivery): number {
    return this.chat.ackInbox(ids, state);
  }

  /** Mark everything already handed to Pi as read (a run just started). */
  markAssistantDeliveredAsRead(): number {
    return this.chat.markDeliveredAsRead();
  }

  // --- Assistant thoughts (ephemeral peek buffer) ---

  setAssistantThinking(active: boolean): void {
    this.chat.setThinking(active);
  }

  appendAssistantThought(chunk: string): void {
    this.chat.appendThought(chunk);
  }

  clearAssistantThoughts(): void {
    this.chat.clearThoughts();
  }

  getAssistantThoughts(): { chunks: string[]; updatedAt: string | null; thinking: boolean } {
    return this.chat.getThoughts();
  }

  isAssistantThinking(): boolean {
    return this.chat.isThinking();
  }

  // --- Assistant sessions ---

  getActiveAssistantSession(): AssistantSession | null {
    return this.chat.getActiveSession();
  }

  getAssistantSession(id: string): AssistantSession | null {
    return this.chat.getSession(id);
  }

  listAssistantSessions(): AssistantSession[] {
    return this.chat.listSessions();
  }

  getAssistantSessionSnapshot(id: string): string | null {
    return this.chat.getSnapshot(id);
  }

  /** Record the Pi session file backing the active chat (enables resume). */
  reportAssistantPiSession(piSessionPath: string): AssistantSession {
    return this.chat.reportPiSession(piSessionPath, this.getAssistantPersonaId());
  }

  /**
   * Start a fresh chat: snapshot + end the active session, open a new one, and
   * ask the assistant to roll its Pi session so in-agent context matches.
   */
  newAssistantSession(notice?: string): AssistantSession {
    const session = this.chat.newSession(this.getAssistantPersonaId(), notice);
    this.directAssistantSession("new-session", {});
    return session;
  }

  /**
   * Resume an earlier session: snapshot + end the active one, reopen the target,
   * and ask the assistant to switch its Pi session to the recorded file.
   */
  resumeAssistantSession(id: string): AssistantSession | null {
    const target = this.chat.getSession(id);
    if (!target) return null;
    const session = this.chat.resumeSession(id);
    this.directAssistantSession("resume-session", { piSessionPath: target.piSessionPath, sessionId: id });
    return session;
  }

  /** Refresh the active session's snapshot when stale (periodic safety net). */
  refreshAssistantSnapshot(force = false): void {
    this.chat.refreshActiveSnapshot(force);
  }

  // --- Settings (simple daemon-wide key/value) ---

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      return;
    }
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  // --- Assistant persona ---
  //
  // The assistant's active "persona" is a context-library entry id whose body is
  // injected as the assistant's system prompt (by the extension). Stored as a
  // single setting; null means the plain/default assistant.

  getAssistantPersonaId(): string | null {
    return this.getSetting("assistant_persona");
  }

  setAssistantPersonaId(id: string | null): void {
    this.setSetting("assistant_persona", id);
  }

  /**
   * Ask any online assistant to act on its Pi session. The daemon expresses
   * intent (`new-session`, `resume-session`) and never the mechanism — the
   * extension realizes it with `ctx.newSession()` / `ctx.switchSession()`
   * (docs/DESIGN.md "Assistant Chat Model"). Replaces the old `reset-session` keystroke
   * path for the assistant; teammates still use that.
   */
  private directAssistantSession(action: string, params: Record<string, unknown>): void {
    const agent = this.getLeader();
    if (agent) this.createLeaderDirectiveForMember(agent.id, action, params);
  }

  /**
   * The online leader, which is the agent that answers the chat.
   *
   * This used to *designate* one leader as the chat agent and keep that choice
   * sticky, because a multi-host team ran several leaders and they would otherwise
   * all pull the same message and answer it in parallel. With one leader (P1c)
   * there is nothing to designate — which is DESIGN.md's "One Agent to Talk To"
   * becoming literally true rather than arranged.
   */
  getLeader(): Member | null {
    return this.getMembers().find((m) => m.status !== "offline" && m.name.includes(LEADER_MEMBER_NAME)) ?? null;
  }

  /** True when `agentId` is the leader — only it may drain the chat inbox. */
  isLeader(agentId: string): boolean {
    return this.getLeader()?.id === agentId;
  }

  // --- Leader Directives (things asked of the leader; it realizes them) ---
  //
  // A single queue of directives per host: "leader, do X about an agent" — e.g.
  // spawn a new agent, or reset an existing one's session. The daemon expresses
  // the action + params (intent) and never knows the mechanism (tmux, etc.).
  // The leader polls its host's directives, acts, and marks them done.

  private rowToDirective(row: Record<string, unknown>): { id: string; action: string; memberId?: string; params: Record<string, unknown>; metadata: Record<string, unknown>; status: string; createdAt: string } {
    const memberId = (row.member_id as string) || undefined;
    // For actions on an existing member, include its opaque metadata so the
    // leader can deliver (e.g. the tmux window it supplied at registration).
    const member = memberId ? this.getMember(memberId) : null;
    return {
      id: row.id as string,
      action: row.action as string,
      memberId,
      params: row.params && (row.params as string) !== "{}" ? JSON.parse(row.params as string) : {},
      metadata: member?.metadata || {},
      status: row.status as string,
      createdAt: new Date(row.created_at as number).toISOString(),
    };
  }

  /**
   * Create a leader directive for a host. For the `spawn` action a unique
   * generated adjective-noun name is assigned into params (unless one was
   * supplied).
   *
   * Identity is daemon-owned state (DESIGN.md "the daemon coordinates; harnesses
   * execute"), so the daemon names spawns rather than letting the harness invent
   * one. Every spawn is a teammate: the chat is answered by the leader, so there
   * is no reserved singleton name and no coalescing.
   */
  createLeaderDirective(action: string, opts?: { memberId?: string; params?: Record<string, unknown> }): ReturnType<Store["rowToDirective"]> {
    const id = `dir-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const params: Record<string, unknown> = { ...(opts?.params || {}) };
    if (action === "spawn" && !params.name) params.name = this.generateSpawnName();
    this.db.prepare(
      "INSERT INTO leader_directives (id, action, member_id, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
    ).run(id, action, opts?.memberId || null, JSON.stringify(params), now, now);
    return this.rowToDirective(this.db.prepare("SELECT * FROM leader_directives WHERE id = ?").get(id) as Record<string, unknown>);
  }

  /** Create a directive targeting an existing member. Null if the member is unknown. */
  createLeaderDirectiveForMember(memberId: string, action: string, params?: Record<string, unknown>): ReturnType<Store["rowToDirective"]> | null {
    const member = this.getMember(memberId);
    if (!member) return null;
    return this.createLeaderDirective(action, { memberId, params });
  }

  /**
   * Pending directives for a host's *leader*, oldest first, each resolved with
   * target metadata. Self-handled actions are excluded: the leader realizes
   * intents by driving tmux, but a `new-session`/`resume-session` ask has to be
   * executed *inside* the target agent (`ctx.newSession()` / `ctx.switchSession()`),
   * so the agent polls those itself via `getMemberDirectives`. Without this
   * filter the leader would consume and complete them, and the agent would never
   * see them. See docs/DESIGN.md "Assistant Chat Model".
   */
  getLeaderDirectives(): Array<ReturnType<Store["rowToDirective"]>> {
    const rows = this.db.prepare("SELECT * FROM leader_directives WHERE status = 'pending' ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDirective(r)).filter((d) => !SELF_HANDLED_ACTIONS.has(d.action));
  }

  /** Pending directives an agent must realize itself, oldest first. */
  getMemberDirectives(memberId: string): Array<ReturnType<Store["rowToDirective"]>> {
    const rows = this.db.prepare(
      "SELECT * FROM leader_directives WHERE member_id = ? AND status = 'pending' ORDER BY created_at ASC",
    ).all(memberId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDirective(r)).filter((d) => SELF_HANDLED_ACTIONS.has(d.action));
  }

  /**
   * All pending `spawn` directives across every host, oldest first.
   *
   * Surfaced in the UI so a stuck spawn request (e.g. one whose leader never
   * acked completion) is visible and can be cancelled, rather than silently
   * driving the leader to retry forever.
   */
  getPendingSpawnRequests(): Array<{ id: string; name: string | null; cwd: string | null; createdAt: string }> {
    const rows = this.db.prepare(
      "SELECT id, params, created_at FROM leader_directives WHERE action = 'spawn' AND status = 'pending' ORDER BY created_at ASC"
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse((row.params as string) || "{}"); } catch { /* ignore */ }
      return {
        id: row.id as string,
        name: typeof params.name === "string" ? params.name : null,
        cwd: typeof params.cwd === "string" ? params.cwd : null,
        createdAt: new Date(row.created_at as number).toISOString(),
      };
    });
  }

  getLeaderDirective(id: string): ReturnType<Store["rowToDirective"]> | null {
    const row = this.db.prepare("SELECT * FROM leader_directives WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToDirective(row) : null;
  }

  /** Update a directive's status (e.g. 'done'). Returns false if not found. */
  updateLeaderDirective(id: string, status: string, error?: string): boolean {
    const row = this.db.prepare("SELECT id FROM leader_directives WHERE id = ?").get(id);
    if (!row) return false;
    this.db.prepare("UPDATE leader_directives SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, Date.now(), id);
    return true;
  }

  /**
   * Spawn directives that failed, newest first, with the reason.
   *
   * Surfaced in the UI beside pending spawns. Before the daemon realized spawns, a
   * failure was the leader's to report; now it is the daemon's, and an unreported
   * failure would look exactly like a team that simply never grew.
   */
  getFailedSpawnRequests(): Array<{ id: string; name: string | null; cwd: string | null; error: string | null; at: string }> {
    const rows = this.db.prepare(
      "SELECT id, params, error, updated_at FROM leader_directives WHERE action = 'spawn' AND status = 'failed' ORDER BY updated_at DESC",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const params = row.params && (row.params as string) !== "{}" ? JSON.parse(row.params as string) : {};
      return {
        id: row.id as string,
        name: (params.name as string) ?? null,
        cwd: (params.cwd as string) ?? null,
        error: (row.error as string) ?? null,
        at: new Date(row.updated_at as number).toISOString(),
      };
    });
  }

  /** Generate a unique teammate name (avoids current members + pending spawn directives). */
  private generateSpawnName(): string {
    const existingNames = new Set<string>();
    for (const m of this.getMembers()) existingNames.add(m.name);
    const pending = this.db.prepare("SELECT params FROM leader_directives WHERE action = 'spawn' AND status = 'pending'").all() as Array<Record<string, unknown>>;
    for (const row of pending) {
      try {
        const p = JSON.parse((row.params as string) || "{}");
        if (p.name) existingNames.add(p.name);
      } catch { /* ignore */ }
    }
    return generateTeammateName(existingNames, this.config.teammates);
  }

  // --- Teammate pool (declared size, not clicked-into-existence) ---
  //
  // `minTeammates` is the team's *declared* size: the daemon keeps at least that
  // many generalist teammates online and reconciles the shortfall itself by
  // queueing `spawn` directives. A teammate that is dismissed, crashes, or is
  // reaped offline is therefore replaced automatically. Nothing scales the pool
  // *down*: the daemon never dismisses a teammate (that stays a human act), so
  // lowering the number just stops replacements.

  /** Pending `spawn` directives for pool teammates. */
  private countPendingTeammateSpawns(): number {
    // Every pending spawn is a teammate: retired assistant spawns are cancelled at
    // boot (cancelRetiredDirectives).
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM leader_directives WHERE action = 'spawn' AND status = 'pending'").get() as { n: number };
    return row.n;
  }

  /**
   * Is a leader connected? The pool reconciler waits for one (see
   * reconcileTeammatePool for why — it is no longer because only a leader can
   * realize a spawn).
   *
   * This was `pickPoolSpawnHost()`, returning the host a spawn should land on —
   * but it only ever found *the* leader and returned its host, which is why P1c
   * could drop multi-host without changing behaviour (docs/DESIGN.md "One Host, One Leader").
   */
  private isLeaderOnline(): boolean {
    return this.getMembers().some((m) =>
      m.status !== "offline" && m.name.toLowerCase().includes(LEADER_MEMBER_NAME)
    );
  }

  /** The pool's live state: what's declared, what's online, what's inbound. */
  getTeammatePool(): { minTeammates: number; isDefault: boolean; maxTeammates: number; online: number; pending: number; leaderPresent: boolean } {
    const online = this.getMembers().filter((m) => m.status !== "offline" && isPoolTeammate(m.name)).length;
    return {
      minTeammates: resolveMinTeammates(this.config),
      // True while no size has been declared (the value tracks maxTeammates / 2).
      isDefault: this.config.minTeammates === undefined,
      maxTeammates: this.config.maxTeammates ?? 0,
      online,
      pending: this.countPendingTeammateSpawns(),
      leaderPresent: this.isLeaderOnline(),
    };
  }

  /**
   * Declare the pool's minimum size: persists it to config.json (so it survives
   * a restart and is applied at startup) and reconciles immediately. Returns the
   * clamped value actually stored, or null if `n` isn't a non-negative integer.
   * Passing `null` clears the declaration, reverting to the default (half of
   * maxTeammates) and returning that effective value.
   */
  setMinTeammates(n: number | null): number | null {
    if (n === null) {
      delete this.config.minTeammates;
    } else {
      if (!Number.isInteger(n) || n < 0) return null;
      const max = this.config.maxTeammates ?? 0;
      this.config.minTeammates = max > 0 ? Math.min(n, max) : n;
    }
    this.saveConfig();
    this.reconcileTeammatePool();
    return resolveMinTeammates(this.config);
  }

  /**
   * Top the teammate pool back up to `minTeammates`. Counts online teammates
   * plus not-yet-realized spawn requests (so a slow leader doesn't get a second
   * batch), caps the target at `maxTeammates`, and waits for an online leader.
   * Returns how many spawn directives were queued.
   *
   * **The team starts when its leader does**, even when the daemon could realize
   * the spawns itself. The daemon often runs as a login service, so without this
   * every login would open `minTeammates` agent windows before anyone ran
   * `mpt lead` — agents nobody can chat with, reset (the leader types `/new`), or
   * see coming. `mpt lead` is the "start the team" step. An explicit one-off spawn
   * (the Spawn dialog) is a human asking now, and isn't held.
   *
   * Called on the heartbeat timer (right after offline agents are reaped, so a
   * lost teammate is replaced within one tick) and whenever the number changes.
   */
  reconcileTeammatePool(): number {
    const target = resolveMinTeammates(this.config);
    if (target <= 0) return 0;

    const { online, pending } = this.getTeammatePool();
    const deficit = target - (online + pending);
    if (deficit <= 0) return 0;

    // Waits for the leader even when the daemon can spawn (see above).
    if (!this.isLeaderOnline()) return 0;

    for (let i = 0; i < deficit; i++) {
      this.createLeaderDirective("spawn", { params: { reason: "teammate" } });
    }
    return deficit;
  }

  /**
   * Persist the mutable parts of the in-memory config to `config.json`. The
   * single writer, so no caller can accidentally drop a field it didn't know
   * about (see serializeConfig).
   */
  saveConfig(): void {
    Deno.writeTextFileSync(
      path.join(this.teamDir, CONFIG_FILE),
      JSON.stringify(serializeConfig(this.config), null, 2) + "\n",
    );
  }

  // --- WorkDefs + Schedules (see store/workdefs.ts, store/schedules.ts) ---

  getWorkDefs(status?: string): WorkDef[] {
    let all = listWorkDefs(this.teamDir);
    if (status === "active" || status === "archived") all = all.filter((d) => (d.status || "active") === status);
    return all;
  }

  getWorkDef(id: string): WorkDef | null {
    return getWorkDef(this.teamDir, id);
  }

  /** Create a WorkDef; when `enqueue` (default), also enqueue a READY WorkItem. */
  createWorkDef(input: {
    title: string; parent?: WorkDefParent; goal: string; acceptanceCriteria: string;
    additionalContext?: string; contextRefs?: string[]; directory?: string;
  }, enqueue = true): WorkDef {
    const def = saveWorkDef(this.teamDir, {
      ...input,
      directory: input.directory ? normalizeDirectory(input.directory) : undefined,
    });
    if (enqueue) this.enqueueWorkDef(def.id);
    return def;
  }

  updateWorkDefDetails(id: string, updates: {
    title?: string; parent?: WorkDefParent | null; goal?: string; acceptanceCriteria?: string;
    additionalContext?: string | null; contextRefs?: string[] | null; directory?: string | null;
  }): WorkDef | null {
    const def = updateWorkDef(this.teamDir, id, {
      ...updates,
      directory: updates.directory !== undefined ? (updates.directory ? normalizeDirectory(updates.directory) : null) : undefined,
    });
    // A board task is a WorkDef whose fields are cached in the `tasks` table
    // (what /api/stories reads). Keep that cache in sync so an edit through the
    // WorkDef path is reflected on the board without waiting for a reload.
    if (def && this.getTask(id)) {
      this.db.prepare("UPDATE tasks SET title = ?, description = ?, context = ?, dirty = 1 WHERE id = ?")
        .run(def.title, def.goal, JSON.stringify(def.contextRefs || []), id);
    }
    return def;
  }

  deleteWorkDef(id: string): boolean {
    // Cancel any active WorkItem for this def, then remove it from disk.
    const active = this.getActiveWorkItemForRef({ workDefId: id });
    if (active) this.setWorkItemStateRow(active.id, "CANCELED");
    return deleteWorkDef(this.teamDir, id);
  }

  /** Archive a WorkDef (mark it archived so it no longer appears in active lists). */
  archiveWorkDef(id: string): WorkDef | null {
    return updateWorkDef(this.teamDir, id, { status: "archived" });
  }

  /** Restore an archived WorkDef back to active status. */
  restoreWorkDef(id: string): WorkDef | null {
    return updateWorkDef(this.teamDir, id, { status: "active" });
  }

  /** Enqueue a READY WorkItem for a WorkDef (unless one is already active). */
  enqueueWorkDef(id: string): WorkItem | null {
    if (this.getActiveWorkItemForRef({ workDefId: id })) return null;
    return this.enqueueFor(id);
  }

  // Schedules (cron parents that own WorkDefs via parent = {kind:schedule,id}).
  getSchedules(): Schedule[] { return listSchedules(this.teamDir); }
  getSchedule(id: string): Schedule | null { return getSchedule(this.teamDir, id); }
  createSchedule(input: { id?: string; title?: string; cron: string }): Schedule { return saveSchedule(this.teamDir, input); }
  updateScheduleDetails(id: string, updates: { title?: string | null; cron?: string }): Schedule | null { return updateSchedule(this.teamDir, id, updates); }
  deleteSchedule(id: string): boolean {
    // Orphan its children (drop their parent) so they don't dangle a ref.
    for (const def of listWorkDefs(this.teamDir)) {
      if (def.parent?.kind === "schedule" && def.parent.id === id) updateWorkDef(this.teamDir, def.id, { parent: null });
    }
    return deleteSchedule(this.teamDir, id);
  }

  // ─── Task Templates (molds for Solitary tasks; see store/templates.ts) ──
  //
  // A Template is a parent-less, runtime-less WorkDef used only to pre-fill a
  // new Solitary task. It never enqueues and is stored separately from work so
  // it never enters the WorkItem queue. Files are the source of truth
  // (templates/<id>/template.md), like Schedules — no SQLite index.

  getTemplates(): Template[] { return listTemplates(this.teamDir); }
  getTemplate(id: string): Template | null { return getTemplate(this.teamDir, id); }
  createTemplate(input: {
    title: string; goal: string; acceptanceCriteria: string;
    additionalContext?: string; contextRefs?: string[]; directory?: string;
  }): Template {
    return saveTemplate(this.teamDir, {
      ...input,
      directory: input.directory ? normalizeDirectory(input.directory) : undefined,
    });
  }
  updateTemplateDetails(id: string, updates: {
    title?: string; goal?: string; acceptanceCriteria?: string;
    additionalContext?: string | null; contextRefs?: string[] | null; directory?: string | null;
  }): Template | null {
    return updateTemplate(this.teamDir, id, {
      ...updates,
      directory: updates.directory !== undefined ? (updates.directory ? normalizeDirectory(updates.directory) : null) : undefined,
    });
  }
  deleteTemplate(id: string): boolean { return deleteTemplate(this.teamDir, id); }

  // ─── Thoughts (markdown sticky notes; personal workspace/outbox) ────
  //
  // Files are the source of truth (thoughts/<id>.md + groups.json), read and
  // written directly like Schedules/standalone WorkDefs — no SQLite index.
  // Two-state lifecycle (active⇄archived), pinning is an orthogonal flag, and
  // there are no auto-sweeps: nothing moves a note without an explicit action.
  // See docs/ARCHITECTURE.md "Thoughts".

  /** All thoughts, optionally filtered by status; sorted by zIndex then id. */
  getThoughts(status?: string): Thought[] {
    let all = listThoughts(this.teamDir);
    if (status === "active" || status === "archived") all = all.filter((t) => t.status === status);
    return all.sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
  }

  getThought(id: string): Thought | null { return ioGetThought(this.teamDir, id); }

  getThoughtGroups(): ThoughtGroup[] { return listThoughtGroups(this.teamDir); }
  getThoughtGroup(id: string): ThoughtGroup | null {
    return this.getThoughtGroups().find((g) => g.id === id) ?? null;
  }

  /** Mint a collision-free id with the given prefix (`th-`/`grp-`). */
  private mintId(prefix: string, exists: (id: string) => boolean): string {
    let id = `${prefix}${Date.now()}`;
    while (exists(id)) id = `${prefix}${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return id;
  }

  /**
   * Auto-place a new note in free space below existing active content, so an
   * agent (or a coordinate-less create) never stacks notes at the origin.
   */
  private findFreePosition(): { x: number; y: number } {
    const notes = this.getThoughts("active");
    if (notes.length === 0) return { x: 0, y: 0 };
    let maxBottom = 0;
    for (const n of notes) maxBottom = Math.max(maxBottom, n.y + (n.h ?? 120));
    return { x: 0, y: maxBottom + 24 };
  }

  /** Highest zIndex among active notes (new notes land on top). */
  private topZIndex(): number {
    return this.getThoughts("active").reduce((max, t) => Math.max(max, t.zIndex), 0);
  }

  createThought(input: {
    content?: string; color?: string; x?: number; y?: number; w?: number | null; h?: number | null;
    zIndex?: number; pinned?: boolean; createdBy?: string; groupId?: string;
  }): Thought {
    const now = new Date().toISOString();
    const pos = (input.x !== undefined && input.y !== undefined)
      ? { x: input.x, y: input.y }
      : this.findFreePosition();
    const t: Thought = {
      id: this.mintId("th-", (id) => ioGetThought(this.teamDir, id) !== null),
      content: input.content ?? "",
      color: input.color || DEFAULT_THOUGHT_COLOR,
      status: "active",
      x: pos.x,
      y: pos.y,
      w: input.w ?? null,
      h: input.h ?? null,
      zIndex: input.zIndex ?? this.topZIndex() + 1,
      pinned: input.pinned ?? false,
      groupId: input.groupId && this.getThoughtGroup(input.groupId) ? input.groupId : null,
      createdBy: input.createdBy || "human",
      createdAt: now,
      updatedAt: now,
    };
    writeThought(this.teamDir, t);
    return t;
  }

  /** Partial update; only provided fields are written. A groupId that doesn't
   * resolve is ignored (null clears membership).
   *
   * `updatedAt` means "last edited": only a change to the note's *content* bumps
   * it. The list view orders notes by it, so moving a note on the canvas,
   * recoloring, pinning, or filing it in a group must not make it jump to the top. */
  updateThought(id: string, updates: {
    content?: string; color?: string; status?: ThoughtStatus; pinned?: boolean;
    groupId?: string | null; x?: number; y?: number; w?: number | null; h?: number | null; zIndex?: number;
  }): Thought | null {
    const t = ioGetThought(this.teamDir, id);
    if (!t) return null;
    const edited = updates.content !== undefined && updates.content !== t.content;
    if (updates.content !== undefined) t.content = updates.content;
    if (updates.color !== undefined) t.color = updates.color;
    if (updates.status !== undefined) t.status = updates.status;
    if (updates.pinned !== undefined) t.pinned = updates.pinned;
    if (updates.groupId !== undefined) {
      t.groupId = updates.groupId && this.getThoughtGroup(updates.groupId) ? updates.groupId : null;
    }
    if (updates.x !== undefined) t.x = updates.x;
    if (updates.y !== undefined) t.y = updates.y;
    if (updates.w !== undefined) t.w = updates.w;
    if (updates.h !== undefined) t.h = updates.h;
    if (updates.zIndex !== undefined) t.zIndex = updates.zIndex;
    if (edited) t.updatedAt = new Date().toISOString();
    writeThought(this.teamDir, t);
    return t;
  }

  /** Batch position/size update (one drag gesture). Missing ids are skipped. */
  updateThoughtPositions(moves: Array<{ id: string; x: number; y: number; w?: number | null; h?: number | null; zIndex?: number }>): Thought[] {
    const updated: Thought[] = [];
    for (const m of moves) {
      const t = this.updateThought(m.id, { x: m.x, y: m.y, w: m.w, h: m.h, zIndex: m.zIndex });
      if (t) updated.push(t);
    }
    return updated;
  }

  /** Archive a note; its triage WorkDef (if any) follows, and a queued run is canceled. */
  archiveThought(id: string): Thought | null {
    const t = this.updateThought(id, { status: "archived" });
    if (t) {
      const item = this.getActiveWorkItemForRef({ workDefId: triageWorkDefId(id) });
      if (item) this.setWorkItemStateRow(item.id, "CANCELED");
      if (getWorkDef(this.teamDir, triageWorkDefId(id))) {
        updateWorkDef(this.teamDir, triageWorkDefId(id), { status: "archived" });
      }
    }
    return t;
  }

  /** Restore a note; its triage WorkDef comes back with it (the thread is kept). */
  restoreThought(id: string): Thought | null {
    const t = this.updateThought(id, { status: "active" });
    if (t && getWorkDef(this.teamDir, triageWorkDefId(id))) {
      updateWorkDef(this.teamDir, triageWorkDefId(id), { status: "active" });
    }
    return t;
  }

  /**
   * Hard delete (direct — no archive-first guard; it's a personal workspace).
   * Takes the note's triage WorkDef — thread included — with it: the thread is
   * about a note that no longer exists.
   */
  deleteThought(id: string): boolean {
    const defId = triageWorkDefId(id);
    const item = this.getActiveWorkItemForRef({ workDefId: defId });
    if (item) this.setWorkItemStateRow(item.id, "CANCELED");
    if (getWorkDef(this.teamDir, defId)) deleteWorkDef(this.teamDir, defId);
    return deleteThoughtFile(this.teamDir, id);
  }

  createThoughtGroup(input: { title?: string; x?: number; y?: number; w?: number; h?: number; memberIds?: string[] }): ThoughtGroup {
    const groups = this.getThoughtGroups();
    const group: ThoughtGroup = {
      id: this.mintId("grp-", (id) => groups.some((g) => g.id === id)),
      title: (input.title || "").trim() || "New Group",
      x: input.x ?? 0,
      y: input.y ?? 0,
      w: input.w ?? DEFAULT_GROUP_SIZE.w,
      h: input.h ?? DEFAULT_GROUP_SIZE.h,
      groupColor: null,
      plateOpacity: "medium",
    };
    writeThoughtGroups(this.teamDir, [...groups, group]);
    // Stamp membership on any provided notes (exclusive: switches groups).
    for (const memberId of input.memberIds ?? []) {
      this.updateThought(memberId, { groupId: group.id });
    }
    return group;
  }

  updateThoughtGroup(id: string, updates: { title?: string; x?: number; y?: number; w?: number; h?: number; groupColor?: string | null; plateOpacity?: "subtle" | "medium" | "solid" }): ThoughtGroup | null {
    const groups = this.getThoughtGroups();
    const group = groups.find((g) => g.id === id);
    if (!group) return null;
    if (updates.title !== undefined) group.title = updates.title.trim() || "New Group";
    if (updates.x !== undefined) group.x = updates.x;
    if (updates.y !== undefined) group.y = updates.y;
    if (updates.w !== undefined) group.w = updates.w;
    if (updates.h !== undefined) group.h = updates.h;
    if (updates.groupColor !== undefined) group.groupColor = updates.groupColor;
    if (updates.plateOpacity !== undefined) group.plateOpacity = updates.plateOpacity;
    writeThoughtGroups(this.teamDir, groups);
    return group;
  }

  /** Ungroup: remove the group and clear its members' groupId (notes stay put). */
  deleteThoughtGroup(id: string): boolean {
    const groups = this.getThoughtGroups();
    if (!groups.some((g) => g.id === id)) return false;
    for (const t of listThoughts(this.teamDir)) {
      if (t.groupId === id) this.updateThought(t.id, { groupId: null });
    }
    writeThoughtGroups(this.teamDir, groups.filter((g) => g.id !== id));
    return true;
  }

  // --- Ref-based comments/attachments ---
  //
  // Comments live on the *ref* — i.e. the WorkDef directory (`tasks/<id>/`),
  // uniformly for board tasks and standalone work. Agents post via a WorkItem
  // id, resolved to its ref. See docs/DESIGN.md "WorkDefs & Parents".

  private refDir(ref: WorkItemRef): string | null {
    return getWorkDef(this.teamDir, ref.workDefId) ? workDefDir(this.teamDir, ref.workDefId) : null;
  }

  getCommentsForRef(ref: WorkItemRef): Comment[] {
    const dir = this.refDir(ref);
    if (!dir) return [];
    const file = path.join(dir, "comments.jsonl");
    if (!existsSync(file)) return [];
    return Deno.readTextFileSync(file).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Comment);
  }

  addCommentForRef(ref: WorkItemRef, from: string, body: string, attachments?: Array<{ name: string; size: number; type: string }>): void {
    const dir = this.refDir(ref);
    if (!dir) return;
    Deno.mkdirSync(dir, { recursive: true });
    const comment: Comment = { from, body, at: new Date().toISOString() };
    if (attachments && attachments.length > 0) comment.attachments = attachments;
    Deno.writeTextFileSync(path.join(dir, "comments.jsonl"), JSON.stringify(comment) + "\n", { append: true });
  }

  saveAttachmentForRef(ref: WorkItemRef, filename: string, data: Uint8Array | string): string | null {
    const dir = this.refDir(ref);
    if (!dir) return null;
    return this.saveAttachmentInDir(path.join(dir, "attachments"), filename, data);
  }

  /** List a ref's attachments, newest first (works for any WorkDef). */
  getAttachmentsForRef(ref: WorkItemRef): Array<{ name: string; storedName: string; size: number; addedAt: number }> {
    const dir = this.refDir(ref);
    if (!dir) return [];
    return this.listAttachmentsInDir(path.join(dir, "attachments"));
  }

  /** Resolve a ref attachment's file path (or null if missing / out of bounds). */
  getAttachmentPathForRef(ref: WorkItemRef, filename: string): string | null {
    const dir = this.refDir(ref);
    if (!dir) return null;
    return this.resolveAttachmentInDir(path.join(dir, "attachments"), filename);
  }

  /** Delete a ref attachment. Returns false if it doesn't exist. */
  deleteAttachmentForRef(ref: WorkItemRef, storedName: string): boolean {
    const filePath = this.getAttachmentPathForRef(ref, storedName);
    if (!filePath) return false;
    try { Deno.removeSync(filePath); return true; } catch { return false; }
  }

  // Token usage on the ref (works for any WorkDef; token_usage is keyed by the
  // WorkDef id). Board tasks also flip the tasks `dirty` flag for git sync.
  addTokenUsageForRef(
    ref: WorkItemRef, inputTokens: number, outputTokens: number, model: string, costUsd: number,
    extra: Omit<Partial<UsageEntry>, "refId" | "inputTokens" | "outputTokens" | "model" | "costUsd" | "title"> = {},
  ): void {
    if (!this.refDir(ref)) return;
    // Snapshot the title: the ledger outlives the ref (archive/delete).
    const title = this.getWorkDef(ref.workDefId)?.title ?? null;
    this.addTokenUsage(ref.workDefId, inputTokens, outputTokens, model, costUsd, { ...extra, title });
  }

  getTokenUsageSummaryForRef(ref: WorkItemRef): { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null {
    return this.getTokenUsageSummary(ref.workDefId);
  }

  // --- Context entries (reusable prompt/context library; see store/context.ts) ---

  getContextEntries(): ContextEntry[] {
    return listContextEntries(this.teamDir);
  }

  getContextEntry(id: string): ContextEntry | null {
    return getContextEntry(this.teamDir, id);
  }

  saveContextEntry(input: { title: string; description?: string; tags?: string[]; content: string }): ContextEntry {
    return saveContextEntry(this.teamDir, input);
  }

  updateContextEntry(id: string, updates: { title?: string; description?: string; tags?: string[]; content?: string }): ContextEntry | null {
    return updateContextEntry(this.teamDir, id, updates);
  }

  deleteContextEntry(id: string): boolean {
    return deleteContextEntry(this.teamDir, id);
  }

  /**
   * Resolve the context-library entries attached to a story and/or task into
   * `{ title, content }` for prompt injection. Story entries come first, task
   * entries after; duplicates (and ids pointing at deleted entries) are dropped.
   */
  resolveTaskContext(storyContext?: string[], taskContext?: string[]): Array<{ title: string; content: string }> {
    const ids = [...(storyContext || []), ...(taskContext || [])];
    const seen = new Set<string>();
    const resolved: Array<{ title: string; content: string }> = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = this.getContextEntry(id);
      if (entry) resolved.push({ title: entry.title, content: entry.content });
    }
    return resolved;
  }

  // --- Cleanup ---

  close(): void {
    this.stopTimers();
    this.flushToDisk();
    // Snapshot the live chat on the way out so the transcript is on disk.
    this.refreshAssistantSnapshot(true);
    if (this.config.autosave.autoCommit) {
      this.commitToGit("pi-pizza-team: shutdown checkpoint");
    }
    this.db.close();
  }
}
