/**
 * daemon/store/board.ts — The board: stories, their tasks, and workflows.
 *
 * The board side of the Store (docs/DESIGN.md "The Work Model", "WorkDefs &
 * Parents", "Admission (CONWIP, WIP = 1 per story)"):
 *   - workflows (`workflows/<name>/workflow.json`, falling back to the built-in
 *     default) — load, save, delete, and the effective workflow of a story/task;
 *   - `loadFromDisk`: legacy story-file migration, then the stories/tasks SQLite
 *     cache rebuilt from `stories/<id>.json` + the board WorkDefs (`story.tasks`
 *     reconciled against what's on disk), then every source's `reconcile`;
 *   - story and board-task CRUD, the story-owned task order, task positions,
 *     assignments, and the entry points into the board policy (admission, moves —
 *     the policy itself lives in daemon/sources/story.ts);
 *   - archive (in place: `archivedAt` + an inline synopsis) and delete.
 *
 * JSON files are the source of truth; the `stories`/`tasks` tables are a cache.
 * The Store delegates its board methods here one line each. What this needs from
 * the Story source and the queue comes in as `BoardStoreDeps`.
 */

import type { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import {
  slugify,
  DEFAULT_CONFIG,
  TODO_STATE,
  DONE_STATE,
  STORIES_DIR,
  type Assignment,
  type Comment,
  type Story,
  type StoryTaskRef,
  type TeamConfig,
  type WorkflowConfig,
  type WorkDef,
} from "../../shared/types.ts";
import { normalizeDirectory } from "../../shared/directory.ts";
import { writeFileAtomic } from "../../shared/atomic-write.ts";
import { validateWorkflow } from "../workflow-engine.ts";
import { listWorkDefs, getWorkDef, saveWorkDef, deleteWorkDef, workDefDir } from "./workdefs.ts";
import { migrateLegacyStoryFiles } from "./story-migration.ts";
import type { StoreDomainContext } from "./domain.ts";

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
}

export interface TaskWithMeta extends Task {
  storyId: string;
  seq: number;
  slug: string;
  /** The WorkDef directory (`tasks/<id>/`) — comments/attachments live here. */
  dirPath: string;
}

/** True for a story file's data that carries the archived flag (`archivedAt`). */
function isArchivedStoryData(data: unknown): data is Record<string, unknown> {
  return !!data && typeof data === "object" && typeof (data as Record<string, unknown>).archivedAt === "string"
    && (data as Record<string, unknown>).archivedAt !== "";
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
  if (story.pending) data.pending = true;
  if (story.workflow) data.workflow = story.workflow;
  if (story.archivedAt) data.archivedAt = story.archivedAt;
  return data;
}

/**
 * The board policy's entry points (daemon/sources/story.ts `StorySource`): every
 * position change, admission, and the unblocking of dependents flows through it.
 */
export interface BoardPolicy {
  runAdmission(storyId: string, excludeTaskId?: string): void;
  admitDependents(storyId: string): void;
  setPosition(taskId: string, status: string): void;
  moveTask(taskId: string, newStatus: string): { ok: boolean; error?: string };
}

/** What the board domain needs from the rest of the Store. */
export interface BoardStoreDeps {
  /** The Story source's board policy. */
  policy: BoardPolicy;
  /** Cancel a task's active WorkItem (the queue's internal override). */
  abandonActiveWorkItem(taskId: string): void;
  /** Let every Work Source bring the queue in line with its state (hook: reconcile). */
  reconcileSources(): void;
}

export class BoardStore {
  private db: DatabaseSync;
  private teamDir: string;
  private config: TeamConfig;
  private deps: BoardStoreDeps;
  private workflows: Record<string, WorkflowConfig> = {};

  /** Built empty: the Store loads workflows (`reloadWorkflows`) once the persona migration has run. */
  constructor(ctx: StoreDomainContext, deps: BoardStoreDeps) {
    this.db = ctx.db;
    this.teamDir = ctx.teamDir;
    this.config = ctx.config;
    this.deps = deps;
  }

