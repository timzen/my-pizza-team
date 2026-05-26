// SQLite store + JSON file sync
import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message, Story, Task, TaskWithMeta, TeamConfig, Member, Assignment } from "../shared/types.js";

export class Store {
  private db: Database.Database;
  private teamDir: string;
  private config: TeamConfig;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;

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
    `);
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
        `INSERT OR REPLACE INTO stories (id, title, description, status, depends_on, dir_path)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(story.id, story.title, story.description, story.status, JSON.stringify(story.dependsOn), dirPath);
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
    tasks?: Array<{ title: string; description: string }>
  ): { story: Story; tasks: TaskWithMeta[] } {
    const storiesDir = path.join(this.teamDir, "stories");
    const storyDirName = id;
    const storyDirPath = path.join(storiesDir, storyDirName);

    // Create directory structure
    fs.mkdirSync(storyDirPath, { recursive: true });

    const storyData: Story = { id, title, description, status, dependsOn };
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
    // Check if there are messages where from != 'lead' that are newer than last lead message
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
    if (!lastLead?.t) return true;
    return lastTeammate.t > lastLead.t;
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
      const taskData: Task = {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        result: row.result,
      };
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
