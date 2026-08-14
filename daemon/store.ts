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
  type HostReadiness,
  type Assignment,
} from "../shared/types.ts";
import { isAgentState, isActiveState, isValidPosition, firstActiveState, nextState, validateWorkflow } from "./workflow-engine.ts";
import { listContextEntries, getContextEntry, saveContextEntry, updateContextEntry, deleteContextEntry, type ContextEntry } from "./store/context.ts";
import { listWorkDefs, getWorkDef, saveWorkDef, updateWorkDef, deleteWorkDef, writeWorkDef, workDefDir } from "./store/workdefs.ts";
import { listSchedules, getSchedule, saveSchedule, updateSchedule, deleteSchedule } from "./store/schedules.ts";
import { listTemplates, getTemplate, saveTemplate, updateTemplate, deleteTemplate } from "./store/templates.ts";
import { listThoughts, getThought as ioGetThought, writeThought, deleteThoughtFile, listThoughtGroups, writeThoughtGroups } from "./store/thoughts.ts";
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
import * as path from "@std/path";
import { existsSync } from "@std/fs";

/**
 * Reserved singleton identity for the team assistant. The daemon owns member
 * identity (DESIGN.md "the daemon coordinates; harnesses execute") and already
 * keys the assistant chat + `reset-session` routing on this name, so it must be
 * the daemon — not the harness — that assigns it at spawn time.
 */
export const ASSISTANT_MEMBER_NAME = "assistant";

/**
 * Directive actions an agent realizes itself rather than via its host leader.
 * These need in-process Pi APIs (session replacement), which tmux keystrokes
 * cannot express. See docs/ASSISTANT_CHAT_V2.md §5.5.
 */
export const SELF_HANDLED_ACTIONS = new Set(["new-session", "resume-session"]);

/**
 * Internal board-task view: a WorkDef whose parent is a story, joined with its
 * workflow position (from the story's `tasks` list). This is a runtime cache
 * shape only — the persisted model is the WorkDef (`tasks/<id>/workdef.md`) plus
 * the story's `tasks: [{id, status}]` (see docs/WORKDEF_UNIFICATION.md). The
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
 * intentionally omitted here).
 */
