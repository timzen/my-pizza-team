/**
 * daemon/store.ts — SQLite store + JSON file sync (Deno port).
 *
 * Core data layer for the team lead. Uses jsr:@db/sqlite (Deno native FFI)
 * instead of better-sqlite3. Maintains the same schema, CRUD operations,
 * migrations, workflow loading, and JSON file sync as the original.
 *
 * Key invariants:
 * - JSON files are the source of truth for story/task definitions
 * - SQLite is the runtime engine for fast atomic reads/writes
 * - Comments are always appended to JSONL immediately (never lost)
 * - Assignments and members are ephemeral (never written to JSON)
 * - The `dirty` flag on tasks tracks what needs flushing to disk
 */

import { Database } from "@db/sqlite";
import {
  slugify,
  DEFAULT_CONFIG,
  generateTeammateName,
  meetsRequirements,
  normalizeDirectory,
  DEFAULT_WORK_MODE,
  TODO_STATE,
  DONE_STATE,
  type TaskSubstatus,
  type Capabilities,
  type Comment,
  type Story,
  type Task,
  type TaskWithMeta,
  type TeamConfig,
  type WorkflowConfig,
  type WorkMode,
  type Member,
  type Assignment,
} from "../shared/types.ts";
import { isAgentState, isActiveState, isValidPosition, firstActiveState, nextState, entrySubstatus, validateWorkflow } from "./workflow-engine.ts";
import { listContextEntries, getContextEntry, saveContextEntry, updateContextEntry, deleteContextEntry, type ContextEntry } from "./store/context.ts";
import { readScratchpad, addTodo, updateTodo, deleteTodo, writeNotes, type TodoItem } from "./store/scratchpad.ts";
import { commitTeamDir } from "./store/git-sync.ts";
import * as path from "@std/path";
import { existsSync } from "@std/fs";

/** Serialize a Story to the on-disk story.json shape (omitting empty fields). */
function serializeStory(story: Story): Story {
  const data: Story = {
    id: story.id,
    title: story.title,
    description: story.description,
    status: story.status,
    dependsOn: story.dependsOn,
  };
  if (story.requirements && Object.keys(story.requirements).length > 0) data.requirements = story.requirements;
  if (story.directory) data.directory = story.directory;
  if (story.paused) data.paused = true;
  if (story.workflow) data.workflow = story.workflow;
  if (story.context && story.context.length > 0) data.context = story.context;
  if (story.taskOrder && story.taskOrder.length > 0) data.taskOrder = story.taskOrder;
  if (story.archivedAt) data.archivedAt = story.archivedAt;
  return data;
}

/** Max number of remembered values per capability key in config.recentCapabilities. */
const MAX_CAPABILITY_VALUES = 50;

