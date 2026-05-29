// SQLite store + JSON file sync
//
// This is the core data layer for the team lead. It:
// - Initializes the SQLite schema (state.db) in WAL mode
// - Loads story.json and task.json files from disk into SQLite at startup
// - Lazy-loads messages.jsonl only when a task's messages are first accessed
// - Provides CRUD operations for stories, tasks, assignments, members, messages
// - Validates workflow transitions (canTransition)
// - Flushes dirty task state back to JSON files periodically
// - Commits to git on a configurable schedule
//
// Key invariants:
// - JSON files are the source of truth for story/task definitions
// - SQLite is the runtime engine for fast atomic reads/writes
// - Messages are always appended to JSONL immediately (never lost)
// - Assignments and members are ephemeral (never written to JSON)
// - The `dirty` flag on tasks tracks what needs flushing to disk
import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { slugify, getInitialState, getDoneState } from "../shared/types.js";
import type { Message, Story, Task, TaskWithMeta, TeamConfig, WorkflowConfig, Member, Assignment, TransitionInstructions } from "../shared/types.js";

export class Store {
  private db: Database.Database;
  private teamDir: string;
  private config: TeamConfig;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;
  private transitionInstructionsCache: Map<string, { content: string; mtime: number; cachedAt: number }> = new Map();
  private transitionCacheTTL = 30000; // 30 seconds