function serializeConfig(config: TeamConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    port: config.port,
    tmuxSession: config.tmuxSession,
    defaultWorkflow: config.defaultWorkflow,
    autosave: config.autosave,
    maxTeammates: config.maxTeammates,
  };
  if (config.agentTimeoutSeconds !== undefined) out.agentTimeoutSeconds = config.agentTimeoutSeconds;
  if (config.apiToken) out.apiToken = config.apiToken;
  if (config.teammates && Object.keys(config.teammates).length > 0) out.teammates = config.teammates;
  if (config.hosts && Object.keys(config.hosts).length > 0) out.hosts = config.hosts;
  if (config.readinessProbe) out.readinessProbe = config.readinessProbe;
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
  private transitionInstructionsCache: Map<string, { content: string; mtime: number; cachedAt: number }> = new Map();
  private transitionCacheTTL = 30000; // 30 seconds
  /**
   * Host readiness reported by each host's leader (see HostReadiness). Held in
   * memory only: like member connections, it's live state that a freshly-booted
   * daemon has no knowledge of — an unknown host is treated as ready until its
   * leader reports otherwise (within a heartbeat).
   */
  private hostReadiness: Map<string, HostReadiness> = new Map();
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
   * docs/ASSISTANT_CHAT_V2.md.
   */
  private chat!: AssistantChat;

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
    this.chat.migrateLegacyMessages();
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
          // Only accept the state/substatus shape (see docs/WORK-MODEL.md);
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
        requirements TEXT DEFAULT '{}',
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
        substatus TEXT,
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
        capabilities TEXT DEFAULT '{}',
        work_mode TEXT DEFAULT 'eager-helper',
        assigned_story_id TEXT,
        metadata TEXT DEFAULT '{}',   -- opaque harness-owned data (daemon never interprets it)
        host_id TEXT,
        status TEXT DEFAULT 'idle',
        last_heartbeat INTEGER
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- The WorkDef ref id (a board task id, or a standalone/Scheduled WorkDef
        -- id). No FK to tasks(id): usage is recorded on the ref, and standalone
        -- WorkDefs have no tasks row. See docs/WORKDEF_UNIFICATION.md.
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
        status TEXT,             -- DEPRECATED (v1 turn model); read only by the migration
        turn_id TEXT,            -- DEPRECATED (v1 turn model)
        created_at INTEGER
      );

      -- A chat session: one continuous conversation, backed by one Pi session.
      -- Ending a session snapshots it to assistant/sessions/<id>.md; nothing is
      -- ever deleted, which is what makes resume possible. At most one session is
      -- 'active'. See docs/ASSISTANT_CHAT_V2.md §3.1.
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

      CREATE TABLE IF NOT EXISTS leader_directives (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        action TEXT NOT NULL,      -- 'spawn' | 'reset-session' | ...
        member_id TEXT,            -- target agent for actions on an existing member
        params TEXT DEFAULT '{}',  -- action params (e.g. spawn name/cwd/storyId/reason)
        status TEXT DEFAULT 'pending', -- 'pending' | 'done'
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,       -- simple daemon-wide key/value settings
        value TEXT
      );

      -- The WorkItem queue: the unit of agent execution. A dumb, terminal-only
      -- attempt pointing at its work via a polymorphic ref (task or workdef).
      -- See docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md.
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        title TEXT,
        ref_kind TEXT,             -- 'task' | 'workdef'
        story_id TEXT,             -- task refs
        task_id TEXT,              -- task refs
        work_def_id TEXT,          -- workdef refs
        directory TEXT,            -- affinity bias, copied from the ref at creation
        state TEXT,                -- READY|IN_PROGRESS|MORIBUND|COMPLETE|FAILED|CANCELED
        read INTEGER DEFAULT 0,
        member_id TEXT,            -- who is/was working it
        enqueued_at INTEGER,
        last_state_change_at INTEGER
      );
    `);

    // Migration: add columns if they don't exist (for existing databases)
    const storyColumns = this.db.prepare("PRAGMA table_info(stories)").all() as Array<Record<string, unknown>>;
    if (!storyColumns.some((col) => col.name === "workflow")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN workflow TEXT");
    }
    if (!storyColumns.some((col) => col.name === "categories")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN categories TEXT DEFAULT '[]'");
    }
    // Context-library attachments (replaces the old decorative `categories`).
    if (!storyColumns.some((col) => col.name === "context")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN context TEXT DEFAULT '[]'");
    }
    if (!storyColumns.some((col) => col.name === "requirements")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN requirements TEXT DEFAULT '{}'");
    }
    if (!storyColumns.some((col) => col.name === "paused")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN paused INTEGER DEFAULT 0");
    }
    if (!storyColumns.some((col) => col.name === "task_order")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN task_order TEXT DEFAULT '[]'");
    }
    // Work-model: the story's working directory is plain data (see docs/WORK-MODEL.md).
    if (!storyColumns.some((col) => col.name === "directory")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN directory TEXT");
    }

    // Assistant chat v2 migration: sessions + real delivery receipts replaced the
    // v1 turn model. Columns are added before `migrateLegacyMessages()` folds
    // existing rows into a `legacy-*` session (docs/ASSISTANT_CHAT_V2.md §10).
    const asstColumns = this.db.prepare("PRAGMA table_info(assistant_messages)").all() as Array<Record<string, unknown>>;
    const hasAsstColumn = (name: string) => asstColumns.some((col) => col.name === name);
    if (!hasAsstColumn("turn_id")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN turn_id TEXT");
    if (!hasAsstColumn("session_id")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN session_id TEXT");
    if (!hasAsstColumn("origin")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN origin TEXT");
    if (!hasAsstColumn("delivery")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN delivery TEXT");
    if (!hasAsstColumn("state")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN state TEXT DEFAULT 'ok'");
    if (!hasAsstColumn("reply_to")) this.db.exec("ALTER TABLE assistant_messages ADD COLUMN reply_to TEXT");
    // The v1 turn table is gone; its rows carried no history worth keeping (the
    // messages did), so drop it outright.
    this.db.exec("DROP TABLE IF EXISTS assistant_turns");

    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<Record<string, unknown>>;
    if (!taskColumns.some((col) => col.name === "last_read_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN last_read_at INTEGER");
    }
    // Work-model: within-state position for tasks in agent states (see docs/WORK-MODEL.md).
    if (!taskColumns.some((col) => col.name === "substatus")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN substatus TEXT");
    }
    if (!taskColumns.some((col) => col.name === "context")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN context TEXT DEFAULT '[]'");
    }
    // WorkDef unification: board tasks are WorkDefs — cache their authored
    // acceptance criteria / additional context (see docs/WORKDEF_UNIFICATION.md).
    if (!taskColumns.some((col) => col.name === "acceptance_criteria")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT");
    }
    if (!taskColumns.some((col) => col.name === "additional_context")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN additional_context TEXT");
    }

    const memberColumns = this.db.prepare("PRAGMA table_info(members)").all() as Array<Record<string, unknown>>;
    if (!memberColumns.some((col) => col.name === "host_id")) {
      this.db.exec("ALTER TABLE members ADD COLUMN host_id TEXT");
    }
    if (!memberColumns.some((col) => col.name === "capabilities")) {
      this.db.exec("ALTER TABLE members ADD COLUMN capabilities TEXT DEFAULT '{}'");
    }
    if (!memberColumns.some((col) => col.name === "work_mode")) {
      this.db.exec("ALTER TABLE members ADD COLUMN work_mode TEXT DEFAULT 'eager-helper'");
    }
    if (!memberColumns.some((col) => col.name === "assigned_story_id")) {
      this.db.exec("ALTER TABLE members ADD COLUMN assigned_story_id TEXT");
    }
    if (!memberColumns.some((col) => col.name === "metadata")) {
      this.db.exec("ALTER TABLE members ADD COLUMN metadata TEXT DEFAULT '{}'");
    }
    // Directory-affinity matching: the agent's working directory (see refactor plan).
    if (!memberColumns.some((col) => col.name === "directory")) {
      this.db.exec("ALTER TABLE members ADD COLUMN directory TEXT");
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

  updateTaskDetails(taskId: string, updates: { title?: string; description?: string; context?: string[] | null }): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const newTitle = updates.title ?? task.title;
    const newDescription = updates.description ?? task.description;
    const newContext = updates.context !== undefined ? (updates.context || []) : (task.context || []);
    // A board task is a WorkDef: persist authored edits to its workdef.md.
    updateWorkDef(this.teamDir, taskId, {
      title: newTitle,
      goal: newDescription,
      contextRefs: newContext,
    });
    this.db.prepare("UPDATE tasks SET title = ?, description = ?, context = ?, dirty = 1 WHERE id = ?").run(newTitle, newDescription, JSON.stringify(newContext), taskId);
    return true;
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
  // See docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md.

  private rowToWorkItem(row: Record<string, unknown>): WorkItem {
    const ref: WorkItemRef = { workDefId: (row.work_def_id ?? row.task_id) as string };
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
    if (!directory && def.parent?.kind === "story") {
      directory = this.getStory(def.parent.id)?.directory;
    }
    const id = `wi-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO work_items (id, title, work_def_id, directory, state, read, member_id, enqueued_at, last_state_change_at)
       VALUES (?, ?, ?, ?, 'READY', 0, NULL, ?, ?)`
    ).run(id, def.title, def.id, directory || null, now, now);
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
   * (see the refactor plan). Eligibility: task refs must belong to a ready,
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
    // Standalone (Solitary/Scheduled) WorkDef: eligible while it exists.
    return this.getWorkDef(wi.ref.workDefId) !== null;
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

  addTokenUsage(taskId: string, inputTokens: number, outputTokens: number, model: string, costUsd: number): void {
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO token_usage (task_id, input_tokens, output_tokens, model, cost_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(taskId, inputTokens, outputTokens, model, costUsd, now);
    this.db.prepare("UPDATE tasks SET dirty = 1 WHERE id = ?").run(taskId);
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
    hostId?: string,
  ): void {
    // (Re)registering clears any dismiss tombstone for this id.
    this.dismissedIds.delete(id);
    this.db.prepare(
      `INSERT OR REPLACE INTO members (id, name, directory, metadata, host_id, status, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, 'idle', ?)`
    ).run(id, name, directory ? normalizeDirectory(directory) : null, JSON.stringify(metadata || {}), hostId || null, Date.now());
  }

  updateMemberStatus(id: string, status: string): void {
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
  }

  /**
   * Record a heartbeat. A previously-reaped agent coming back restores its
   * MORIBUND WorkItems to IN_PROGRESS — it was alive after all (see the
   * refactor plan's reaping model).
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
      hostId: (row.host_id as string) || undefined,
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
   * - Mark it as offline
   * - Release any tasks it has claimed
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
      // don't declare failure or hand its work to someone else — see the
      // refactor plan's reaping model). The lease is kept; a human force-fails
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

    // Check for offline agents every 30 seconds
    this.heartbeatCheckTimer = setInterval(() => {
      this.reapOfflineAgents();
      // Keep the active chat's markdown snapshot fresh so a crash loses minutes,
      // not the whole conversation (docs/ASSISTANT_CHAT_V2.md §6.1).
      this.refreshAssistantSnapshot();
    }, 30_000);

    // Cron scheduler: enqueue due Scheduled WorkDefs, checked every 30s
    // (matching is minute-granular and deduped per minute; see cron.ts).
    this.schedulerTimer = setInterval(() => this.runScheduler(), 30_000);
  }

  stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.commitTimer) clearInterval(this.commitTimer);
    if (this.heartbeatCheckTimer) clearInterval(this.heartbeatCheckTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
  }

  // --- Host readiness (see HostReadiness) ---

  /** Record a host's readiness (reported by that host's leader). */
  setHostReadiness(hostId: string, ready: boolean, reason?: string): void {
    this.hostReadiness.set(hostId, { hostId, ready, reason: ready ? undefined : reason, at: Date.now() });
  }

  /** A host's last-reported readiness, or undefined if it has never reported. */
  getHostReadiness(hostId: string): HostReadiness | undefined {
    return this.hostReadiness.get(hostId);
  }

  /** All reported host-readiness records (for /health and the UI). */
  getAllHostReadiness(): HostReadiness[] {
    return [...this.hostReadiness.values()];
  }

  /** A host with no report yet is treated as ready (backward compatible). */
  private isHostReady(hostId?: string): boolean {
    if (!hostId) return true;
    const r = this.hostReadiness.get(hostId);
    return r ? r.ready : true;
  }

  /**
   * Would enqueuing a scheduled WorkDef with directory `defDir` land on a host
   * that is currently *ready*? Used to gate the cron scheduler so a host whose
   * leader reported not-ready (e.g. expired credentials) doesn't cause an
   * overnight pile-up of failed scheduled runs.
   *
   * Readiness is a host-level fact, but which host runs a scheduled item is
   * decided by directory affinity, so we roll the affinity tiers (mirroring
   * `getNextWorkItem`) up to the set of hosts that could run it:
   *   - no directory on the def → any online host
   *   - some online agent shares the def's directory → that agent's host(s) (tier 1)
   *   - otherwise → any online host (tier 3 fallback)
   *
   * We only *hold* the enqueue when there is at least one would-be host online
   * and every such host is not-ready. If no would-be host is online at all, we
   * allow the enqueue (preserving the pre-existing behavior where the queue just
   * waits for an agent to connect — readiness gating is about connected-but-
   * unable hosts, not absent ones).
   */
  private canScheduleForDirectory(defDir?: string): boolean {
    const norm = defDir ? normalizeDirectory(defDir) : undefined;
    const online = this.getMembers().filter((m) => m.status !== "offline");
    if (online.length === 0) return true; // no connected agents — not a readiness problem

    let takers: Member[];
    if (!norm) {
      takers = online;
    } else if (online.some((m) => m.directory && normalizeDirectory(m.directory) === norm)) {
      takers = online.filter((m) => m.directory && normalizeDirectory(m.directory) === norm);
    } else {
      takers = online; // tier-3 fallback: no online agent owns this dir
    }
    if (takers.length === 0) return true;
    // The hosts those agents run on. Allow if any such host is ready.
    const hostIds = new Set(takers.map((m) => m.hostId));
    return [...hostIds].some((h) => this.isHostReady(h));
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
        if (!this.canScheduleForDirectory(def.directory)) { anyHeld = true; continue; }
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

  /** Remove all task-related data from SQLite (assignments, comments, token_usage, task row) */
  private removeTaskData(taskId: string): void {
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM comments WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM comments_loaded WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM token_usage WHERE task_id = ?").run(taskId);
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
  // and the composer never locks. See docs/ASSISTANT_CHAT_V2.md.

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
   * (docs/ASSISTANT_CHAT_V2.md §5.5). Replaces the old `reset-session` keystroke
   * path for the assistant; teammates still use that.
   */
  private directAssistantSession(action: string, params: Record<string, unknown>): void {
    for (const m of this.getMembers()) {
      if (m.id === ASSISTANT_MEMBER_NAME || m.name.includes(ASSISTANT_MEMBER_NAME)) {
        this.createLeaderDirectiveForMember(m.id, action, params);
      }
    }
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
   * Create a leader directive for a host. For the `spawn` action a name is
   * assigned into params (unless one was supplied):
   *
   *   - `reason: "assistant"` spawns get the reserved singleton name
   *     `"assistant"`. Identity is daemon-owned state (DESIGN.md "the daemon
   *     coordinates; harnesses execute") — the daemon already keys the
   *     assistant chat + `reset-session` routing on this name, so it must be
   *     the one to assign it rather than letting the harness hardcode it. The
   *     assistant is a singleton, so a duplicate spawn (an assistant already
   *     online, or a pending assistant spawn) is coalesced into the existing
   *     request instead of emitting a second directive.
   *   - all other spawns get a unique generated adjective-noun name.
   */
  createLeaderDirective(hostId: string, action: string, opts?: { memberId?: string; params?: Record<string, unknown> }): ReturnType<Store["rowToDirective"]> {
    const id = `dir-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const params: Record<string, unknown> = { ...(opts?.params || {}) };
    if (action === "spawn" && !params.name) {
      if (params.reason === "assistant") {
        // Singleton: coalesce onto an existing assistant member or a pending
        // assistant spawn rather than creating a duplicate.
        const existing = this.findExistingAssistantSpawn();
        if (existing) return existing;
        params.name = ASSISTANT_MEMBER_NAME;
      } else {
        params.name = this.generateSpawnName();
      }
    }
    this.db.prepare(
      "INSERT INTO leader_directives (id, host_id, action, member_id, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
    ).run(id, hostId, action, opts?.memberId || null, JSON.stringify(params), now, now);
    return this.rowToDirective(this.db.prepare("SELECT * FROM leader_directives WHERE id = ?").get(id) as Record<string, unknown>);
  }

  /** Create a directive targeting an existing member (routes to its host). Null if unknown/host-less. */
  createLeaderDirectiveForMember(memberId: string, action: string, params?: Record<string, unknown>): ReturnType<Store["rowToDirective"]> | null {
    const member = this.getMember(memberId);
    if (!member || !member.hostId) return null;
    return this.createLeaderDirective(member.hostId, action, { memberId, params });
  }

  /**
   * Pending directives for a host's *leader*, oldest first, each resolved with
   * target metadata. Self-handled actions are excluded: the leader realizes
   * intents by driving tmux, but a `new-session`/`resume-session` ask has to be
   * executed *inside* the target agent (`ctx.newSession()` / `ctx.switchSession()`),
   * so the agent polls those itself via `getMemberDirectives`. Without this
   * filter the leader would consume and complete them, and the agent would never
   * see them. See docs/ASSISTANT_CHAT_V2.md §5.5.
   */
  getLeaderDirectives(hostId: string): Array<ReturnType<Store["rowToDirective"]>> {
    const rows = this.db.prepare("SELECT * FROM leader_directives WHERE host_id = ? AND status = 'pending' ORDER BY created_at ASC").all(hostId) as Array<Record<string, unknown>>;
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
  getPendingSpawnRequests(): Array<{ id: string; hostId: string; name: string | null; cwd: string | null; createdAt: string }> {
    const rows = this.db.prepare(
      "SELECT id, host_id, params, created_at FROM leader_directives WHERE action = 'spawn' AND status = 'pending' ORDER BY created_at ASC"
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse((row.params as string) || "{}"); } catch { /* ignore */ }
      return {
        id: row.id as string,
        hostId: row.host_id as string,
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
  updateLeaderDirective(id: string, status: string): boolean {
    const row = this.db.prepare("SELECT id FROM leader_directives WHERE id = ?").get(id);
    if (!row) return false;
    this.db.prepare("UPDATE leader_directives SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
    return true;
  }

  /**
   * Find an existing assistant "presence" that a new assistant spawn should
   * coalesce onto: an online assistant member, or an already-pending assistant
   * spawn directive. Returns the representative directive (a synthetic one for
   * a live member) or null if none exists. Enforces the assistant singleton at
   * the point identity is assigned. See createLeaderDirective.
   */
  private findExistingAssistantSpawn(): ReturnType<Store["rowToDirective"]> | null {
    // An assistant is already online — nothing to spawn. Surface a done marker.
    const member = this.getMember(ASSISTANT_MEMBER_NAME)
      || this.getMembers().find((m) => m.name === ASSISTANT_MEMBER_NAME || m.name.includes("assistant"));
    // A pending assistant spawn already exists — reuse it (idempotent retry).
    const pending = this.db.prepare(
      "SELECT * FROM leader_directives WHERE action = 'spawn' AND status = 'pending'"
    ).all() as Array<Record<string, unknown>>;
    for (const row of pending) {
      try {
        const p = JSON.parse((row.params as string) || "{}");
        if (p.name === ASSISTANT_MEMBER_NAME || p.reason === "assistant") {
          return this.rowToDirective(row);
        }
      } catch { /* ignore */ }
    }
    if (member) {
      // Represent the live assistant as a synthetic completed directive so the
      // caller gets a stable, non-duplicating response.
      return this.rowToDirective({
        id: `dir-assistant-live`, action: "spawn", member_id: null,
        params: JSON.stringify({ name: ASSISTANT_MEMBER_NAME, reason: "assistant" }),
        status: "done", created_at: Date.now(),
      });
    }
    return null;
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

  /** Partial update; only provided fields are written. Bumps updatedAt. A
   * groupId that doesn't resolve is ignored (null clears membership). */
  updateThought(id: string, updates: {
    content?: string; color?: string; status?: ThoughtStatus; pinned?: boolean;
    groupId?: string | null; x?: number; y?: number; w?: number | null; h?: number | null; zIndex?: number;
  }): Thought | null {
    const t = ioGetThought(this.teamDir, id);
    if (!t) return null;
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
    t.updatedAt = new Date().toISOString();
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

  archiveThought(id: string): Thought | null { return this.updateThought(id, { status: "archived" }); }
  restoreThought(id: string): Thought | null { return this.updateThought(id, { status: "active" }); }

  /** Hard delete (direct — no archive-first guard; it's a personal workspace). */
  deleteThought(id: string): boolean { return deleteThoughtFile(this.teamDir, id); }

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
  // id, resolved to its ref. See docs/WORKDEF_UNIFICATION.md.

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
  addTokenUsageForRef(ref: WorkItemRef, inputTokens: number, outputTokens: number, model: string, costUsd: number): void {
    if (!this.refDir(ref)) return;
    this.addTokenUsage(ref.workDefId, inputTokens, outputTokens, model, costUsd);
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