/**
 * Derive a task's creation counter (`seq`) from its stable id. Task IDs are
 * `${storyId}-${seq}`, so we strip the known story-id prefix and parse the
 * numeric suffix. Returns null for hand-authored non-numeric ids (the caller
 * falls back to directory iteration order).
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
  if (config.recentCapabilities && Object.keys(config.recentCapabilities).length > 0) {
    out.recentCapabilities = config.recentCapabilities;
  }
  return out;
}

export class Store {
  private db: Database;
  private teamDir: string;
  private config: TeamConfig;
  private workflows: Record<string, WorkflowConfig> = {};
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  private transitionInstructionsCache: Map<string, { content: string; mtime: number; cachedAt: number }> = new Map();
  private transitionCacheTTL = 30000; // 30 seconds

  constructor(teamDir: string, config: TeamConfig) {
    this.teamDir = teamDir;
    this.config = config;
    const dbPath = path.join(teamDir, "state.db");
    this.db = new Database(dbPath, { int64: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();
    this.loadWorkflows();
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
        task_id TEXT REFERENCES tasks(id),
        input_tokens INTEGER,
        output_tokens INTEGER,
        model TEXT,
        cost_usd REAL,
        recorded_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS assistant_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE,
        role TEXT,               -- 'user' | 'assistant'
        content TEXT,
        status TEXT DEFAULT 'done', -- user: 'sent'|'read'; assistant bubbles: 'done'|'failed'
        turn_id TEXT,            -- the response turn a message belongs to (NULL until read/answered)
        created_at INTEGER
      );

      -- A response "turn" is a job the assistant does in reply to one or more
      -- unanswered user messages. It is decoupled from individual messages so a
      -- turn can produce many assistant bubbles (chat-style batching) and so
      -- several user messages can be coalesced into one turn. See DESIGN.md
      -- ("Assistant chat model"). At most one turn is 'processing' at a time.
      CREATE TABLE IF NOT EXISTS assistant_turns (
        id TEXT PRIMARY KEY,
        status TEXT,             -- 'pending' | 'processing' | 'done' | 'failed'
        claimed_at INTEGER,      -- when it went 'processing' (drives the stuck-turn timeout)
        created_at INTEGER
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

    // Assistant chat model migration: `turn_id` groups messages under a
    // response turn (added when the 1:1 placeholder model was replaced by the
    // append-only chat + coalescing turns; see DESIGN.md).
    const asstColumns = this.db.prepare("PRAGMA table_info(assistant_messages)").all() as Array<Record<string, unknown>>;
    if (!asstColumns.some((col) => col.name === "turn_id")) {
      this.db.exec("ALTER TABLE assistant_messages ADD COLUMN turn_id TEXT");
    }

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
  }

  // --- Load from filesystem ---

  loadFromDisk(): void {
    const storiesDir = path.join(this.teamDir, "stories");
    if (!existsSync(storiesDir)) return;

    for (const entry of Deno.readDirSync(storiesDir)) {
      if (!entry.isDirectory) continue;
      const storyDirPath = path.join(storiesDir, entry.name);
      const storyFile = path.join(storyDirPath, "story.json");
      if (!existsSync(storyFile)) continue;

      const story: Story = JSON.parse(Deno.readTextFileSync(storyFile));
      this.upsertStory(story, storyDirPath);

      const tasksDir = path.join(storyDirPath, "tasks");
      if (!existsSync(tasksDir)) continue;

      const taskDirs = [...Deno.readDirSync(tasksDir)]
        .filter((e) => e.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name));

      let fallbackSeq = 0;
      for (const taskEntry of taskDirs) {
        const taskDirPath = path.join(tasksDir, taskEntry.name);
        const taskFile = path.join(taskDirPath, "task.json");
        if (!existsSync(taskFile)) continue;

        const task: Task = JSON.parse(Deno.readTextFileSync(taskFile));
        // Directory names are just the stable task id (identity only). `seq` is
        // the creation counter derived from the id; `slug` is derived from the
        // current title, so neither drifts with the folder name or ordering.
        fallbackSeq += 1;
        const seq = taskSeqFromId(story.id, task.id) ?? fallbackSeq;
        const slug = slugify(task.title);

        this.upsertTask(task, story.id, seq, slug, taskDirPath);
      }
    }

    // Reconcile positions and run admission so every ready story has its one
    // in-flight task (CONWIP). Tolerates hand-edited JSON.
    this.reconcilePositions();
    for (const story of this.getStories()) this.runAdmission(story.id);
  }

  /**
   * Defensive position cleanup after a disk load: a task sitting in an agent
   * state must carry a substatus (`claimed` if assigned, else `ready`); tasks
   * in manual states or buckets must carry none.
   */
  private reconcilePositions(): void {
    for (const story of this.getStories()) {
      const wf = this.getWorkflowForStory(story.id);
      for (const task of this.getTasksForStory(story.id)) {
        if (isAgentState(wf, task.status)) {
          if (!task.substatus) {
            const assigned = !!this.getAssignment(task.id);
            this.db.prepare("UPDATE tasks SET substatus = ? WHERE id = ?").run(assigned ? "claimed" : "ready", task.id);
          }
        } else if (task.substatus) {
          this.db.prepare("UPDATE tasks SET substatus = NULL WHERE id = ?").run(task.id);
        }
      }
    }
  }

  private upsertStory(story: Story, dirPath: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO stories (id, title, description, status, depends_on, requirements, paused, workflow, context, task_order, directory, dir_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      story.id, story.title, story.description, story.status,
      JSON.stringify(story.dependsOn), JSON.stringify(story.requirements || {}),
      story.paused ? 1 : 0,
      story.workflow || null, JSON.stringify(story.context || []),
      JSON.stringify(story.taskOrder || []), story.directory || null, dirPath
    );
  }

  private upsertTask(task: Task, storyId: string, seq: number, slug: string, dirPath: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO tasks (id, story_id, seq, slug, title, description, status, substatus, result, context, dir_path, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(task.id, storyId, seq, slug, task.title, task.description, task.status, task.substatus || null, task.result, JSON.stringify(task.context || []), dirPath);
  }

  // --- Stories ---

  /** Map a raw SQLite row to a Story object */
  private rowToStory(row: Record<string, unknown>): Story & { dirPath: string } {
    return {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      status: row.status as "open" | "done",
      dependsOn: JSON.parse(row.depends_on as string),
      requirements: row.requirements && (row.requirements as string) !== "{}" ? JSON.parse(row.requirements as string) : undefined,
      paused: row.paused ? true : undefined,
      workflow: (row.workflow as string) || undefined,
      context: row.context && (row.context as string) !== "[]" ? JSON.parse(row.context as string) : undefined,
      taskOrder: row.task_order && (row.task_order as string) !== "[]" ? JSON.parse(row.task_order as string) : undefined,
      directory: (row.directory as string) || undefined,
      dirPath: row.dir_path as string,
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
      status: row.status as string,
      substatus: (row.substatus as TaskSubstatus) || null,
      result: row.result as string | null,
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
    requirements?: Capabilities,
    workflow?: string,
    context?: string[],
    paused?: boolean,
    directory?: string
  ): { story: Story; tasks: TaskWithMeta[] } {
    const storiesDir = path.join(this.teamDir, "stories");
    const storyDirPath = path.join(storiesDir, id);

    Deno.mkdirSync(storyDirPath, { recursive: true });

    const storyData: Story = { id, title, description, status, dependsOn };
    if (requirements && Object.keys(requirements).length > 0) {
      storyData.requirements = { ...requirements };
    }
    if (directory) storyData.directory = normalizeDirectory(directory);
    if (paused) storyData.paused = true;
    if (workflow) storyData.workflow = workflow;
    if (context && context.length > 0) storyData.context = context;
    const storyFile = path.join(storyDirPath, "story.json");
    Deno.writeTextFileSync(storyFile, JSON.stringify(serializeStory(storyData), null, 2) + "\n");

    this.upsertStory(storyData, storyDirPath);
    this.recordCapabilities(storyData.requirements);

    const createdTasks: TaskWithMeta[] = [];

    // Every task starts in the implicit `todo` bucket; admission (CONWIP)
    // pulls the first one into the workflow's first active state below.
    const initialStatus = TODO_STATE;

    if (tasks && tasks.length > 0) {
      const tasksDir = path.join(storyDirPath, "tasks");
      Deno.mkdirSync(tasksDir, { recursive: true });

      for (let i = 0; i < tasks.length; i++) {
        const taskDef = tasks[i]!;
        const seq = i + 1;
        const slug = slugify(taskDef.title);
        const taskId = `${id}-${seq}`;
        // Directory is named by the stable task id only — not order, not title.
        const taskDirPath = path.join(tasksDir, taskId);

        Deno.mkdirSync(taskDirPath, { recursive: true });

        const taskData: Task = {
          id: taskId,
          title: taskDef.title,
          description: taskDef.description,
          status: initialStatus,
          result: null,
        };
        if (taskDef.context && taskDef.context.length > 0) taskData.context = taskDef.context;
        const taskFile = path.join(taskDirPath, "task.json");
        Deno.writeTextFileSync(taskFile, JSON.stringify(taskData, null, 2) + "\n");

        this.upsertTask(taskData, id, seq, slug, taskDirPath);

        createdTasks.push({
          ...taskData,
          storyId: id,
          seq,
          slug,
          dirPath: taskDirPath,
        });
      }
    }

    // The story owns task ordering: record the created tasks' order.
    if (createdTasks.length > 0) {
      storyData.taskOrder = createdTasks.map(t => t.id);
      Deno.writeTextFileSync(storyFile, JSON.stringify(serializeStory(storyData), null, 2) + "\n");
      this.upsertStory(storyData, storyDirPath);
    }

    // Admit the first task into the pipeline (no-op for paused/dependent stories).
    this.runAdmission(id);

    return { story: storyData, tasks: createdTasks };
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
    requirements?: Capabilities | null;
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
    const newRequirements = updates.requirements !== undefined ? (updates.requirements || undefined) : story.requirements;
    const newPaused = updates.paused !== undefined ? updates.paused : (story.paused || false);
    const newWorkflow = updates.workflow !== undefined ? (updates.workflow || null) : (story.workflow || null);
    const newContext = updates.context !== undefined ? (updates.context || []) : (story.context || []);
    const newDirectory = updates.directory !== undefined
      ? (updates.directory ? normalizeDirectory(updates.directory) : null)
      : (story.directory || null);

    this.db.prepare(
      `UPDATE stories SET title = ?, description = ?, status = ?, depends_on = ?, requirements = ?, paused = ?, workflow = ?, context = ?, directory = ? WHERE id = ?`
    ).run(newTitle, newDescription, newStatus, JSON.stringify(newDependsOn), JSON.stringify(newRequirements || {}), newPaused ? 1 : 0, newWorkflow, JSON.stringify(newContext), newDirectory, storyId);
    this.recordCapabilities(newRequirements || undefined);

    // Write back to disk
    const storyFile = path.join(story.dirPath, "story.json");
    const data = serializeStory({
      id: storyId,
      title: newTitle,
      description: newDescription,
      status: newStatus,
      dependsOn: newDependsOn,
      requirements: newRequirements,
      directory: newDirectory || undefined,
      paused: newPaused,
      workflow: newWorkflow || undefined,
      context: newContext,
      taskOrder: story.taskOrder,
    });
    Deno.writeTextFileSync(storyFile, JSON.stringify(data, null, 2) + "\n");

    // Unpausing (or dependency edits) may make the story admissible.
    this.runAdmission(storyId);

    return true;
  }

  updateStoryStatus(storyId: string, status: "open" | "done"): void {
    this.db.prepare("UPDATE stories SET status = ? WHERE id = ?").run(status, storyId);
    const story = this.getStory(storyId);
    if (story) {
      const storyFile = path.join(story.dirPath, "story.json");
      Deno.writeTextFileSync(storyFile, JSON.stringify(serializeStory({ ...story, status }), null, 2) + "\n");
    }
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

  /** Persist a story's task order to both its DB row and story.json. */
  private persistTaskOrder(storyId: string, ids: string[]): void {
    const story = this.getStory(storyId);
    if (!story) return;
    this.db.prepare("UPDATE stories SET task_order = ? WHERE id = ?").run(JSON.stringify(ids), storyId);
    const storyFile = path.join(story.dirPath, "story.json");
    if (existsSync(storyFile)) {
      Deno.writeTextFileSync(storyFile, JSON.stringify(serializeStory({ ...story, taskOrder: ids }), null, 2) + "\n");
    }
  }

  getTasksForStory(storyId: string): TaskWithMeta[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE story_id = ? ORDER BY seq").all(storyId) as Array<Record<string, unknown>>;
    const tasks = rows.map((row) => this.rowToTask(row));
    const story = this.getStory(storyId);
    return this.orderTasks(story?.taskOrder, tasks);
  }

  getTask(taskId: string): TaskWithMeta | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * Low-level position setter: writes (status, substatus) [+ result], keeps the
   * story's open/done status in sync. All position changes flow through here.
   */
  private setTaskPosition(taskId: string, status: string, substatus: TaskSubstatus | null, result?: string): void {
    if (result !== undefined) {
      this.db.prepare("UPDATE tasks SET status = ?, substatus = ?, result = ?, dirty = 1 WHERE id = ?").run(status, substatus, result, taskId);
    } else {
      this.db.prepare("UPDATE tasks SET status = ?, substatus = ?, dirty = 1 WHERE id = ?").run(status, substatus, taskId);
    }

    const task = this.getTask(taskId);
    if (!task) return;
    const story = this.getStory(task.storyId);
    if (!story) return;
    if (status === DONE_STATE) {
      const tasks = this.getTasksForStory(task.storyId);
      if (tasks.every((t) => t.status === DONE_STATE)) this.updateStoryStatus(task.storyId, "done");
    } else if (story.status === "done") {
      // A task moved back out of `done` reopens the story.
      this.updateStoryStatus(task.storyId, "open");
    }
  }

  /**
   * Set a task's status, deriving the substatus for the target position.
   * (Compatibility wrapper; judgment moves should use `moveTask`.)
   */
  updateTaskStatus(taskId: string, status: string, result?: string): void {
    const task = this.getTask(taskId);
    if (!task) return;
    const wf = this.getWorkflowForStory(task.storyId);
    this.setTaskPosition(taskId, status, entrySubstatus(wf, status), result);
  }

  /**
   * Judgment move (human or leader agent): put a task anywhere in its
   * workflow's positions. Entering an agent state resets substatus to `ready`
   * and clears any assignment — re-entry ≡ first entry (rework path). Runs
   * admission excluding the moved task, so shelving a task to `todo` doesn't
   * bounce it straight back in (the *next* task may be admitted instead).
   */
  moveTask(taskId: string, newStatus: string): { ok: boolean; error?: string } {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: "Task not found" };
    const wf = this.getWorkflowForStory(task.storyId);
    if (!isValidPosition(wf, newStatus)) {
      return { ok: false, error: `"${newStatus}" is not a state in this story's workflow` };
    }
    this.setTaskPosition(taskId, newStatus, entrySubstatus(wf, newStatus));
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
    this.db.prepare("UPDATE tasks SET title = ?, description = ?, context = ?, dirty = 1 WHERE id = ?").run(newTitle, newDescription, JSON.stringify(newContext), taskId);
    return true;
  }

  deleteTask(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const storyId = task.storyId;
    this.removeTaskData(taskId);

    // Remove task directory from disk
    if (task.dirPath && existsSync(task.dirPath)) {
      Deno.removeSync(task.dirPath, { recursive: true });
    }

    // Drop the task from the story's owned order (keeps story.json clean).
    const story = this.getStory(storyId);
    if (story?.taskOrder?.includes(taskId)) {
      this.persistTaskOrder(storyId, story.taskOrder.filter(id => id !== taskId));
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

  /**
   * Find the next available task for a teammate.
   * (Alias kept for API stability; see getNextWorkableTask.)
   */
  getNextAvailableTask(agent?: { capabilities?: Capabilities; workMode?: WorkMode; assignedStoryId?: string }): TaskWithMeta | null {
    return this.getNextWorkableTask(agent);
  }

  /**
   * Find the next workable task for an agent (see docs/WORK-MODEL.md).
   *
   * A task is workable when:
   * - Its story is ready (dependencies met), not paused, and matches the
   *   agent's workMode (`assigned-story` agents only see their bound story)
   * - The agent's capabilities satisfy the story's requirements (skills —
   *   the working directory is story data, not a capability)
   * - It sits in an **agent state** with substatus `ready` and no assignment
   *
   * CONWIP means a story has at most one task in its active section, so per
   * story there is at most one candidate. Admission has already run at every
   * mutation point; tasks in `todo` are never offered.
   */
  getNextWorkableTask(agent?: { capabilities?: Capabilities; workMode?: WorkMode; assignedStoryId?: string }): TaskWithMeta | null {
    const capabilities = agent?.capabilities || {};
    const workMode = agent?.workMode || DEFAULT_WORK_MODE;
    const stories = this.getStories();
    for (const story of stories) {
      if (!this.isStoryReady(story.id)) continue;

      // Paused stories are a temporal gate: never hand out their tasks.
      if (story.paused) continue;

      // assigned-story agents only work their bound story.
      if (workMode === "assigned-story" && story.id !== agent?.assignedStoryId) continue;

      // The agent's capabilities must satisfy the story's requirements (skills).
      if (!meetsRequirements(capabilities, story.requirements)) continue;

      const wf = this.getWorkflowForStory(story.id);
      // The story's single in-flight task (CONWIP), if any.
      const active = this.getTasksForStory(story.id).find((t) => isActiveState(wf, t.status));
      if (!active) continue;
      if (!isAgentState(wf, active.status)) continue;      // manual state: a human's move
      if (active.substatus !== "ready") continue;          // claimed (or mid-write)
      if (this.getAssignment(active.id)) continue;         // defensive: leased

      return active;
    }
    return null;
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

    this.setTaskPosition(candidate.id, first, entrySubstatus(wf, first));
  }

  /**
   * Complete an agent-state task's work: mechanical advance to the next state
   * (or the `done` bucket), clear the lease, and re-run admission (finishing
   * the last state frees the CONWIP token). Returns the landing position.
   */
  completeTaskWork(taskId: string, result?: string): { newStatus: string; completed: boolean } | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const wf = this.getWorkflowForStory(task.storyId);
    if (!isAgentState(wf, task.status)) return null;

    const next = nextState(wf, task.status);
    this.setTaskPosition(taskId, next, entrySubstatus(wf, next), result);
    this.releaseTask(taskId);
    this.runAdmission(task.storyId);
    return { newStatus: next, completed: next === DONE_STATE };
  }

  /**
   * Return a claimed task to `ready` (agent gave up, or its lease was reaped).
   * The task stays in its state; the next poll can pick it up fresh.
   */
  returnTaskToReady(taskId: string): void {
    const task = this.getTask(taskId);
    if (!task) return;
    const wf = this.getWorkflowForStory(task.storyId);
    if (isAgentState(wf, task.status)) {
      this.db.prepare("UPDATE tasks SET substatus = 'ready', dirty = 1 WHERE id = ?").run(taskId);
    }
    this.releaseTask(taskId);
  }

  // --- Assignments ---

  /**
   * Lease a ready agent-state task to a member: substatus → `claimed` plus an
   * assignment row (reaped back to `ready` if the member's heartbeat dies).
   */
  claimTask(taskId: string, memberId: string): boolean {
    const existing = this.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(taskId);
    if (existing) return false;

    const task = this.getTask(taskId);
    if (!task) return false;
    const wf = this.getWorkflowForStory(task.storyId);
    if (!isAgentState(wf, task.status) || task.substatus !== "ready") return false;

    this.db.prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)").run(taskId, memberId, Date.now());
    this.db.prepare("UPDATE tasks SET substatus = 'claimed', dirty = 1 WHERE id = ?").run(taskId);
    return true;
  }

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
    const attachDir = path.join(task.dirPath, "attachments");
    Deno.mkdirSync(attachDir, { recursive: true });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
    const storedName = `${Date.now()}-${safeName}`;
    const filePath = path.join(attachDir, storedName);
    if (typeof data === "string") {
      Deno.writeTextFileSync(filePath, data);
    } else {
      Deno.writeFileSync(filePath, data);
    }
    return storedName;
  }

  /** Get an attachment file path */
  getAttachmentPath(taskId: string, filename: string): string | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const filePath = path.join(task.dirPath, "attachments", filename);
    if (!existsSync(filePath)) return null;
    // Security: ensure the resolved path is within the attachments directory
    const resolved = path.resolve(filePath);
    const attachDirResolved = path.resolve(path.join(task.dirPath, "attachments"));
    if (!resolved.startsWith(attachDirResolved)) return null;
    return resolved;
  }

  /** List attachments for a task */
  getAttachments(taskId: string): Array<{ name: string; storedName: string; size: number }> {
    const task = this.getTask(taskId);
    if (!task) return [];
    const attachDir = path.join(task.dirPath, "attachments");
    if (!existsSync(attachDir)) return [];
    const results: Array<{ name: string; storedName: string; size: number }> = [];
    for (const entry of Deno.readDirSync(attachDir)) {
      if (!entry.isFile) continue;
      const stat = Deno.statSync(path.join(attachDir, entry.name));
      const displayName = entry.name.replace(/^\d+-/, "");
      results.push({ name: displayName, storedName: entry.name, size: stat.size });
    }
    return results;
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
    capabilities: Capabilities,
    metadata: Record<string, unknown> = {},
    hostId?: string,
    workMode: WorkMode = DEFAULT_WORK_MODE,
    assignedStoryId?: string,
  ): void {
    const caps: Capabilities = { ...capabilities };
    this.db.prepare(
      `INSERT OR REPLACE INTO members (id, name, capabilities, work_mode, assigned_story_id, metadata, host_id, status, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?)`
    ).run(id, name, JSON.stringify(caps), workMode, assignedStoryId || null, JSON.stringify(metadata || {}), hostId || null, Date.now());
    this.recordCapabilities(caps);
  }

  updateMemberStatus(id: string, status: string): void {
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
  }

  heartbeat(id: string, status: string): void {
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
  }

  private rowToMember(row: Record<string, unknown>): Member {
    const capabilities: Capabilities = row.capabilities && (row.capabilities as string) !== "{}"
      ? JSON.parse(row.capabilities as string)
      : {};
    return {
      id: row.id as string,
      name: row.name as string,
      capabilities,
      workMode: (row.work_mode as WorkMode) || DEFAULT_WORK_MODE,
      assignedStoryId: (row.assigned_story_id as string) || undefined,
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
    this.db.prepare("DELETE FROM members WHERE id = ?").run(id);
  }

  // --- Recently used capabilities (config.recentCapabilities) ---

  /** Persist the current in-memory config to config.json (lossless). */
  private persistConfig(): void {
    const configFile = path.join(this.teamDir, "config.json");
    Deno.writeTextFileSync(configFile, JSON.stringify(serializeConfig(this.config), null, 2) + "\n");
  }

  /** Get the recently used capabilities map (name -> known values). */
  getRecentCapabilities(): Record<string, string[]> {
    return this.config.recentCapabilities || {};
  }

  /**
   * Merge a set of used capabilities into config.recentCapabilities and persist
   * if anything changed. Each key is remembered even when presence-only (null
   * value); non-null values are recorded most-recent-first, deduped, and capped.
   * The well-known `directory` value is normalized so it matches agent registrations.
   */
  recordCapabilities(capabilities?: Capabilities): void {
    if (!capabilities) return;
    let changed = false;
    const map = { ...(this.config.recentCapabilities || {}) };
    for (const [name, rawValue] of Object.entries(capabilities)) {
      if (!name) continue;
      const existing = map[name] ? [...map[name]] : [];
      if (!(name in map)) changed = true;
      if (rawValue !== null && rawValue !== "") {
        const value = rawValue;
        const without = existing.filter((v) => v !== value);
        const next = [value, ...without].slice(0, MAX_CAPABILITY_VALUES);
        if (next.length !== existing.length || next[0] !== existing[0]) changed = true;
        map[name] = next;
      } else {
        map[name] = existing;
      }
    }
    if (changed) {
      this.config.recentCapabilities = map;
      this.persistConfig();
    }
  }

  /** Explicitly add a capability key (and optionally a value) to the recent list. */
  addCapability(name: string, value?: string): void {
    if (!name) return;
    this.recordCapabilities({ [name]: value ?? null });
  }

  /**
   * Remove a capability from the recent list. With a value, removes just that
   * value; without, removes the whole key. Returns true if something changed.
   */
  removeCapability(name: string, value?: string): boolean {
    const map = { ...(this.config.recentCapabilities || {}) };
    if (!(name in map)) return false;
    if (value !== undefined) {
      const next = map[name]!.filter((v) => v !== value);
      if (next.length === map[name]!.length) return false;
      map[name] = next;
    } else {
      delete map[name];
    }
    this.config.recentCapabilities = map;
    this.persistConfig();
    return true;
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

      // Release any claimed tasks
      const assignment = this.db.prepare(
        "SELECT task_id FROM assignments WHERE member_id = ?"
      ).get(id) as Record<string, unknown> | undefined;

      if (assignment) {
        const taskId = assignment.task_id as string;
        // Reaped lease: the task returns to `ready` for the next teammate.
        this.returnTaskToReady(taskId);
        console.warn(
          `⚠️  Agent "${name}" (${id}) timed out (no heartbeat for ${agoSec}s). ` +
          `Returned task "${taskId}" to ready.`
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
        if (row.substatus) taskData.substatus = row.substatus;
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
      this.reapStuckAssistantTurns();
    }, 30_000);
  }

  stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.commitTimer) clearInterval(this.commitTimer);
    if (this.heartbeatCheckTimer) clearInterval(this.heartbeatCheckTimer);
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

  private generateSynopsis(destPath: string, story: Story & { dirPath: string }, tasks: TaskWithMeta[], archivedAt: string): void {
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

    for (const task of tasks) {
      lines.push(`- ${task.title}`);
    }
    lines.push("");

    Deno.writeTextFileSync(path.join(destPath, "SYNOPSIS.md"), lines.join("\n"));
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

    this.removeStoryFromDb(storyId);

    if (story.dirPath && existsSync(story.dirPath)) {
      Deno.removeSync(story.dirPath, { recursive: true });
    }

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

    const sourcePath = story.dirPath;
    const destPath = path.join(archivedDir, storyId);
    const archivedAt = new Date().toISOString();

    if (existsSync(sourcePath)) {
      Deno.renameSync(sourcePath, destPath);

      // Update story.json with archivedAt timestamp
      const storyFile = path.join(destPath, "story.json");
      if (existsSync(storyFile)) {
        const storyData = JSON.parse(Deno.readTextFileSync(storyFile));
        storyData.archivedAt = archivedAt;
        Deno.writeTextFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");
      }

      // Generate SYNOPSIS.md
      const tasks = this.getTasksForStory(storyId);
      this.generateSynopsis(destPath, story, tasks, archivedAt);
    } else {
      // Source directory missing — create a minimal archive entry
      Deno.mkdirSync(destPath, { recursive: true });
      const tasks = this.getTasksForStory(storyId);
      const storyData = { id: storyId, title: story.title, description: story.description, status: "done", archivedAt };
      Deno.writeTextFileSync(path.join(destPath, "story.json"), JSON.stringify(storyData, null, 2) + "\n");
      this.generateSynopsis(destPath, story, tasks, archivedAt);
    }

    this.removeStoryFromDb(storyId);
  }

  getArchivedStories(): Array<{ id: string; title: string; synopsis: string }> {
    const archivedDir = path.join(this.teamDir, "archived");
    if (!existsSync(archivedDir)) return [];

    const results: Array<{ id: string; title: string; synopsis: string }> = [];
    for (const entry of Deno.readDirSync(archivedDir)) {
      if (!entry.isDirectory) continue;
      const dirPath = path.join(archivedDir, entry.name);
      const storyFile = path.join(dirPath, "story.json");
      if (!existsSync(storyFile)) continue;

      const storyData = JSON.parse(Deno.readTextFileSync(storyFile));

      let synopsis = storyData.description || "";
      const synopsisFile = path.join(dirPath, "SYNOPSIS.md");
      if (existsSync(synopsisFile)) {
        synopsis = Deno.readTextFileSync(synopsisFile);
      }

      results.push({ id: storyData.id, title: storyData.title, synopsis });
    }
    return results;
  }

  getArchivedStoryContext(storyId: string): { story: Record<string, unknown>; tasks: Record<string, unknown>[]; comments: Record<string, Comment[]> } | null {
    const archivedDir = path.join(this.teamDir, "archived", storyId);
    if (!existsSync(archivedDir)) return null;

    const storyFile = path.join(archivedDir, "story.json");
    if (!existsSync(storyFile)) return null;

    const story = JSON.parse(Deno.readTextFileSync(storyFile));
    const tasks: Record<string, unknown>[] = [];
    const comments: Record<string, Comment[]> = {};

    const tasksDir = path.join(archivedDir, "tasks");
    if (existsSync(tasksDir)) {
      const taskDirs = [...Deno.readDirSync(tasksDir)]
        .filter((e) => e.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const taskEntry of taskDirs) {
        const taskDirPath = path.join(tasksDir, taskEntry.name);
        const taskFile = path.join(taskDirPath, "task.json");
        if (!existsSync(taskFile)) continue;

        const task = JSON.parse(Deno.readTextFileSync(taskFile));
        tasks.push(task);

        const commentsFile = path.join(taskDirPath, "comments.jsonl");
        if (existsSync(commentsFile)) {
          const lines = Deno.readTextFileSync(commentsFile).split("\n").filter(Boolean);
          comments[task.id] = lines.map((line: string) => JSON.parse(line) as Comment);
        }
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
      const s = this.getStory(id);
      if (!s) continue;

      const sourcePath = s.dirPath;
      const destPath = path.join(backlogDir, id);

      Deno.renameSync(sourcePath, destPath);

      const storyFile = path.join(destPath, "story.json");
      const storyData = JSON.parse(Deno.readTextFileSync(storyFile));
      storyData.backloggedAt = new Date().toISOString();
      Deno.writeTextFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");

      this.removeStoryFromDb(id);
    }

    return toMove;
  }

  /** Move a story from backlog back to active stories. */
  moveFromBacklog(storyId: string): void {
    const backlogDir = path.join(this.teamDir, "backlog");
    const sourcePath = path.join(backlogDir, storyId);
    if (!existsSync(sourcePath)) {
      throw new Error(`Story "${storyId}" not found in backlog`);
    }

    const storiesDir = path.join(this.teamDir, "stories");
    const destPath = path.join(storiesDir, storyId);

    const storyFile = path.join(sourcePath, "story.json");
    const storyData = JSON.parse(Deno.readTextFileSync(storyFile));
    delete storyData.backloggedAt;
    Deno.writeTextFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");

    Deno.renameSync(sourcePath, destPath);

    this.loadFromDisk();
  }

  /** Get all stories in the backlog */
  getBacklogStories(): Array<{ id: string; title: string; description: string; dependsOn: string[]; backloggedAt?: string }> {
    const backlogDir = path.join(this.teamDir, "backlog");
    if (!existsSync(backlogDir)) return [];

    const results: Array<{ id: string; title: string; description: string; dependsOn: string[]; backloggedAt?: string }> = [];
    for (const entry of Deno.readDirSync(backlogDir)) {
      if (!entry.isDirectory) continue;
      const storyFile = path.join(backlogDir, entry.name, "story.json");
      if (!existsSync(storyFile)) continue;

      const storyData = JSON.parse(Deno.readTextFileSync(storyFile));
      results.push({
        id: storyData.id,
        title: storyData.title,
        description: storyData.description || "",
        dependsOn: storyData.dependsOn || [],
        backloggedAt: storyData.backloggedAt,
      });
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

  // --- Assistant Conversation ---
  //
  // The assistant is a real chat: an append-only sequence of user/assistant
  // messages, decoupled from response "turns". Sending a user message just
  // appends it (status 'sent'). A turn is the job of replying to the current
  // batch of unanswered user messages: the agent polls for one, claims it
  // (which marks those user messages 'read' — read receipts), streams any number
  // of assistant bubbles via `appendAssistantMessage`, then completes it. Only
  // one turn processes at a time; the UI locks the composer while it runs. See
  // DESIGN.md ("Assistant chat model").

  /** Shape of a stored conversation message. */
  private rowToAssistantMessage(row: Record<string, unknown>): { id: string; role: string; content: string; status: string; turnId: string | null; createdAt: string } {
    return {
      id: row.id as string,
      role: row.role as string,
      content: (row.content as string) || "",
      status: row.status as string,
      turnId: (row.turn_id as string) || null,
      createdAt: new Date(row.created_at as number).toISOString(),
    };
  }

  /**
   * Append a user message to the conversation. Messages are append-only and
   * start as 'sent' (single check); a turn claim flips them to 'read'. Does
   * NOT create an assistant placeholder — replies are produced by a turn.
   */
  appendUserMessage(content: string): ReturnType<Store["rowToAssistantMessage"]> {
    const now = Date.now();
    const id = `msg-${now}-${crypto.randomUUID().slice(0, 8)}`;
    this.db.prepare("INSERT INTO assistant_messages (id, role, content, status, created_at) VALUES (?, 'user', ?, 'sent', ?)").run(id, content, now);
    return this.getAssistantMessage(id)!;
  }

  /**
   * Last time the user showed activity in the composer (a typing ping from the
   * UI). Combined with the newest unanswered message timestamp, this is the
   * "user is still going" signal the debounce waits on. In-memory only — it's
   * ephemeral presence, not conversation state worth persisting.
   */
  private assistantLastTypingAt = 0;

  /** Record that the user is actively typing (called by POST /api/assistant/typing). */
  recordAssistantTyping(): void {
    this.assistantLastTypingAt = Date.now();
  }

  getAssistantMessage(id: string): ReturnType<Store["rowToAssistantMessage"]> | null {
    const row = this.db.prepare("SELECT * FROM assistant_messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToAssistantMessage(row) : null;
  }

  /** The full conversation, oldest first. */
  getAssistantMessages(): Array<ReturnType<Store["rowToAssistantMessage"]>> {
    const rows = this.db.prepare("SELECT * FROM assistant_messages ORDER BY seq ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToAssistantMessage(r));
  }

  /** The active (processing) turn, or null. Drives the UI typing indicator + composer lock. */
  getActiveTurn(): { id: string; status: string } | null {
    const row = this.db.prepare("SELECT id, status FROM assistant_turns WHERE status = 'processing' LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? { id: row.id as string, status: row.status as string } : null;
  }

  /**
   * The next response turn for the agent to work, or null. Returns null while a
   * turn is already processing (single-flight), when there are no unanswered
   * user messages, or while the user is still active (pre-claim debounce: the
   * assistant waits `assistantTurnDebounceSeconds` after the last message/keystroke
   * so it never grabs a message mid-thought — see DESIGN.md). Coalesces every
   * 'sent' user message into one turn; the prompt is those messages joined in
   * order. A 'pending' turn is created on demand and reused across polls until
   * it is claimed.
   */
  getNextAssistantItem(): { id: string; prompt: string } | null {
    // Single-flight: never hand out a turn while one is processing.
    if (this.getActiveTurn()) return null;

    const unanswered = this.db.prepare("SELECT content, created_at FROM assistant_messages WHERE role = 'user' AND status = 'sent' ORDER BY seq ASC").all() as Array<Record<string, unknown>>;
    if (unanswered.length === 0) return null;

    // Pre-claim debounce: hold off until the user has been quiet (no new message
    // and no typing ping) for the debounce window, so a turn coalesces a whole
    // burst instead of firing on the first message while the user keeps typing.
    const debounceMs = (this.config.assistantTurnDebounceSeconds ?? 5) * 1000;
    if (debounceMs > 0) {
      const lastMsgTs = Math.max(...unanswered.map((r) => r.created_at as number));
      const lastActivity = Math.max(lastMsgTs, this.assistantLastTypingAt);
      if (Date.now() - lastActivity < debounceMs) return null;
    }

    const prompt = unanswered.map((r) => r.content as string).join("\n\n");

    // Reuse an existing pending turn (repeated polls) or create one.
    let turn = this.db.prepare("SELECT id FROM assistant_turns WHERE status = 'pending' LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!turn) {
      const id = `turn-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      this.db.prepare("INSERT INTO assistant_turns (id, status, created_at) VALUES (?, 'pending', ?)").run(id, Date.now());
      turn = { id };
    }
    return { id: turn.id as string, prompt };
  }

  /**
   * Claim a pending turn (-> processing) and mark every unanswered user message
   * 'read' (double check), stamping them with this turn id. This is the read
   * receipt: the user sees exactly which messages were coalesced into the turn.
   */
  claimAssistantItem(turnId: string): boolean {
    const row = this.db.prepare("SELECT status FROM assistant_turns WHERE id = ?").get(turnId) as Record<string, unknown> | undefined;
    if (!row || row.status !== "pending") return false;
    this.db.prepare("UPDATE assistant_turns SET status = 'processing', claimed_at = ? WHERE id = ?").run(Date.now(), turnId);
    this.db.prepare("UPDATE assistant_messages SET status = 'read', turn_id = ? WHERE role = 'user' AND status = 'sent'").run(turnId);
    return true;
  }

  /**
   * Append one assistant bubble to a processing turn (the `send_message` tool).
   * Bubbles are stored 'done' so they render immediately; the UI polls and
   * shows them progressively, iMessage-style. Returns null if the turn isn't
   * processing.
   */
  appendAssistantMessage(turnId: string, content: string): ReturnType<Store["rowToAssistantMessage"]> | null {
    const row = this.db.prepare("SELECT status FROM assistant_turns WHERE id = ?").get(turnId) as Record<string, unknown> | undefined;
    if (!row || row.status !== "processing") return null;
    const now = Date.now();
    const id = `msg-${now}-${crypto.randomUUID().slice(0, 8)}`;
    this.db.prepare("INSERT INTO assistant_messages (id, role, content, status, turn_id, created_at) VALUES (?, 'assistant', ?, 'done', ?, ?)").run(id, content, turnId, now);
    return this.getAssistantMessage(id)!;
  }

  /**
   * Close a processing turn. On success the turn is marked done/failed and the
   * composer unlocks. `result` is a fallback: if the turn produced no bubbles
   * via `appendAssistantMessage` (a persona that ignored `send_message`), it is
   * appended as a single bubble so the user is never left without a reply.
   */
  completeAssistantItem(turnId: string, result?: string, failed = false): boolean {
    const row = this.db.prepare("SELECT status FROM assistant_turns WHERE id = ?").get(turnId) as Record<string, unknown> | undefined;
    if (!row || row.status !== "processing") return false;

    const bubbleCount = (this.db.prepare("SELECT COUNT(*) AS n FROM assistant_messages WHERE turn_id = ? AND role = 'assistant'").get(turnId) as { n: number }).n;
    const trimmed = (result || "").trim();
    // Fallback bubble when the turn said nothing via the tool (or failed with a message).
    if ((bubbleCount === 0 && trimmed) || (failed && bubbleCount === 0)) {
      const now = Date.now();
      const id = `msg-${now}-${crypto.randomUUID().slice(0, 8)}`;
      const status = failed ? "failed" : "done";
      this.db.prepare("INSERT INTO assistant_messages (id, role, content, status, turn_id, created_at) VALUES (?, 'assistant', ?, ?, ?, ?)").run(id, trimmed || "The assistant hit an error.", status, turnId, now);
    }

    this.db.prepare("UPDATE assistant_turns SET status = ? WHERE id = ?").run(failed ? "failed" : "done", turnId);
    return true;
  }

  /**
   * Fail any processing turn whose claim is older than the timeout (default
   * 300s) — e.g. the assistant crashed mid-turn. Without this the composer
   * would stay locked forever. Called on the same cadence as agent reaping.
   * Returns the ids of turns that were failed.
   */
  reapStuckAssistantTurns(): string[] {
    const timeoutMs = (this.config.assistantTurnTimeoutSeconds ?? 300) * 1000;
    const cutoff = Date.now() - timeoutMs;
    const rows = this.db.prepare("SELECT id FROM assistant_turns WHERE status = 'processing' AND claimed_at < ?").all(cutoff) as Array<Record<string, unknown>>;
    const reaped: string[] = [];
    for (const row of rows) {
      const turnId = row.id as string;
      const bubbleCount = (this.db.prepare("SELECT COUNT(*) AS n FROM assistant_messages WHERE turn_id = ? AND role = 'assistant'").get(turnId) as { n: number }).n;
      if (bubbleCount === 0) {
        const now = Date.now();
        const id = `msg-${now}-${crypto.randomUUID().slice(0, 8)}`;
        this.db.prepare("INSERT INTO assistant_messages (id, role, content, status, turn_id, created_at) VALUES (?, 'assistant', ?, 'failed', ?, ?)").run(id, "The assistant went away before replying. Try again.", turnId, now);
      }
      this.db.prepare("UPDATE assistant_turns SET status = 'failed' WHERE id = ?").run(turnId);
      console.warn(`⚠️  Assistant turn "${turnId}" timed out and was failed.`);
      reaped.push(turnId);
    }
    return reaped;
  }

  deleteAssistantMessage(id: string): boolean {
    const row = this.db.prepare("SELECT id FROM assistant_messages WHERE id = ?").get(id);
    if (!row) return false;
    this.db.prepare("DELETE FROM assistant_messages WHERE id = ?").run(id);
    return true;
  }

  /** Clear the whole conversation, including turn state. */
  clearAssistantMessages(): void {
    this.db.prepare("DELETE FROM assistant_messages").run();
    this.db.prepare("DELETE FROM assistant_turns").run();
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
   * Fire a `reset-session` directive to any online assistant member so its
   * in-agent conversation context is dropped (the leader realizes the intent).
   * Used when clearing the conversation or swapping personas.
   */
  resetAssistantSessions(): void {
    for (const m of this.getMembers()) {
      if (m.id === "assistant" || m.name.includes("assistant")) {
        this.createLeaderDirectiveForMember(m.id, "reset-session");
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
   * Create a leader directive for a host. For the `spawn` action a unique
   * teammate name is generated into params (unless one was supplied).
   */
  createLeaderDirective(hostId: string, action: string, opts?: { memberId?: string; params?: Record<string, unknown> }): ReturnType<Store["rowToDirective"]> {
    const id = `dir-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const params: Record<string, unknown> = { ...(opts?.params || {}) };
    if (action === "spawn" && !params.name) {
      params.name = this.generateSpawnName();
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

  /** Pending directives for a host, oldest first, each resolved with target metadata. */
  getLeaderDirectives(hostId: string): Array<ReturnType<Store["rowToDirective"]>> {
    const rows = this.db.prepare("SELECT * FROM leader_directives WHERE host_id = ? AND status = 'pending' ORDER BY created_at ASC").all(hostId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDirective(r));
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

  // --- Scratch pad (personal todos + notes; see store/scratchpad.ts) ---

  getScratchpad(): { todos: TodoItem[]; notes: string } {
    return readScratchpad(this.teamDir);
  }

  addScratchpadTodo(item: string): TodoItem[] {
    return addTodo(this.teamDir, item);
  }

  updateScratchpadTodo(index: number, updates: { status?: "open" | "done"; item?: string }): TodoItem[] | null {
    return updateTodo(this.teamDir, index, updates);
  }

  deleteScratchpadTodo(index: number): TodoItem[] | null {
    return deleteTodo(this.teamDir, index);
  }

  setScratchpadNotes(content: string): void {
    writeNotes(this.teamDir, content);
  }

  // --- Cleanup ---

  close(): void {
    this.stopTimers();
    this.flushToDisk();
    if (this.config.autosave.autoCommit) {
      this.commitToGit("pi-pizza-team: shutdown checkpoint");
    }
    this.db.close();
  }
}
