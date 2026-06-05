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
  getInitialState,
  getDoneState,
  DEFAULT_CONFIG,
  type Comment,
  type Story,
  type Task,
  type TaskWithMeta,
  type TeamConfig,
  type WorkflowConfig,
  type Member,
  type Assignment,
} from "../shared/types.ts";
import { parseFrontmatter, serializeFrontmatter } from "../shared/frontmatter.ts";
import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";

export class Store {
  private db: Database;
  private teamDir: string;
  private config: TeamConfig;
  private workflows: Record<string, WorkflowConfig> = {};
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;
  private transitionInstructionsCache: Map<string, { content: string; mtime: number; cachedAt: number }> = new Map();
  private transitionCacheTTL = 30000; // 30 seconds

  constructor(teamDir: string, config: TeamConfig) {
    this.teamDir = teamDir;
    this.config = config;
    const dbPath = path.join(teamDir, "state.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();
    this.loadWorkflows();
  }

  /** Load workflows from the workflows/ directory (falls back to config.workflows) */
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
          this.workflows[entry.name] = wf;
        } catch {
          // Skip malformed workflow files
        }
      }
    }

    // Fall back to config.workflows if directory is empty/missing
    if (Object.keys(this.workflows).length === 0 && this.config.workflows) {
      this.workflows = { ...this.config.workflows };
    }

    // Final fallback: default workflow from DEFAULT_CONFIG
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
        dir TEXT,
        workflow TEXT,
        categories TEXT DEFAULT '[]',
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
        cwd TEXT,
        tmux_window TEXT,
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

      CREATE TABLE IF NOT EXISTS assistant_queue (
        id TEXT PRIMARY KEY,
        prompt TEXT,
        status TEXT DEFAULT 'pending',
        result TEXT,
        created_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS spawn_requests (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        cwd TEXT,
        story_id TEXT,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER,
        acked_at INTEGER
      );
    `);

    // Migration: add columns if they don't exist (for existing databases)
    const storyColumns = this.db.prepare("PRAGMA table_info(stories)").all() as Array<Record<string, unknown>>;
    if (!storyColumns.some((col) => col.name === "dir")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN dir TEXT");
    }
    if (!storyColumns.some((col) => col.name === "workflow")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN workflow TEXT");
    }
    if (!storyColumns.some((col) => col.name === "categories")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN categories TEXT DEFAULT '[]'");
    }

    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<Record<string, unknown>>;
    if (!taskColumns.some((col) => col.name === "last_read_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN last_read_at INTEGER");
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

      for (const taskEntry of taskDirs) {
        const taskDirPath = path.join(tasksDir, taskEntry.name);
        const taskFile = path.join(taskDirPath, "task.json");
        if (!existsSync(taskFile)) continue;

        const task: Task = JSON.parse(Deno.readTextFileSync(taskFile));
        const match = taskEntry.name.match(/^(\d+)-(.+)$/);
        const seq = match ? parseInt(match[1]!, 10) : 0;
        const slug = match ? match[2]! : taskEntry.name;

        this.upsertTask(task, story.id, seq, slug, taskDirPath);
      }
    }
  }

  private upsertStory(story: Story, dirPath: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO stories (id, title, description, status, depends_on, dir, workflow, categories, dir_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      story.id, story.title, story.description, story.status,
      JSON.stringify(story.dependsOn), story.dir || null,
      story.workflow || null, JSON.stringify(story.categories || []), dirPath
    );
  }

  private upsertTask(task: Task, storyId: string, seq: number, slug: string, dirPath: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(task.id, storyId, seq, slug, task.title, task.description, task.status, task.result, dirPath);
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
      dir: (row.dir as string) || undefined,
      workflow: (row.workflow as string) || undefined,
      categories: row.categories ? JSON.parse(row.categories as string) : undefined,
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
      result: row.result as string | null,
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
    tasks?: Array<{ title: string; description: string }>,
    dir?: string,
    workflow?: string,
    categories?: string[]
  ): { story: Story; tasks: TaskWithMeta[] } {
    const storiesDir = path.join(this.teamDir, "stories");
    const storyDirPath = path.join(storiesDir, id);

    Deno.mkdirSync(storyDirPath, { recursive: true });

    const storyData: Story = { id, title, description, status, dependsOn };
    if (dir) storyData.dir = dir;
    if (workflow) storyData.workflow = workflow;
    if (categories && categories.length > 0) storyData.categories = categories;
    const storyFile = path.join(storyDirPath, "story.json");
    Deno.writeTextFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");

    this.upsertStory(storyData, storyDirPath);

    const createdTasks: TaskWithMeta[] = [];

    // Resolve initial task status from the story's workflow
    const wfName = workflow || this.config.defaultWorkflow;
    const wf = this.workflows[wfName] || this.workflows[this.config.defaultWorkflow]!;
    const initialStatus = getInitialState(wf);

    if (tasks && tasks.length > 0) {
      const tasksDir = path.join(storyDirPath, "tasks");
      Deno.mkdirSync(tasksDir, { recursive: true });

      for (let i = 0; i < tasks.length; i++) {
        const taskDef = tasks[i]!;
        const seq = i + 1;
        const slug = slugify(taskDef.title);
        const taskId = `${id}-${seq}`;
        const taskDirName = `${String(seq).padStart(2, "0")}-${slug}`;
        const taskDirPath = path.join(tasksDir, taskDirName);

        Deno.mkdirSync(taskDirPath, { recursive: true });

        const taskData: Task = {
          id: taskId,
          title: taskDef.title,
          description: taskDef.description,
          status: initialStatus,
          result: null,
        };
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
      if (!dep || dep.status !== "done") return false;
    }
    return true;
  }

  updateStoryDetails(storyId: string, updates: {
    title?: string;
    description?: string;
    status?: "open" | "done";
    dependsOn?: string[];
    dir?: string | null;
    workflow?: string | null;
    categories?: string[] | null;
  }): boolean {
    const story = this.getStory(storyId);
    if (!story) return false;

    const newTitle = updates.title ?? story.title;
    const newDescription = updates.description ?? story.description;
    const newStatus = updates.status ?? story.status;
    const newDependsOn = updates.dependsOn ?? story.dependsOn;
    const newDir = updates.dir !== undefined ? (updates.dir || null) : (story.dir || null);
    const newWorkflow = updates.workflow !== undefined ? (updates.workflow || null) : (story.workflow || null);
    const newCategories = updates.categories !== undefined ? (updates.categories || []) : (story.categories || []);

    this.db.prepare(
      `UPDATE stories SET title = ?, description = ?, status = ?, depends_on = ?, dir = ?, workflow = ?, categories = ? WHERE id = ?`
    ).run(newTitle, newDescription, newStatus, JSON.stringify(newDependsOn), newDir, newWorkflow, JSON.stringify(newCategories), storyId);

    // Write back to disk
    const storyFile = path.join(story.dirPath, "story.json");
    const data: Story = {
      id: storyId,
      title: newTitle,
      description: newDescription,
      status: newStatus,
      dependsOn: newDependsOn,
    };
    if (newDir) data.dir = newDir;
    if (newWorkflow) data.workflow = newWorkflow;
    if (newCategories.length > 0) data.categories = newCategories;
    Deno.writeTextFileSync(storyFile, JSON.stringify(data, null, 2) + "\n");

    return true;
  }

  updateStoryStatus(storyId: string, status: "open" | "done"): void {
    this.db.prepare("UPDATE stories SET status = ? WHERE id = ?").run(status, storyId);
    const story = this.getStory(storyId);
    if (story) {
      const storyFile = path.join(story.dirPath, "story.json");
      const data: Story = {
        id: story.id,
        title: story.title,
        description: story.description,
        status: status,
        dependsOn: story.dependsOn,
      };
      if (story.dir) data.dir = story.dir;
      if (story.workflow) data.workflow = story.workflow;
      Deno.writeTextFileSync(storyFile, JSON.stringify(data, null, 2) + "\n");
    }
  }

  // --- Tasks ---

  getTasksForStory(storyId: string): TaskWithMeta[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE story_id = ? ORDER BY seq").all(storyId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTask(row));
  }

  getTask(taskId: string): TaskWithMeta | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  updateTaskStatus(taskId: string, status: string, result?: string): void {
    if (result !== undefined) {
      this.db.prepare("UPDATE tasks SET status = ?, result = ?, dirty = 1 WHERE id = ?").run(status, result, taskId);
    } else {
      this.db.prepare("UPDATE tasks SET status = ?, dirty = 1 WHERE id = ?").run(status, taskId);
    }

    // Check if story is complete (all tasks in their workflow's done state)
    const task = this.getTask(taskId);
    if (task) {
      const wf = this.getWorkflowForStory(task.storyId);
      const doneState = getDoneState(wf);
      if (status === doneState) {
        const tasks = this.getTasksForStory(task.storyId);
        if (tasks.every((t) => t.status === doneState)) {
          this.updateStoryStatus(task.storyId, "done");
        }
      }
    }
  }

  updateTaskDetails(taskId: string, updates: { title?: string; description?: string }): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const newTitle = updates.title ?? task.title;
    const newDescription = updates.description ?? task.description;
    this.db.prepare("UPDATE tasks SET title = ?, description = ?, dirty = 1 WHERE id = ?").run(newTitle, newDescription, taskId);
    return true;
  }

  deleteTask(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    this.removeTaskData(taskId);

    // Remove task directory from disk
    if (task.dirPath && existsSync(task.dirPath)) {
      Deno.removeSync(task.dirPath, { recursive: true });
    }

    return true;
  }

  /**
   * Find the next available task for a teammate.
   * Rules:
   * - Story must be ready (all dependencies met)
   * - Task must be in its workflow's initial state
   * - Must be the first such task in the story (sequential)
   * - Must not already be assigned
   */
  getNextAvailableTask(memberCwd?: string): TaskWithMeta | null {
    const stories = this.getStories();
    for (const story of stories) {
      if (!this.isStoryReady(story.id)) continue;

      // If the member has a cwd, only match stories with the same dir
      if (memberCwd && story.dir) {
        const normalizedStoryDir = story.dir.replace(/\/$/, "").replace(/^~/, Deno.env.get("HOME") || "~");
        const normalizedMemberCwd = memberCwd.replace(/\/$/, "");
        if (normalizedStoryDir !== normalizedMemberCwd) continue;
      }

      const wf = this.getWorkflowForStory(story.id);
      const initialState = getInitialState(wf);
      const doneState = getDoneState(wf);

      const tasks = this.getTasksForStory(story.id);
      for (const task of tasks) {
        if (task.status === initialState) {
          const assignment = this.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(task.id);
          if (!assignment) return task;
          break;
        }
        if (task.status !== doneState) break;
      }
    }
    return null;
  }

  /**
   * Find the next workable task for an agent.
   * A task is "workable" if:
   * - Its story is ready (dependencies met)
   * - It is NOT claimed by anyone
   * - It has at least one "teammate" or "any" transition from its current state
   * - Its story dir matches the agent's cwd (if both are set)
   * - It is the first non-done task in the story (sequential ordering)
   *
   * This supports multi-transition ownership: an agent picks up a task,
   * drives it through all teammate-allowed transitions, releases when
   * blocked by a lead-only transition, and re-picks-up when the lead
   * moves it to a state with teammate transitions available again.
   */
  getNextWorkableTask(memberCwd?: string): (TaskWithMeta & { availableTransitions: Array<{ state: string; permission: string }> }) | null {
    const stories = this.getStories();
    for (const story of stories) {
      if (!this.isStoryReady(story.id)) continue;

      // If the member has a cwd, only match stories with the same dir
      if (memberCwd && story.dir) {
        const normalizedStoryDir = story.dir.replace(/\/$/, "").replace(/^~/, Deno.env.get("HOME") || "~");
        const normalizedMemberCwd = memberCwd.replace(/\/$/, "");
        if (normalizedStoryDir !== normalizedMemberCwd) continue;
      }

      const wf = this.getWorkflowForStory(story.id);
      const doneState = getDoneState(wf);

      const tasks = this.getTasksForStory(story.id);
      for (const task of tasks) {
        // Skip done tasks
        if (task.status === doneState) continue;

        // Must not be claimed by anyone
        const assignment = this.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(task.id);
        if (assignment) break; // Sequential: if this task is claimed, don't look further in this story

        // Must have at least one teammate-allowed transition from current state
        const transitions = wf.transitions[task.status];
        if (!transitions) break;

        const available = Object.entries(transitions)
          .filter(([_, perm]) => perm === "teammate" || perm === "any")
          .map(([state, perm]) => ({ state, permission: perm as string }));

        if (available.length > 0) {
          return { ...task, availableTransitions: available };
        }

        // No teammate transitions available from this state — stop looking in this story
        break;
      }
    }
    return null;
  }

  // --- Assignments ---

  claimTask(taskId: string, memberId: string): boolean {
    const existing = this.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(taskId);
    if (existing) return false;

    this.db.prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)").run(taskId, memberId, Date.now());
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

  hasUnreadComments(taskId: string): boolean {
    this.ensureCommentsLoaded(taskId);
    const lastLead = this.db.prepare(
      "SELECT MAX(created_at) as t FROM comments WHERE task_id = ? AND from_id = 'lead'"
    ).get(taskId) as Record<string, unknown> | undefined;
    const lastTeammate = this.db.prepare(
      "SELECT MAX(created_at) as t FROM comments WHERE task_id = ? AND from_id != 'lead'"
    ).get(taskId) as Record<string, unknown> | undefined;

    if (!lastTeammate?.t) return false;

    const taskRow = this.db.prepare("SELECT last_read_at FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    const readTimestamp = Math.max((lastLead?.t as number) || 0, (taskRow?.last_read_at as number) || 0);

    if (readTimestamp === 0) return true;
    return (lastTeammate.t as number) > readTimestamp;
  }

  markCommentsRead(taskId: string): void {
    this.db.prepare("UPDATE tasks SET last_read_at = ? WHERE id = ?").run(Date.now(), taskId);
  }

  getInboxTasks(): TaskWithMeta[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE status IN ('needs_input', 'review') ORDER BY story_id, seq"
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToTask(row));
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

  registerMember(id: string, name: string, cwd: string, tmuxWindow: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO members (id, name, cwd, tmux_window, status, last_heartbeat)
       VALUES (?, ?, ?, ?, 'idle', ?)`
    ).run(id, name, cwd, tmuxWindow, Date.now());
  }

  updateMemberStatus(id: string, status: string): void {
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
  }

  heartbeat(id: string, status: string): void {
    this.db.prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?").run(status, Date.now(), id);
  }

  getMembers(): Member[] {
    const rows = this.db.prepare("SELECT * FROM members ORDER BY name").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      cwd: row.cwd as string,
      tmuxWindow: row.tmux_window as string,
      status: row.status as Member["status"],
      lastHeartbeat: row.last_heartbeat as number,
    }));
  }

  getMember(id: string): Member | null {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      cwd: row.cwd as string,
      tmuxWindow: row.tmux_window as string,
      status: row.status as Member["status"],
      lastHeartbeat: row.last_heartbeat as number,
    };
  }

  removeMember(id: string): void {
    this.db.prepare("DELETE FROM assignments WHERE member_id = ?").run(id);
    this.db.prepare("DELETE FROM members WHERE id = ?").run(id);
  }

  // --- Flush to disk ---

  flushToDisk(): void {
    const dirtyTasks = this.db.prepare("SELECT * FROM tasks WHERE dirty = 1").all() as Array<Record<string, unknown>>;
    for (const row of dirtyTasks) {
      const tokenUsage = this.getTokenUsage(row.id as string);
      const taskData: Record<string, unknown> = {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        result: row.result,
      };
      if (tokenUsage.length > 0) {
        taskData.tokenUsage = tokenUsage;
      }
      const taskFile = path.join(row.dir_path as string, "task.json");
      Deno.writeTextFileSync(taskFile, JSON.stringify(taskData, null, 2) + "\n");
    }
    if (dirtyTasks.length > 0) {
      this.db.prepare("UPDATE tasks SET dirty = 0 WHERE dirty = 1").run();
    }
  }

  // --- Autosave timers ---

  startTimers(): void {
    const flushMs = this.config.autosave.flushIntervalMinutes * 60 * 1000;
    this.flushTimer = setInterval(() => this.flushToDisk(), flushMs);

    if (this.config.autosave.autoCommit) {
      const commitMs = this.config.autosave.commitIntervalHours * 60 * 60 * 1000;
      this.commitTimer = setInterval(() => this.commitToGit(), commitMs);
    }
  }

  stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.commitTimer) clearInterval(this.commitTimer);
  }

  commitToGit(message?: string): void {
    const cwd = path.dirname(this.teamDir);
    try {
      const addCmd = new Deno.Command("git", { args: ["add", this.teamDir], cwd, stdout: "piped", stderr: "piped" });
      addCmd.outputSync();

      const statusCmd = new Deno.Command("git", { args: ["status", "--porcelain"], cwd, stdout: "piped", stderr: "piped" });
      const statusOutput = statusCmd.outputSync();
      const status = new TextDecoder().decode(statusOutput.stdout);

      if (status.trim()) {
        const commitMsg = message || this.config.autosave.commitMessage.replace("{timestamp}", new Date().toISOString());
        const commitCmd = new Deno.Command("git", { args: ["commit", "-m", commitMsg], cwd, stdout: "piped", stderr: "piped" });
        commitCmd.outputSync();
      }
    } catch {
      // Ignore git errors (nothing to commit, etc.)
    }
  }

  // --- Transition Instructions ---

  getTransitionInstructions(
    fromStatus: string,
    toStatus: string,
    workflowName?: string
  ): { exitInstructions?: string; enterInstructions?: string } {
    const result: { exitInstructions?: string; enterInstructions?: string } = {};
    const wfName = workflowName || this.config.defaultWorkflow;
    const wf = this.workflows[wfName];

    const exitFile = wf?.instructions?.[fromStatus] || `${fromStatus}.md`;
    const enterFile = wf?.instructions?.[toStatus] || `${toStatus}.md`;

    const exitContent = this.readInstructionFile(wfName, exitFile);
    if (exitContent) result.exitInstructions = exitContent;

    const enterContent = this.readInstructionFile(wfName, enterFile);
    if (enterContent) result.enterInstructions = enterContent;

    return result;
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

  // --- Workflow validation ---

  canTransition(taskId: string, newStatus: string, actor: "lead" | "teammate"): { ok: boolean; error?: string } {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: "Task not found" };

    const workflow = this.getWorkflowForTask(taskId);
    const currentStatus = task.status;
    const transitions = workflow.transitions[currentStatus];
    if (!transitions) return { ok: false, error: `No transitions from state "${currentStatus}"` };

    const permission = transitions[newStatus];
    if (!permission) return { ok: false, error: `Cannot transition from "${currentStatus}" to "${newStatus}"` };

    if (permission === "any") return { ok: true };
    if (permission === actor) return { ok: true };
    return { ok: false, error: `Transition "${currentStatus}" → "${newStatus}" requires "${permission}", got "${actor}"` };
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
    const tasks = this.getTasksForStory(storyId);
    for (const task of tasks) {
      this.removeTaskData(task.id);
    }
    this.db.prepare("DELETE FROM stories WHERE id = ?").run(storyId);
  }

  /** Delete a story and all its tasks, removing from SQLite and disk */
  deleteStory(storyId: string): boolean {
    const story = this.getStory(storyId);
    if (!story) return false;

    const tasks = this.getTasksForStory(storyId);
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    if (inProgress.length > 0) {
      throw new Error(`Cannot delete story "${storyId}": ${inProgress.length} task(s) are in progress`);
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
    const wf = this.getWorkflowForStory(storyId);
    const doneState = getDoneState(wf);
    return tasks.every((t) => t.status === doneState);
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

    Deno.renameSync(sourcePath, destPath);

    // Update story.json with archivedAt timestamp
    const storyFile = path.join(destPath, "story.json");
    const storyData = JSON.parse(Deno.readTextFileSync(storyFile));
    const archivedAt = new Date().toISOString();
    storyData.archivedAt = archivedAt;
    Deno.writeTextFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");

    // Generate SYNOPSIS.md
    const tasks = this.getTasksForStory(storyId);
    this.generateSynopsis(destPath, story, tasks, archivedAt);

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
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    if (inProgress.length > 0) {
      throw new Error(`Cannot backlog story "${storyId}": ${inProgress.length} task(s) are in progress`);
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

  // --- Assistant Queue ---

  enqueueAssistantItem(prompt: string): { id: string; prompt: string; status: string; createdAt: string } {
    const id = `asst-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare("INSERT INTO assistant_queue (id, prompt, status, created_at) VALUES (?, ?, 'pending', ?)").run(id, prompt, now);
    return { id, prompt, status: "pending", createdAt: new Date(now).toISOString() };
  }

  getAssistantQueue(): Array<{ id: string; prompt: string; status: string; result: string | null; createdAt: number; startedAt: number | null; completedAt: number | null }> {
    const rows = this.db.prepare("SELECT * FROM assistant_queue ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      prompt: row.prompt as string,
      status: row.status as string,
      result: row.result as string | null,
      createdAt: row.created_at as number,
      startedAt: row.started_at as number | null,
      completedAt: row.completed_at as number | null,
    }));
  }

  getNextAssistantItem(): { id: string; prompt: string } | null {
    const row = this.db.prepare("SELECT * FROM assistant_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: row.id as string, prompt: row.prompt as string };
  }

  claimAssistantItem(id: string): boolean {
    const row = this.db.prepare("SELECT status FROM assistant_queue WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row || row.status !== "pending") return false;
    this.db.prepare("UPDATE assistant_queue SET status = 'processing', started_at = ? WHERE id = ?").run(Date.now(), id);
    return true;
  }

  completeAssistantItem(id: string, result?: string, failed = false): boolean {
    const row = this.db.prepare("SELECT status FROM assistant_queue WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row || row.status !== "processing") return false;
    const status = failed ? "failed" : "done";
    this.db.prepare("UPDATE assistant_queue SET status = ?, result = ?, completed_at = ? WHERE id = ?").run(status, result || null, Date.now(), id);
    return true;
  }

  deleteAssistantItem(id: string): boolean {
    const row = this.db.prepare("SELECT * FROM assistant_queue WHERE id = ?").get(id);
    if (!row) return false;
    this.db.prepare("DELETE FROM assistant_queue WHERE id = ?").run(id);
    return true;
  }

  // --- Notes ---

  getAssistantNotes(): Array<{ id: string; title: string; content: string; categories: string[]; createdAt: string; updatedAt: string }> {
    const notesDir = path.join(this.teamDir, "notes");
    if (!existsSync(notesDir)) return [];
    const results: Array<{ id: string; title: string; content: string; categories: string[]; createdAt: string; updatedAt: string }> = [];

    const entries = [...Deno.readDirSync(notesDir)]
      .filter((e) => e.isFile && e.name.endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const filePath = path.join(notesDir, entry.name);
      const stat = Deno.statSync(filePath);
      const rawContent = Deno.readTextFileSync(filePath);
      const id = entry.name.replace(/\.md$/, "");

      const { categories, body } = parseFrontmatter(rawContent);

      const firstLine = body.trim().split("\n")[0] ?? "";
      const title = firstLine.startsWith("# ") ? firstLine.slice(2).trim() : id;
      results.push({
        id,
        title,
        content: body,
        categories,
        createdAt: (stat.birthtime ?? stat.mtime ?? new Date()).toISOString(),
        updatedAt: (stat.mtime ?? new Date()).toISOString(),
      });
    }
    return results;
  }

  saveAssistantNote(title: string, content: string, categories?: string[]): { id: string; title: string; content: string; categories: string[]; createdAt: string; updatedAt: string } {
    const notesDir = path.join(this.teamDir, "notes");
    Deno.mkdirSync(notesDir, { recursive: true });
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || `note-${Date.now()}`;
    const filePath = path.join(notesDir, `${id}.md`);
    const body = content.startsWith("# ") ? content : `# ${title}\n\n${content}`;
    const cats = categories || [];

    const fullContent = serializeFrontmatter(cats, body);
    Deno.writeTextFileSync(filePath, fullContent);
    const stat = Deno.statSync(filePath);
    return {
      id,
      title,
      content: body,
      categories: cats,
      createdAt: (stat.birthtime ?? stat.mtime ?? new Date()).toISOString(),
      updatedAt: (stat.mtime ?? new Date()).toISOString(),
    };
  }

  updateNoteCategories(id: string, categories: string[]): boolean {
    const notesDir = path.join(this.teamDir, "notes");
    const filePath = path.join(notesDir, `${id}.md`);
    if (!existsSync(filePath)) return false;

    const rawContent = Deno.readTextFileSync(filePath);
    const { body } = parseFrontmatter(rawContent);
    const newContent = serializeFrontmatter(categories, body);
    Deno.writeTextFileSync(filePath, newContent);
    return true;
  }

  deleteAssistantNote(id: string): boolean {
    const notesDir = path.join(this.teamDir, "notes");
    const filePath = path.join(notesDir, `${id}.md`);
    if (!existsSync(filePath)) return false;
    Deno.removeSync(filePath);
    return true;
  }

  // --- Spawn Requests ---

  /** Create a spawn request */
  createSpawnRequest(hostId: string, cwd?: string, storyId?: string, reason?: string): { id: string; hostId: string; cwd?: string; storyId?: string; reason?: string; status: string; createdAt: string } {
    const id = `spawn-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO spawn_requests (id, host_id, cwd, story_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).run(id, hostId, cwd || null, storyId || null, reason || null, now);
    return { id, hostId, cwd, storyId, reason, status: "pending", createdAt: new Date(now).toISOString() };
  }

  /** Get pending spawn requests for a specific host */
  getSpawnRequests(hostId: string): Array<{ id: string; hostId: string; cwd?: string; storyId?: string; reason?: string; status: string; createdAt: string; ackedAt?: string }> {
    const rows = this.db.prepare(
      "SELECT * FROM spawn_requests WHERE host_id = ? AND status = 'pending' ORDER BY created_at ASC"
    ).all(hostId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      hostId: row.host_id as string,
      cwd: (row.cwd as string) || undefined,
      storyId: (row.story_id as string) || undefined,
      reason: (row.reason as string) || undefined,
      status: row.status as string,
      createdAt: new Date(row.created_at as number).toISOString(),
      ackedAt: row.acked_at ? new Date(row.acked_at as number).toISOString() : undefined,
    }));
  }

  /** Acknowledge a spawn request (mark as acked) */
  ackSpawnRequest(id: string): boolean {
    const row = this.db.prepare("SELECT status FROM spawn_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row || row.status !== "pending") return false;
    this.db.prepare("UPDATE spawn_requests SET status = 'acked', acked_at = ? WHERE id = ?").run(Date.now(), id);
    return true;
  }

  // --- Cleanup ---

  close(): void {
    this.stopTimers();
    this.flushToDisk();
    this.db.close();
  }
}