  /** Load workflows from the workflows/ directory (falls back to the built-in default). */
  private loadWorkflows(): void {
    const workflowsDir = path.join(this.teamDir, "workflows");
    this.workflows = {};

    if (existsSync(workflowsDir)) {
      for (const entry of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const wfDir = path.join(workflowsDir, entry.name);
        const wfFile = path.join(wfDir, "workflow.json");
        if (!existsSync(wfFile)) continue;
        try {
          const wf: WorkflowConfig = JSON.parse(fs.readFileSync(wfFile, "utf8"));
          // Only accept the ordered-states shape (see docs/DESIGN.md "The Work Model");
          // malformed or legacy transition-matrix files are skipped.
          if (validateWorkflow(wf) === null) {
            this.workflows[entry.name] = wf;
            // A manual state has no WorkItem, so a persona there does nothing.
            for (const st of wf.states) {
              if (st.type === "manual" && st.persona) console.warn(`[personas] workflow '${entry.name}' manual state '${st.name}' names persona '${st.persona}', which is ignored (manual states have no teammate)`);
            }
          }
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
    fs.mkdirSync(wfDir, { recursive: true });
    writeFileAtomic(path.join(wfDir, "workflow.json"), JSON.stringify(wf, null, 2) + "\n");
    this.workflows[name] = wf;
  }

  /** Delete a workflow directory */
  deleteWorkflow(name: string): boolean {
    const wfDir = path.join(this.teamDir, "workflows", name);
    if (!existsSync(wfDir)) return false;
    fs.rmSync(wfDir, { recursive: true });
    delete this.workflows[name];
    return true;
  }

  // --- Load from filesystem ---

  /**
   * Rebuild the stories/tasks cache from the team dir (after migrating legacy
   * story files), reconciling each story's `tasks` against its board WorkDefs,
   * then let every source reconcile the queue.
   */
  loadFromDisk(): void {
    const storiesDir = path.join(this.teamDir, STORIES_DIR);

    // Old story files first: `paused` and `backlog/` become pending (idempotent).
    const migrated = migrateLegacyStoryFiles(this.teamDir);
    if (migrated.conflicts.length > 0) {
      console.warn(`[store] backlog/ or archived/ stories not migrated (stories/ already has that id): ${migrated.conflicts.join(", ")}`);
    }

    // Read flat story files (stories/<id>.json).
    const stories: Story[] = [];
    if (existsSync(storiesDir)) {
      for (const entry of fs.readdirSync(storiesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try { stories.push(JSON.parse(fs.readFileSync(path.join(storiesDir, entry.name), "utf8")) as Story); }
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
      // Archived stories stay in stories/ but never enter the active cache, so
      // the board, admission and reconcile don't see them (nor their tasks).
      if (isArchivedStoryData(story)) {
        if (this.hasStory(story.id)) this.removeStoryFromDb(story.id);
        continue;
      }
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

    // Let each source bring the queue in line with its own state (hook:
    // reconcile). Story: admission so every ready story has its one in-flight
    // task (CONWIP), then an active WorkItem for every task in an agent state.
    this.deps.reconcileSources();
  }

  /** Absolute path of a story's flat json file (`stories/<id>.json`). */
  private storyFile(id: string): string {
    return path.join(this.teamDir, STORIES_DIR, `${id}.json`);
  }

  /** Write a story to its flat json file. */
  private writeStory(story: Story): void {
    fs.mkdirSync(path.join(this.teamDir, STORIES_DIR), { recursive: true });
    writeFileAtomic(this.storyFile(story.id), JSON.stringify(serializeStory(story), null, 2) + "\n");
  }

  private upsertStory(story: Story): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO stories (id, title, description, status, depends_on, pending, workflow, task_order, directory, dir_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      story.id, story.title, story.description, story.status,
      JSON.stringify(story.dependsOn),
      story.pending ? 1 : 0,
      story.workflow || null,
      JSON.stringify((story.tasks || []).map((t) => t.id)), story.directory || null,
      path.join(this.teamDir, STORIES_DIR),
    );
  }

  /** Cache a board WorkDef (+ its story-owned status) into the tasks index. */
  private upsertTask(def: WorkDef, storyId: string, status: string, seq: number): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO tasks (id, story_id, seq, slug, title, description, acceptance_criteria, additional_context, status, dir_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      def.id, storyId, seq, slugify(def.title), def.title, def.goal,
      def.acceptanceCriteria || "", def.additionalContext || null,
      status, workDefDir(this.teamDir, def.id),
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
      pending: row.pending ? true : undefined,
      workflow: (row.workflow as string) || undefined,
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
      dirPath: row.dir_path as string,
    };
  }

  /** Every active (cached) story, by id. */
  getStories(): (Story & { dirPath: string })[] {
    const rows = this.db.prepare("SELECT * FROM stories ORDER BY id").all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToStory(row));
  }

  /** True when the id is an active story (in the SQLite cache). */
  hasStory(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM stories WHERE id = ?").get(id);
    return !!row;
  }

  /**
   * True when the id is taken by an active or an archived story. Use it before
   * creating a story: an archived story still owns stories/<id>.json and its
   * `<id>-<n>` task WorkDefs, so reusing the id would clobber them.
   */
  isStoryIdTaken(id: string): boolean {
    return this.hasStory(id) || existsSync(this.storyFile(id));
  }

  /**
   * Create a story (and its tasks as board WorkDefs in `todo`), write
   * stories/<id>.json, then run admission. Throws for an archived story's id.
   */
  createStory(
    id: string,
    title: string,
    description: string,
    status: "open" | "done" = "open",
    dependsOn: string[] = [],
    tasks?: Array<{ title: string; description: string; pending?: boolean }>,
    workflow?: string,
    pending?: boolean,
    directory?: string
  ): { story: Story; tasks: TaskWithMeta[] } {
    // Never overwrite an archived story's file (or its task WorkDefs) in place.
    if (this.isStoryArchived(id)) throw new Error(`Story "${id}" is archived; pick another id`);
    const storyData: Story = { id, title, description, status, dependsOn, tasks: [] };
    if (directory) storyData.directory = normalizeDirectory(directory);
    if (pending) storyData.pending = true;
    if (workflow) storyData.workflow = workflow;

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
          pending: taskDef.pending,
        });
        storyData.tasks.push({ id: taskId, status: TODO_STATE });
        this.upsertTask(def, id, TODO_STATE, seq);
        createdTasks.push({
          id: taskId, title: def.title, description: def.goal,
          acceptanceCriteria: def.acceptanceCriteria, status: TODO_STATE,
          storyId: id, seq, slug: slugify(def.title),
          dirPath: workDefDir(this.teamDir, taskId),
        });
      }
    }

