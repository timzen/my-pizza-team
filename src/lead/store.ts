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
import type { Message, Story, Task, TaskWithMeta, TeamConfig, Member, Assignment, TransitionInstructions } from "../shared/types.js";

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
    `);

    // Migration: add dir column if it doesn't exist (for existing databases)
    const storyColumns = this.db.prepare("PRAGMA table_info(stories)").all() as any[];
    if (!storyColumns.some((col: any) => col.name === "dir")) {
      this.db.exec("ALTER TABLE stories ADD COLUMN dir TEXT");
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
        `INSERT OR REPLACE INTO stories (id, title, description, status, depends_on, dir, dir_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(story.id, story.title, story.description, story.status, JSON.stringify(story.dependsOn), story.dir || null, dirPath);
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

  getStories(): (Story & { dirPath: string })[] {
    return this.db
      .prepare("SELECT * FROM stories ORDER BY id")
      .all()
      .map((row: any) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        dependsOn: JSON.parse(row.depends_on),
        dir: row.dir || undefined,
        dirPath: row.dir_path,
      }));
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
    dir?: string
  ): { story: Story; tasks: TaskWithMeta[] } {
    const storiesDir = path.join(this.teamDir, "stories");
    const storyDirName = id;
    const storyDirPath = path.join(storiesDir, storyDirName);

    // Create directory structure
    fs.mkdirSync(storyDirPath, { recursive: true });

    const storyData: Story = { id, title, description, status, dependsOn };
    if (dir) storyData.dir = dir;
    const storyFile = path.join(storyDirPath, "story.json");
    fs.writeFileSync(storyFile, JSON.stringify(storyData, null, 2) + "\n");

    // Insert into DB
    this.upsertStory(storyData, storyDirPath);

    const createdTasks: TaskWithMeta[] = [];

    if (tasks && tasks.length > 0) {
      const tasksDir = path.join(storyDirPath, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });

      for (let i = 0; i < tasks.length; i++) {
        const seq = i + 1;
        const slug = tasks[i].title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40);
        const taskId = `${id}-${seq}`;
        const taskDirName = `${String(seq).padStart(2, "0")}-${slug}`;
        const taskDirPath = path.join(tasksDir, taskDirName);

        fs.mkdirSync(taskDirPath, { recursive: true });

        const taskData: Task = {
          id: taskId,
          title: tasks[i].title,
          description: tasks[i].description,
          status: "todo",
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
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      dependsOn: JSON.parse(row.depends_on),
      dir: row.dir || undefined,
      dirPath: row.dir_path,
    };
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
      fs.writeFileSync(storyFile, JSON.stringify(data, null, 2) + "\n");
    }
  }

  // --- Tasks ---

  getTasksForStory(storyId: string): TaskWithMeta[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE story_id = ? ORDER BY seq")
      .all(storyId)
      .map((row: any) => ({
        id: row.id,
        storyId: row.story_id,
        seq: row.seq,
        slug: row.slug,
        title: row.title,
        description: row.description,
        status: row.status,
        result: row.result,
        dirPath: row.dir_path,
      }));
  }

  getTask(taskId: string): TaskWithMeta | null {
    const row: any = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!row) return null;
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

  updateTaskStatus(taskId: string, status: string, result?: string): void {
    if (result !== undefined) {
      this.db.prepare("UPDATE tasks SET status = ?, result = ?, dirty = 1 WHERE id = ?").run(status, result, taskId);
    } else {
      this.db.prepare("UPDATE tasks SET status = ?, dirty = 1 WHERE id = ?").run(status, taskId);
    }

    // Check if story is complete
    const task = this.getTask(taskId);
    if (task && status === "done") {
      const tasks = this.getTasksForStory(task.storyId);
      if (tasks.every((t) => t.status === "done")) {
        this.updateStoryStatus(task.storyId, "done");
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

    // Remove from assignments if any
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
    // Remove messages
    this.db.prepare("DELETE FROM messages WHERE task_id = ?").run(taskId);
    this.db.prepare("DELETE FROM messages_loaded WHERE task_id = ?").run(taskId);
    // Remove token usage
    this.db.prepare("DELETE FROM token_usage WHERE task_id = ?").run(taskId);
    // Remove task
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);

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
   * - Task must be in "todo" state
   * - Must be the first "todo" task in the story (sequential)
   * - Must not already be assigned
   */
  getNextAvailableTask(): TaskWithMeta | null {
    const stories = this.getStories();
    for (const story of stories) {
      if (!this.isStoryReady(story.id)) continue;

      const tasks = this.getTasksForStory(story.id);
      for (const task of tasks) {
        if (task.status === "todo") {
          // Check not already assigned
          const assignment: any = this.db
            .prepare("SELECT * FROM assignments WHERE task_id = ?")
            .get(task.id);
          if (!assignment) return task;
          break; // Only first todo task per story
        }
        // If a task is not done, can't proceed to next in sequence
        if (task.status !== "done") break;
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
    const tasks: any[] = this.db
      .prepare("SELECT * FROM tasks WHERE status IN ('needs_input', 'review') ORDER BY story_id, seq")
      .all();
    return tasks.map((row: any) => ({
      id: row.id,
      storyId: row.story_id,
      seq: row.seq,
      slug: row.slug,
      title: row.title,
      description: row.description,
      status: row.status,
      result: row.result,
      dirPath: row.dir_path,
    }));
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

  canTransition(taskId: string, newStatus: string, actor: "lead" | "teammate"): { ok: boolean; error?: string } {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: "Task not found" };

    const currentStatus = task.status;
    const transitions = this.config.workflow.transitions[currentStatus];
    if (!transitions) return { ok: false, error: `No transitions from state "${currentStatus}"` };

    const permission = transitions[newStatus];
    if (!permission) return { ok: false, error: `Cannot transition from "${currentStatus}" to "${newStatus}"` };

    if (permission === "any") return { ok: true };
    if (permission === actor) return { ok: true };
    return { ok: false, error: `Transition "${currentStatus}" → "${newStatus}" requires "${permission}", got "${actor}"` };
  }

  // --- Cleanup ---

  close(): void {
    this.stopTimers();
    this.flushToDisk();
    this.db.close();
  }
}