  constructor(teamDir: string, config: TeamConfig) {
    this.teamDir = teamDir;
    this.config = config;
    const dbPath = path.join(teamDir, "state.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.initSchema();
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

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id),
        from_id TEXT,
        body TEXT,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages_loaded (
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
    `);

    // Migration: add dir column if it doesn't exist (for existing databases)
    const storyColumns = this.db.prepare("PRAGMA table_info(stories)").all() as any[];
    if (!storyColumns.some((col: any) => col.name === "dir")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN dir TEXT");
    }

    // Migration: add workflow column if it doesn't exist
    if (!storyColumns.some((col: any) => col.name === "workflow")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN workflow TEXT");
    }

    // Migration: add last_read_at column to tasks if it doesn't exist
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as any[];
    if (!taskColumns.some((col: any) => col.name === "last_read_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN last_read_at INTEGER");
    }
  }

  // --- Load from filesystem ---

  loadFromDisk(): void {
    const storiesDir = path.join(this.teamDir, "stories");
    if (!fs.existsSync(storiesDir)) return;

    for (const storyDirName of fs.readdirSync(storiesDir)) {
      const storyDirPath = path.join(storiesDir, storyDirName);
      if (!fs.statSync(storyDirPath).isDirectory()) continue;

      const storyFile = path.join(storyDirPath, "story.json");
      if (!fs.existsSync(storyFile)) continue;

      const story: Story = JSON.parse(fs.readFileSync(storyFile, "utf-8"));
      this.upsertStory(story, storyDirPath);

      const tasksDir = path.join(storyDirPath, "tasks");
      if (!fs.existsSync(tasksDir)) continue;

      const taskDirs = fs.readdirSync(tasksDir).sort();
      for (const taskDirName of taskDirs) {
        const taskDirPath = path.join(tasksDir, taskDirName);
        if (!fs.statSync(taskDirPath).isDirectory()) continue;

        const taskFile = path.join(taskDirPath, "task.json");
        if (!fs.existsSync(taskFile)) continue;

        const task: Task = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
        const match = taskDirName.match(/^(\d+)-(.+)$/);
        const seq = match ? parseInt(match[1], 10) : 0;
        const slug = match ? match[2] : taskDirName;

        this.upsertTask(task, story.id, seq, slug, taskDirPath);
      }
    }
  }

  private upsertStory(story: Story, dirPath: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO stories (id, title, description, status, depends_on, dir, workflow, dir_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(story.id, story.title, story.description, story.status, JSON.stringify(story.dependsOn), story.dir || null, story.workflow || null, dirPath);
  }

  private upsertTask(task: Task, storyId: string, seq: number, slug: string, dirPath: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (id, story_id, seq, slug, title, description, status, result, dir_path, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(task.id, storyId, seq, slug, task.title, task.description, task.status, task.result, dirPath);
  }

  // --- Stories ---

  /** Map a raw SQLite row to a Story object */
  private rowToStory(row: any): Story & { dirPath: string } {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      dependsOn: JSON.parse(row.depends_on),
      dir: row.dir || undefined,
      workflow: row.workflow || undefined,
      dirPath: row.dir_path,
    };
  }

  /** Map a raw SQLite row to a TaskWithMeta object */
  private rowToTask(row: any): TaskWithMeta {
    return {
      id: row.id,
      storyId: row.story_id,
      seq: row.seq,
      slug: row.slug,
      title: row.title,
      description: row.description,
      status: row.status,
      result: row.result,
      dirPath: row.dir_path,
    };
  }

  getStories(): (Story & { dirPath: string })[] {
    return this.db
      .prepare("SELECT * FROM stories ORDER BY id")
      .all()
      .map((row: any) => this.rowToStory(row));
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
    workflow?: string
  ): { story: Story; tasks: TaskWithMeta[] } {
    const storiesDir = path.join(this.teamDir, "stories");
    const storyDirName = id;
    const storyDirPath = path.join(storiesDir, storyDirName);

    // Create directory structure
    fs.mkdirSync(storyDirPath, { recursive: true });

    const storyData: Story = { id, title, description, status, dependsOn };
    if (dir) storyData.dir = dir;
    if (workflow) storyData.workflow = workflow;
    const storyFile = path.join(storyDirPath, "story.json");
    fs.writeFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");

    // Insert into DB
    this.upsertStory(storyData, storyDirPath);

    const createdTasks: TaskWithMeta[] = [];

    // Resolve initial task status from the story's workflow
    const wfName = workflow || this.config.defaultWorkflow;
    const wf = this.config.workflows[wfName] || this.config.workflows[this.config.defaultWorkflow];
    const initialStatus = getInitialState(wf);

    if (tasks && tasks.length > 0) {
      const tasksDir = path.join(storyDirPath, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });

      for (let i = 0; i < tasks.length; i++) {
        const seq = i + 1;
        const slug = slugify(tasks[i].title);
        const taskId = `${id}-${seq}`;
        const taskDirName = `${String(seq).padStart(2, "0")}-${slug}`;
        const taskDirPath = path.join(tasksDir, taskDirName);

        fs.mkdirSync(taskDirPath, { recursive: true });

        const taskData: Task = {
          id: taskId,
          title: tasks[i].title,
          description: tasks[i].description,
          status: initialStatus,
          result: null,
        };
        const taskFile = path.join(taskDirPath, "task.json");
        fs.writeFileSync(taskFile, JSON.stringify(taskData, null, 2) + "\n");

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
    const row: any = this.db.prepare("SELECT * FROM stories WHERE id = ?").get(id);
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

  updateStoryDetails(storyId: string, updates: { title?: string; description?: string; status?: "open" | "done"; dependsOn?: string[]; dir?: string | null; workflow?: string | null }): boolean {
    const story = this.getStory(storyId);
    if (!story) return false;

    const newTitle = updates.title ?? story.title;
    const newDescription = updates.description ?? story.description;
    const newStatus = updates.status ?? story.status;
    const newDependsOn = updates.dependsOn ?? story.dependsOn;
    const newDir = updates.dir !== undefined ? (updates.dir || null) : (story.dir || null);
    const newWorkflow = updates.workflow !== undefined ? (updates.workflow || null) : (story.workflow || null);

    this.db
      .prepare(
        `UPDATE stories SET title = ?, description = ?, status = ?, depends_on = ?, dir = ?, workflow = ? WHERE id = ?`
      )
      .run(newTitle, newDescription, newStatus, JSON.stringify(newDependsOn), newDir, newWorkflow, storyId);

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
    fs.writeFileSync(storyFile, JSON.stringify(data, null, 2) + "\n");

    return true;
  }

  updateStoryStatus(storyId: string, status: "open" | "done"): void {
    this.db.prepare("UPDATE stories SET status = ? WHERE id = ?").run(status, storyId);
    // Write back to disk
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
      fs.writeFileSync(storyFile, JSON.stringify(data, null, 2) + "\n");
    }
  }

  // --- Tasks ---

  getTasksForStory(storyId: string): TaskWithMeta[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE story_id = ? ORDER BY seq")
      .all(storyId)
      .map((row: any) => this.rowToTask(row));
  }

  getTask(taskId: string): TaskWithMeta | null {
    const row: any = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
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
    this.db
      .prepare("UPDATE tasks SET title = ?, description = ?, dirty = 1 WHERE id = ?")
      .run(newTitle, newDescription, taskId);
    return true;
  }

  deleteTask(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    this.removeTaskData(taskId);

    // Remove task directory from disk
    if (task.dirPath && fs.existsSync(task.dirPath)) {
      fs.rmSync(task.dirPath, { recursive: true });
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
      // (or stories with no dir set — those are available to anyone)
      if (memberCwd && story.dir) {
        const normalizedStoryDir = story.dir.replace(/\/$/, "").replace(/^~/, process.env.HOME || "~");
        const normalizedMemberCwd = memberCwd.replace(/\/$/, "");
        if (normalizedStoryDir !== normalizedMemberCwd) continue;
      }

      const wf = this.getWorkflowForStory(story.id);
      const initialState = getInitialState(wf);
      const doneState = getDoneState(wf);

      const tasks = this.getTasksForStory(story.id);
      for (const task of tasks) {
        if (task.status === initialState) {
          // Check not already assigned
          const assignment: any = this.db
            .prepare("SELECT * FROM assignments WHERE task_id = ?")
            .get(task.id);
          if (!assignment) return task;
          break; // Only first initial-state task per story
        }
        // If a task is not done, can't proceed to next in sequence
        if (task.status !== doneState) break;
      }
    }
    return null;
  }

  // --- Assignments ---

  claimTask(taskId: string, memberId: string): boolean {
    const existing: any = this.db
      .prepare("SELECT * FROM assignments WHERE task_id = ?")
      .get(taskId);
    if (existing) return false;

    this.db
      .prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)")
      .run(taskId, memberId, Date.now());
    return true;
  }

  releaseTask(taskId: string): void {
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
  }

  getAssignment(taskId: string): Assignment | null {
    const row: any = this.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(taskId);
    if (!row) return null;
    return { taskId: row.task_id, memberId: row.member_id, claimedAt: row.claimed_at };
  }

  getAssignmentForMember(memberId: string): (Assignment & { task: TaskWithMeta }) | null {
    const row: any = this.db
      .prepare("SELECT * FROM assignments WHERE member_id = ?")
      .get(memberId);
    if (!row) return null;
    const task = this.getTask(row.task_id);
    if (!task) return null;
    return { taskId: row.task_id, memberId: row.member_id, claimedAt: row.claimed_at, task };
  }

  // --- Messages ---

  private ensureMessagesLoaded(taskId: string): void {
    const loaded: any = this.db
      .prepare("SELECT * FROM messages_loaded WHERE task_id = ?")
      .get(taskId);
    if (loaded) return;

    const task = this.getTask(taskId);
    if (!task) return;

    const messagesFile = path.join(task.dirPath, "messages.jsonl");
    if (fs.existsSync(messagesFile)) {
      const lines = fs.readFileSync(messagesFile, "utf-8").split("\n").filter(Boolean);
      const insert = this.db.prepare(
        "INSERT INTO messages (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)"
      );
      for (const line of lines) {
        const msg: Message = JSON.parse(line);
        insert.run(taskId, msg.from, msg.body, new Date(msg.at).getTime());
      }
    }

    this.db
      .prepare("INSERT INTO messages_loaded (task_id, loaded_at) VALUES (?, ?)")
      .run(taskId, Date.now());
  }

  getMessages(taskId: string): Message[] {
    this.ensureMessagesLoaded(taskId);
    return this.db
      .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at")
      .all(taskId)
      .map((row: any) => ({
        from: row.from_id,
        body: row.body,
        at: new Date(row.created_at).toISOString(),
      }));
  }

  addMessage(taskId: string, from: string, body: string): void {
    const now = Date.now();
    this.ensureMessagesLoaded(taskId);
    this.db
      .prepare("INSERT INTO messages (task_id, from_id, body, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, from, body, now);

    // Immediately append to JSONL file
    const task = this.getTask(taskId);
    if (task) {
      const messagesFile = path.join(task.dirPath, "messages.jsonl");
      const msg: Message = { from, body, at: new Date(now).toISOString() };
      fs.appendFileSync(messagesFile, JSON.stringify(msg) + "\n");
    }
  }

  hasUnreadMessages(taskId: string): boolean {
    // Check if there are teammate messages newer than both the last lead
    // message AND the last_read_at timestamp (mark-as-read without replying).
    this.ensureMessagesLoaded(taskId);
    const lastLead: any = this.db
      .prepare(
        "SELECT MAX(created_at) as t FROM messages WHERE task_id = ? AND from_id = 'lead'"
      )
      .get(taskId);
    const lastTeammate: any = this.db
      .prepare(
        "SELECT MAX(created_at) as t FROM messages WHERE task_id = ? AND from_id != 'lead'"
      )
      .get(taskId);

    if (!lastTeammate?.t) return false;

    // Determine the latest "read" point: max of last lead message and last_read_at
    const taskRow: any = this.db
      .prepare("SELECT last_read_at FROM tasks WHERE id = ?")
      .get(taskId);
    const readTimestamp = Math.max(lastLead?.t || 0, taskRow?.last_read_at || 0);

    if (readTimestamp === 0) return true; // No lead message and never marked read
    return lastTeammate.t > readTimestamp;
  }

  markMessagesRead(taskId: string): void {
    this.db
      .prepare("UPDATE tasks SET last_read_at = ? WHERE id = ?")
      .run(Date.now(), taskId);
  }

  getInboxTasks(): TaskWithMeta[] {
    // Find tasks that are in a lead-required state with unread teammate messages
    return this.db
      .prepare("SELECT * FROM tasks WHERE status IN ('needs_input', 'review') ORDER BY story_id, seq")
      .all()
      .map((row: any) => this.rowToTask(row));
  }

  // --- Token Usage ---

  addTokenUsage(taskId: string, inputTokens: number, outputTokens: number, model: string, costUsd: number): void {
    const now = Date.now();
    this.db
      .prepare("INSERT INTO token_usage (task_id, input_tokens, output_tokens, model, cost_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(taskId, inputTokens, outputTokens, model, costUsd, now);
    // Mark task dirty so tokenUsage is included in next flush
    this.db.prepare("UPDATE tasks SET dirty = 1 WHERE id = ?").run(taskId);
  }

  getTokenUsage(taskId: string): Array<{ inputTokens: number; outputTokens: number; model: string; costUsd: number; at: string }> {
    const rows: any[] = this.db
      .prepare("SELECT * FROM token_usage WHERE task_id = ? ORDER BY recorded_at")
      .all(taskId);
    return rows.map((row: any) => ({
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      model: row.model,
      costUsd: row.cost_usd,
      at: new Date(row.recorded_at).toISOString(),
    }));
  }

  getTokenUsageSummary(taskId: string): { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } | null {
    const row: any = this.db
      .prepare("SELECT SUM(input_tokens) as inp, SUM(output_tokens) as out, SUM(cost_usd) as cost FROM token_usage WHERE task_id = ?")
      .get(taskId);
    if (!row || row.cost === null) return null;
    return { totalCostUsd: row.cost, totalInputTokens: row.inp, totalOutputTokens: row.out };
  }

  // --- Members ---

  registerMember(id: string, name: string, cwd: string, tmuxWindow: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO members (id, name, cwd, tmux_window, status, last_heartbeat)
       VALUES (?, ?, ?, ?, 'idle', ?)`
      )
      .run(id, name, cwd, tmuxWindow, Date.now());
  }

  updateMemberStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?")
      .run(status, Date.now(), id);
  }

  heartbeat(id: string, status: string): void {
    this.db
      .prepare("UPDATE members SET status = ?, last_heartbeat = ? WHERE id = ?")
      .run(status, Date.now(), id);
  }

  getMembers(): Member[] {
    return this.db
      .prepare("SELECT * FROM members ORDER BY name")
      .all()
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        cwd: row.cwd,
        tmuxWindow: row.tmux_window,
        status: row.status,
        lastHeartbeat: row.last_heartbeat,
      }));
  }

  getMember(id: string): Member | null {
    const row: any = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      cwd: row.cwd,
      tmuxWindow: row.tmux_window,
      status: row.status,
      lastHeartbeat: row.last_heartbeat,
    };
  }

  removeMember(id: string): void {
    // Release any assigned tasks
    this.db.prepare("DELETE FROM assignments WHERE member_id = ?").run(id);
    this.db.prepare("DELETE FROM members WHERE id = ?").run(id);
  }

  // --- Flush to disk ---

  flushToDisk(): void {
    const dirtyTasks: any[] = this.db.prepare("SELECT * FROM tasks WHERE dirty = 1").all();
    for (const row of dirtyTasks) {
      const tokenUsage = this.getTokenUsage(row.id);
      const taskData: any = {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        result: row.result,
      };
      if (tokenUsage.length > 0) {
        taskData.tokenUsage = tokenUsage;
      }
      const taskFile = path.join(row.dir_path, "task.json");
      fs.writeFileSync(taskFile, JSON.stringify(taskData, null, 2) + "\n");
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
      execSync(`git add "${this.teamDir}"`, { cwd, stdio: "pipe" });
      const status = execSync("git status --porcelain", { cwd, stdio: "pipe" }).toString();
      if (status.trim()) {
        const commitMsg =
          message || this.config.autosave.commitMessage.replace("{timestamp}", new Date().toISOString());
        execSync(`git commit -m "${commitMsg}"`, { cwd, stdio: "pipe" });
      }
    } catch {
      // Ignore git errors (nothing to commit, etc.)
    }
  }

  // --- Transition Instructions ---

  getTransitionInstructions(
    fromStatus: string,
    toStatus: string
  ): { exitInstructions?: string; enterInstructions?: string } {
    const result: { exitInstructions?: string; enterInstructions?: string } = {};

    const exitContent = this.readTransitionFile(`on-exit-${fromStatus}.md`);
    if (exitContent) result.exitInstructions = exitContent;

    const enterContent = this.readTransitionFile(`on-enter-${toStatus}.md`);
    if (enterContent) result.enterInstructions = enterContent;

    return result;
  }

  private readTransitionFile(filename: string): string | undefined {
    const filePath = path.join(this.teamDir, filename);

    // Check cache
    const cached = this.transitionInstructionsCache.get(filename);
    if (cached) {
      try {
        const stat = fs.statSync(filePath);
        const mtime = stat.mtimeMs;
        if (mtime === cached.mtime && Date.now() - cached.cachedAt < this.transitionCacheTTL) {
          return cached.content;
        }
      } catch {
        // File deleted, remove from cache
        this.transitionInstructionsCache.delete(filename);
        return undefined;
      }
    }

    // Read from disk
    try {
      if (!fs.existsSync(filePath)) return undefined;
      const content = fs.readFileSync(filePath, "utf-8");
      const stat = fs.statSync(filePath);
      this.transitionInstructionsCache.set(filename, { content, mtime: stat.mtimeMs, cachedAt: Date.now() });
      return content;
    } catch {
      return undefined;
    }
  }

  // --- Workflow validation ---

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

    for (let i = 0; i < tasks.length; i++) {
      lines.push(`${i + 1}. ${tasks[i].title}`);
    }
    lines.push("");

    fs.writeFileSync(path.join(destPath, "SYNOPSIS.md"), lines.join("\n"));
  }

  /** Remove all task-related data from SQLite (assignments, messages, token_usage, task row) */
  private removeTaskData(taskId: string): void {
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM messages WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM messages_loaded WHERE task_id = ?").run(taskId);
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

    // Check no tasks are in_progress (safety check)
    const tasks = this.getTasksForStory(storyId);
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    if (inProgress.length > 0) {
      throw new Error(`Cannot delete story "${storyId}": ${inProgress.length} task(s) are in progress`);
    }

    this.removeStoryFromDb(storyId);

    // Remove story directory from disk
    if (story.dirPath && fs.existsSync(story.dirPath)) {
      fs.rmSync(story.dirPath, { recursive: true });
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
    fs.mkdirSync(archivedDir, { recursive: true });

    const sourcePath = story.dirPath;
    const destPath = path.join(archivedDir, storyId);

    // Move directory
    fs.renameSync(sourcePath, destPath);

    // Update story.json with archivedAt timestamp
    const storyFile = path.join(destPath, "story.json");
    const storyData = JSON.parse(fs.readFileSync(storyFile, "utf-8"));
    const archivedAt = new Date().toISOString();
    storyData.archivedAt = archivedAt;
    fs.writeFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");

    // Generate SYNOPSIS.md
    const tasks = this.getTasksForStory(storyId);
    this.generateSynopsis(destPath, story, tasks, archivedAt);

    // Remove from SQLite
    this.removeStoryFromDb(storyId);
  }

  getArchivedStories(): Array<{ id: string; title: string; synopsis: string }> {
    const archivedDir = path.join(this.teamDir, "archived");
    if (!fs.existsSync(archivedDir)) return [];

    const results: Array<{ id: string; title: string; synopsis: string }> = [];
    for (const dirName of fs.readdirSync(archivedDir)) {
      const dirPath = path.join(archivedDir, dirName);
      if (!fs.statSync(dirPath).isDirectory()) continue;

      const storyFile = path.join(dirPath, "story.json");
      if (!fs.existsSync(storyFile)) continue;

      const storyData = JSON.parse(fs.readFileSync(storyFile, "utf-8"));

      // Read synopsis if available, otherwise use description
      let synopsis = storyData.description || "";
      const synopsisFile = path.join(dirPath, "SYNOPSIS.md");
      if (fs.existsSync(synopsisFile)) {
        synopsis = fs.readFileSync(synopsisFile, "utf-8");
      }

      results.push({
        id: storyData.id,
        title: storyData.title,
        synopsis,
      });
    }
    return results;
  }

  getArchivedStoryContext(storyId: string): { story: any; tasks: any[]; messages: Record<string, Message[]> } | null {
    const archivedDir = path.join(this.teamDir, "archived", storyId);
    if (!fs.existsSync(archivedDir)) return null;

    const storyFile = path.join(archivedDir, "story.json");
    if (!fs.existsSync(storyFile)) return null;

    const story = JSON.parse(fs.readFileSync(storyFile, "utf-8"));
    const tasks: any[] = [];
    const messages: Record<string, Message[]> = {};

    const tasksDir = path.join(archivedDir, "tasks");
    if (fs.existsSync(tasksDir)) {
      const taskDirs = fs.readdirSync(tasksDir).sort();
      for (const taskDirName of taskDirs) {
        const taskDirPath = path.join(tasksDir, taskDirName);
        if (!fs.statSync(taskDirPath).isDirectory()) continue;

        const taskFile = path.join(taskDirPath, "task.json");
        if (!fs.existsSync(taskFile)) continue;

        const task = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
        tasks.push(task);

        // Load messages for this task
        const messagesFile = path.join(taskDirPath, "messages.jsonl");
        if (fs.existsSync(messagesFile)) {
          const lines = fs.readFileSync(messagesFile, "utf-8").split("\n").filter(Boolean);
          messages[task.id] = lines.map((line: string) => JSON.parse(line) as Message);
        }
      }
    }

    return { story, tasks, messages };
  }

  /** Resolve the effective workflow for a story (story override → defaultWorkflow) */
  getWorkflowForStory(storyId: string): WorkflowConfig {
    const story = this.getStory(storyId);
    const workflowName = story?.workflow || this.config.defaultWorkflow;
    return this.config.workflows[workflowName] || this.config.workflows[this.config.defaultWorkflow];
  }

  /** Resolve the effective workflow for a task (via its parent story) */
  getWorkflowForTask(taskId: string): WorkflowConfig {
    const task = this.getTask(taskId);
    if (!task) return this.config.workflows[this.config.defaultWorkflow];
    return this.getWorkflowForStory(task.storyId);
  }

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

  // --- Assistant Queue ---

  enqueueAssistantItem(prompt: string): { id: string; prompt: string; status: string; createdAt: string } {
    const id = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare("INSERT INTO assistant_queue (id, prompt, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(id, prompt, now);
    return { id, prompt, status: "pending", createdAt: new Date(now).toISOString() };
  }

  getAssistantQueue(): Array<{ id: string; prompt: string; status: string; result: string | null; createdAt: number; startedAt: number | null; completedAt: number | null }> {
    return this.db
      .prepare("SELECT * FROM assistant_queue ORDER BY created_at DESC")
      .all() as any[];
  }

  getNextAssistantItem(): { id: string; prompt: string } | null {
    const row: any = this.db
      .prepare("SELECT * FROM assistant_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
      .get();
    if (!row) return null;
    return { id: row.id, prompt: row.prompt };
  }

  claimAssistantItem(id: string): boolean {
    const row: any = this.db.prepare("SELECT status FROM assistant_queue WHERE id = ?").get(id);
    if (!row || row.status !== "pending") return false;
    this.db.prepare("UPDATE assistant_queue SET status = 'processing', started_at = ? WHERE id = ?").run(Date.now(), id);
    return true;
  }

  completeAssistantItem(id: string, result?: string, failed = false): boolean {
    const row: any = this.db.prepare("SELECT status FROM assistant_queue WHERE id = ?").get(id);
    if (!row || row.status !== "processing") return false;
    const status = failed ? "failed" : "done";
    this.db.prepare("UPDATE assistant_queue SET status = ?, result = ?, completed_at = ? WHERE id = ?").run(status, result || null, Date.now(), id);
    return true;
  }

  deleteAssistantItem(id: string): boolean {
    const row: any = this.db.prepare("SELECT * FROM assistant_queue WHERE id = ?").get(id);
    if (!row) return false;
    this.db.prepare("DELETE FROM assistant_queue WHERE id = ?").run(id);
    return true;
  }

  // --- Notes ---

  getAssistantNotes(): Array<{ id: string; title: string; content: string; createdAt: string; updatedAt: string }> {
    const notesDir = path.join(this.teamDir, "notes");
    if (!fs.existsSync(notesDir)) return [];
    const results: Array<{ id: string; title: string; content: string; createdAt: string; updatedAt: string }> = [];
    for (const filename of fs.readdirSync(notesDir).sort()) {
      if (!filename.endsWith(".md")) continue;
      const filePath = path.join(notesDir, filename);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, "utf-8");
      const id = filename.replace(/\.md$/, "");
      // Extract title from first line (# Title) or use filename
      const firstLine = content.split("\n")[0];
      const title = firstLine.startsWith("# ") ? firstLine.slice(2).trim() : id;
      results.push({
        id,
        title,
        content,
        createdAt: new Date(stat.birthtime).toISOString(),
        updatedAt: new Date(stat.mtime).toISOString(),
      });
    }
    return results;
  }

  saveAssistantNote(title: string, content: string): { id: string; title: string; content: string; createdAt: string; updatedAt: string } {
    const notesDir = path.join(this.teamDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || `note-${Date.now()}`;
    const filePath = path.join(notesDir, `${id}.md`);
    const fullContent = content.startsWith("# ") ? content : `# ${title}\n\n${content}`;
    fs.writeFileSync(filePath, fullContent);
    const stat = fs.statSync(filePath);
    return {
      id,
      title,
      content: fullContent,
      createdAt: new Date(stat.birthtime).toISOString(),
      updatedAt: new Date(stat.mtime).toISOString(),
    };
  }

  deleteAssistantNote(id: string): boolean {
    const notesDir = path.join(this.teamDir, "notes");
    const filePath = path.join(notesDir, `${id}.md`);
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath);
    return true;
  }

  // --- Cleanup ---

  close(): void {
    this.stopTimers();
    this.flushToDisk();
    this.db.close();
  }
}