    this.writeStory(storyData);
    this.upsertStory(storyData);

    // Admit the first task into the pipeline (no-op for pending/dependent stories).
    this.runAdmission(id);

    return { story: storyData, tasks: createdTasks };
  }

  /**
   * Append a board task (a WorkDef parented to the story) in the `todo` bucket.
   * `pending` creates it as pending, which holds its place in the story until it
   * is activated (docs/DESIGN.md "Pending: Write, Review, Activate").
   */
  addTask(storyId: string, input: { title: string; description: string; pending?: boolean }): TaskWithMeta | null {
    const story = this.getStory(storyId);
    if (!story) return null;
    const existing = this.getTasksForStory(storyId);
    const nextSeq = existing.length > 0 ? Math.max(...existing.map((t) => t.seq)) + 1 : 1;
    const taskId = `${storyId}-${nextSeq}`;
    const def = saveWorkDef(this.teamDir, {
      id: taskId, title: input.title, parent: { kind: "story", id: storyId },
      goal: input.description, acceptanceCriteria: "",
      pending: input.pending,
    });
    const tasks = [...story.tasks, { id: taskId, status: TODO_STATE }];
    this.writeStory({ ...story, tasks });
    this.upsertStory({ ...story, tasks });
    this.upsertTask(def, storyId, TODO_STATE, nextSeq);
    this.runAdmission(storyId);
    return {
      id: taskId, title: def.title, description: def.goal, acceptanceCriteria: def.acceptanceCriteria,
      status: TODO_STATE, storyId, seq: nextSeq,
      slug: slugify(def.title), dirPath: workDefDir(this.teamDir, taskId),
    };
  }

  /** One active story, or null (archived and unknown stories alike). */
  getStory(id: string): (Story & { dirPath: string }) | null {
    const row = this.db.prepare("SELECT * FROM stories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToStory(row);
  }

  /** Not done, and every story it depends on is done (or no longer active). */
  isStoryReady(storyId: string): boolean {
    const story = this.getStory(storyId);
    if (!story || story.status === "done") return false;
    if (story.dependsOn.length === 0) return true;

    for (const depId of story.dependsOn) {
      const dep = this.getStory(depId);
      // Missing from the active cache: archived (= done) or deleted — either
      // way it no longer blocks (archived stories never load into the cache).
      if (!dep) continue;
      if (dep.status !== "done") return false;
    }
    return true;
  }

  /**
   * Edit a story's fields (cache + file), then re-run admission — and unblock
   * its dependents when the edit marks it done. False when it's missing.
   */
  updateStoryDetails(storyId: string, updates: {
    title?: string;
    description?: string;
    status?: "open" | "done";
    dependsOn?: string[];
    pending?: boolean;
    workflow?: string | null;
    directory?: string | null;
  }): boolean {
    const story = this.getStory(storyId);
    if (!story) return false;

    const newTitle = updates.title ?? story.title;
    const newDescription = updates.description ?? story.description;
    const newStatus = updates.status ?? story.status;
    const newDependsOn = updates.dependsOn ?? story.dependsOn;
    const newPending = updates.pending !== undefined ? updates.pending : (story.pending || false);
    const newWorkflow = updates.workflow !== undefined ? (updates.workflow || null) : (story.workflow || null);
    const newDirectory = updates.directory !== undefined
      ? (updates.directory ? normalizeDirectory(updates.directory) : null)
      : (story.directory || null);

    this.db.prepare(
      `UPDATE stories SET title = ?, description = ?, status = ?, depends_on = ?, pending = ?, workflow = ?, directory = ? WHERE id = ?`
    ).run(newTitle, newDescription, newStatus, JSON.stringify(newDependsOn), newPending ? 1 : 0, newWorkflow, newDirectory, storyId);

    // Write back to disk
    this.writeStory({
      id: storyId,
      title: newTitle,
      description: newDescription,
      status: newStatus,
      dependsOn: newDependsOn,
      directory: newDirectory || undefined,
      pending: newPending,
      workflow: newWorkflow || undefined,
      tasks: story.tasks,
    });

    // Activating (or dependency edits) may make the story admissible. Going
    // pending needs nothing here: admission and getNextWorkItem both skip a
    // pending story, so an in-flight task finishes and nothing new starts.
    this.runAdmission(storyId);
    // Marking it done (by edit) unblocks its dependents.
    if (newStatus === "done" && story.status !== "done") this.admitDependents(storyId);

    return true;
  }

  /**
   * Move a story active ⇄ pending (docs/DESIGN.md "Pending: Write, Review,
   * Activate"). Pending stops new work only: a task already IN_PROGRESS
   * finishes, but nothing further is admitted or handed out, and stories that
   * depend on it wait. Activating re-runs admission, and READY items the story
   * already had become eligible again. Returns false when the story is missing.
   */
  setStoryPending(storyId: string, pending: boolean): boolean {
    return this.updateStoryDetails(storyId, { pending });
  }

  /** Set a story's open/done status (cache + file); done unblocks its dependents. */
  updateStoryStatus(storyId: string, status: "open" | "done"): void {
    this.db.prepare("UPDATE stories SET status = ? WHERE id = ?").run(status, storyId);
    const story = this.getStory(storyId);
    if (story) this.writeStory({ ...story, status });
    if (status === "done") this.admitDependents(storyId);
  }

  /**
   * Re-run admission for every active story that `dependsOn` the given one.
   * Called whenever a story stops blocking its dependents in `isStoryReady`'s
   * eyes: it reaches `done`, or it leaves the active set (archive/delete — a
   * missing dependency counts as satisfied). Without this, a dependent sat
   * `ready` with no WorkItem until a restart or a story edit. Safe to call
   * repeatedly: `runAdmission` is idempotent (it returns once the CONWIP token
   * is taken) and gates on pending/done/ready itself, and admitting a task never
   * marks its story done, so this can't recurse. See docs/DESIGN.md "Admission
   * (CONWIP, WIP = 1 per story)".
   */
  private admitDependents(storyId: string): void {
    this.deps.policy.admitDependents(storyId);
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

  /** A story's tasks in the story-owned order (see `orderTasks`). */
  getTasksForStory(storyId: string): TaskWithMeta[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE story_id = ? ORDER BY seq").all(storyId) as Array<Record<string, unknown>>;
    const tasks = rows.map((row) => this.rowToTask(row));
    const story = this.getStory(storyId);
    return this.orderTasks(story?.tasks.map((t) => t.id), tasks);
  }

  /** One board task (from the cache), or null. */
  getTask(taskId: string): TaskWithMeta | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * Persist a task's workflow position: the task cache row and the story's
   * owned `tasks[]` on disk. No queue side effects — the board policy (the
   * Story source's `setPosition`) owns those, and every position change flows
   * through it.
   */
  writeTaskPosition(taskId: string, status: string): void {
    this.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
    const task = this.getTask(taskId);
    const story = task ? this.getStory(task.storyId) : null;
    if (story) this.writeStory(story);
  }

  /**
   * Set a task's status. (Compatibility wrapper; judgment moves should use
   * `moveTask`.) Queue effects as for any position change (daemon/sources/story.ts).
   */
  updateTaskStatus(taskId: string, status: string): void {
    if (!this.getTask(taskId)) return;
    this.deps.policy.setPosition(taskId, status);
  }

  /**
   * Judgment move (human or leader agent): put a task anywhere in its
   * workflow's positions. Re-entry ≡ first entry: any active WorkItem is
   * abandoned and entering an agent state enqueues a fresh one (the board
   * policy lives in daemon/sources/story.ts).
   */
  moveTask(taskId: string, newStatus: string): { ok: boolean; error?: string } {
    return this.deps.policy.moveTask(taskId, newStatus);
  }

  /**
   * Delete a board task: cancel its active WorkItem, drop its cache rows and its
   * WorkDef directory, remove it from the story, and re-run admission.
   */
  deleteTask(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const storyId = task.storyId;
    // Cancel any active WorkItem for this task before removing it.
    this.deps.abandonActiveWorkItem(taskId);
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

  // --- Mechanical rules: admission (CONWIP) + advance ---
  //
  // The board policy lives in the Story source (daemon/sources/story.ts); these
  // are the board's entry points into it.

  /**
   * CONWIP admission (WIP = 1 per story): pull the story's next `todo` task into
   * its workflow's first active state if nothing is in flight. `excludeTaskId`
   * keeps a just-shelved task from being re-admitted by its own move.
   */
  runAdmission(storyId: string, excludeTaskId?: string): void {
    this.deps.policy.runAdmission(storyId, excludeTaskId);
  }

  /**
   * Release a WorkDef's assignment row (does not change its position). Only
   * board tasks have one (the Story source records it at claim); for any other
   * WorkDef this is a no-op, so the queue releases it unconditionally.
   */
  releaseTask(taskId: string): void {
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
  }

  /** A board task's assignment row, or null. */
  getAssignment(taskId: string): Assignment | null {
    const row = this.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { taskId: row.task_id as string, memberId: row.member_id as string, claimedAt: row.claimed_at as number };
  }

  /** A member's assignment with its task, or null. */
  getAssignmentForMember(memberId: string): (Assignment & { task: TaskWithMeta }) | null {
    const row = this.db.prepare("SELECT * FROM assignments WHERE member_id = ?").get(memberId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const task = this.getTask(row.task_id as string);
    if (!task) return null;
    return { taskId: row.task_id as string, memberId: row.member_id as string, claimedAt: row.claimed_at as number, task };
  }

  /** A free story id derived from a title (stories are keyed by a human-ish slug). */
  uniqueStoryId(title: string): string {
    const base = slugify(title) || "story";
    let id = base;
    let n = 2;
    while (this.isStoryIdTaken(id)) { id = `${base}-${n}`; n++; }
    return id;
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
   * Remove a task's live data from SQLite (assignments, task row).
   * Token usage is deliberately kept: it's a ledger of spend that happened, and
   * archiving/backlogging a story used to erase it from all history
   * (store/usage.ts).
   */
  private removeTaskData(taskId: string): void {
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
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
    if (existsSync(file)) fs.rmSync(file);
    // A missing dependency counts as satisfied (isStoryReady).
    this.admitDependents(storyId);

    return true;
  }

  /** True when the story has tasks and every one is done. */
  isStoryArchivable(storyId: string): boolean {
    const tasks = this.getTasksForStory(storyId);
    if (tasks.length === 0) return false;
    return tasks.every((t) => t.status === DONE_STATE);
  }

  /**
   * Archive a finished story in place: stories/<id>.json gains `archivedAt`
   * (ISO, the archived flag) and an inline `synopsis`, and the story leaves the
   * active SQLite cache (board, admission, reconcile). Its child task WorkDefs
   * stay in tasks/. See docs/ARCHITECTURE.md "Team directory".
   */
  archiveStory(storyId: string): void {
    if (!this.isStoryArchivable(storyId)) {
      throw new Error(`Cannot archive story "${storyId}": not all tasks are done`);
    }

    const story = this.getStory(storyId);
    if (!story) throw new Error(`Story "${storyId}" not found`);

    const archivedAt = new Date().toISOString();
    const tasks = this.getTasksForStory(storyId);

    // Start from the file on disk (keeps any fields the cache doesn't carry).
    const file = this.storyFile(storyId);
    const data = existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      : serializeStory(story) as unknown as Record<string, unknown>;
    data.archivedAt = archivedAt;
    data.synopsis = this.buildSynopsis(story, tasks, archivedAt);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");

    this.removeStoryFromDb(storyId);
    // Archived = done for its dependents (isStoryReady); normally they were
    // admitted when it reached done, but this covers stories that never did.
    this.admitDependents(storyId);
  }

  /**
   * Read an archived story's file (stories/<id>.json carrying `archivedAt`), or
   * null when there's no such file, it's malformed, or the story is active.
   */
  private readArchivedStory(storyId: string): Record<string, unknown> | null {
    const file = this.storyFile(storyId);
    if (!existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      return isArchivedStoryData(data) ? data : null;
    } catch { return null; }
  }

  /** True when `storyId` names an archived story (stories/<id>.json with `archivedAt`). */
  isStoryArchived(storyId: string): boolean {
    return this.readArchivedStory(storyId) !== null;
  }

  /** Every archived story (id, title, synopsis), read from stories/ by its `archivedAt` flag. */
  getArchivedStories(): Array<{ id: string; title: string; synopsis: string }> {
    const storiesDir = path.join(this.teamDir, STORIES_DIR);
    if (!existsSync(storiesDir)) return [];

    const results: Array<{ id: string; title: string; synopsis: string }> = [];
    for (const entry of fs.readdirSync(storiesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(storiesDir, entry.name), "utf8"));
        if (!isArchivedStoryData(data)) continue;
        results.push({ id: data.id as string, title: data.title as string, synopsis: (data.synopsis as string) || (data.description as string) || "" });
      } catch { /* skip malformed */ }
    }
    return results;
  }

  /** An archived story's file plus its tasks' WorkDefs and comments, or null if it isn't archived. */
  getArchivedStoryContext(storyId: string): { story: Record<string, unknown>; tasks: Record<string, unknown>[]; comments: Record<string, Comment[]> } | null {
    const story = this.readArchivedStory(storyId);
    if (!story) return null;
    const tasks: Record<string, unknown>[] = [];
    const comments: Record<string, Comment[]> = {};

    // The archived story lists its task ids; their WorkDefs + comments still
    // live under tasks/<id>/ (archiving doesn't move them).
    for (const t of (story.tasks as Array<{ id: string; status: string }> | undefined) ?? []) {
      const def = getWorkDef(this.teamDir, t.id);
      if (def) tasks.push({ id: def.id, title: def.title, goal: def.goal, acceptanceCriteria: def.acceptanceCriteria, status: t.status });
      const commentsFile = path.join(workDefDir(this.teamDir, t.id), "comments.jsonl");
      if (existsSync(commentsFile)) {
        const lines = fs.readFileSync(commentsFile, "utf8").split("\n").filter(Boolean);
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

  /**
   * Record a board task's assignment at claim (the Story source's
   * `recordAssignment`): one row per task, replacing any earlier one.
   */
  recordAssignment(taskId: string, memberId: string): void {
    this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(taskId);
    this.db.prepare("INSERT INTO assignments (task_id, member_id, claimed_at) VALUES (?, ?, ?)").run(taskId, memberId, Date.now());
  }

  /**
   * Keep a board task's cached title/description (what /api/stories reads) in
   * step with its WorkDef after an edit through the WorkDef path. A no-op for a
   * WorkDef that isn't a board task.
   */
  refreshTaskCache(def: WorkDef): void {
    if (!this.getTask(def.id)) return;
    this.db.prepare("UPDATE tasks SET title = ?, description = ? WHERE id = ?").run(def.title, def.goal, def.id);
  }
}
