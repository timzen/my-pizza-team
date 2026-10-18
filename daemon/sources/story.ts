/**
 * daemon/sources/story.ts — The built-in Story (board) Work Source.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins", "WorkDefs &
 * Parents", and "Admission (CONWIP, WIP = 1 per story)".
 *
 * A board task is a WorkDef whose parent is a Story; its workflow position
 * lives on the story (`tasks: [{id, status}]`). This source owns the board's
 * *queue policy*:
 *   - admission (CONWIP, WIP = 1 per story), including a story's dependents
 *     when it stops blocking them (`dependsOn`);
 *   - every position change: leaving a position abandons the in-flight item,
 *     landing in an agent state enqueues one (re-entry ≡ first entry — the
 *     rework path), and the story's open/done status follows its tasks;
 *   - advancing the task when its item COMPLETEs (`onItemTerminal`);
 *   - eligibility: a READY item is handed out only while its story is active
 *     (not pending), ready, and the task still sits in an agent state;
 *   - the story's directory as the item's fallback (`resolveItem`);
 *   - the workflow persona + story framing in the prompt (`buildPrompt`);
 *   - admission and queue reconciliation on daemon load (`reconcile`).
 *
 * Story *persistence* (stories/<id>.json, the SQLite `stories`/`tasks` cache,
 * assignment rows) stays in the Store; it comes in as `StorySourceDeps`, so the
 * source never imports the Store. Everything it does to the queue goes through
 * `SourceContext` (`ctx.enqueue` is the single `enqueueFor`), plus one Store
 * capability a source context doesn't offer: withdrawing an in-flight item.
 */

import { type Comment, DONE_STATE, type Story, TODO_STATE, type WorkDef, type WorkflowConfig, type WorkItem } from "../../shared/types.ts";
import { buildWorkDefPrompt } from "../prompt.ts";
import { firstActiveState, isActiveState, isAgentState, isValidPosition, nextState } from "../workflow-engine.ts";
import { plural } from "./toggle.ts";
import type { ItemTerminalOutcome, SourceContext, SourceToggle, WorkSource } from "./types.ts";

/** The Story source's id (= its WorkDefs' `parent.kind`). */
export const STORY_SOURCE_ID = "story";

/** The board-task fields the policy reads (the Store's `TaskWithMeta` satisfies it). */
export interface BoardTask {
  id: string;
  storyId: string;
  /** Workflow position: an active state, or the "todo"/"done" buckets. */
  status: string;
}

/** The Store-level reads and writes the Story source needs (supplied by the Store). */
export interface StorySourceDeps {
  getStory(id: string): Story | null;
  getStories(): Story[];
  /** Open, and every dependency done/archived/missing (Store.isStoryReady). */
  isStoryReady(storyId: string): boolean;
  getTask(taskId: string): BoardTask | null;
  /** A story's tasks in story order. */
  getTasksForStory(storyId: string): BoardTask[];
  /** The story's effective workflow (its override, else the team default). */
  getWorkflowForStory(storyId: string): WorkflowConfig;
  /** Is the WorkDef pending? (a pending task holds its place in the story) */
  isPending(defId: string): boolean;
  /** Persist a task's position (task cache + story.json). No queue side effects. */
  writeTaskPosition(taskId: string, status: string): void;
  /** Persist a story's open/done status (reaching done admits its dependents). */
  setStoryStatus(storyId: string, status: "open" | "done"): void;
  /** The WorkDef's active (READY/IN_PROGRESS/MORIBUND) WorkItem, if any. */
  getActiveItem(defId: string): WorkItem | null;
  /** Withdraw (CANCEL) the WorkDef's active WorkItem, if it has one. */
  cancelActiveItem(defId: string): void;
  /** Record which member holds a task (the board's assignment row). */
  recordAssignment(taskId: string, memberId: string): void;
  /** Drop a task's assignment row (doesn't change its position). */
  releaseAssignment(taskId: string): void;
  /** A workflow state's persona (`workflows/<wf>/<state>.md`), if any. */
  getStatePersona(workflow: string | undefined, state: string): string | undefined;
  /** The story's + WorkDef's context-library entries, resolved and deduped. */
  resolveContext(storyContext: string[] | undefined, defContext: string[] | undefined): Array<{ title: string; content: string }>;
  getComments(defId: string): Comment[];
}

export class StorySource implements WorkSource {
  readonly id = STORY_SOURCE_ID;
  readonly apiVersion = 1 as const;
  /**
   * `features.stories`: stories, their board tasks (create-in-story, reorder,
   * move, delete), pending/activate, and the archive. Every non-archived story
   * (pending ones too) blocks switching it off.
   */
  readonly toggle: SourceToggle = {
    feature: "stories",
    routes: ["/api/stories", "/api/stories/*", "/api/tasks/*", "/api/archived"],
    activeItems: () => {
      const count = this.deps.getStories().length;
      return { count, description: plural(count, "story", "stories") };
    },
  };
  private context: SourceContext | null = null;

  constructor(private deps: StorySourceDeps) {}

  private get ctx(): SourceContext {
    if (!this.context) throw new Error("Story source used before it was registered");
    return this.context;
  }

  init(ctx: SourceContext): void {
    this.context = ctx;
  }

  // ─── Hooks ───

  /**
   * On daemon load: run admission so every ready story has its one in-flight
   * task (CONWIP), then reconcile the queue — every task in an agent state must
   * have an active (READY/IN_PROGRESS/MORIBUND) WorkItem (rebuilds after a
   * restart, a hand-edit, or a task admitted before the queue existed). Never
   * touches tasks in buckets/manual states, and never resurrects terminal items.
   */
  reconcile(): void {
    for (const story of this.deps.getStories()) this.runAdmission(story.id);
    for (const story of this.deps.getStories()) {
      const wf = this.deps.getWorkflowForStory(story.id);
      for (const task of this.deps.getTasksForStory(story.id)) {
        if (isAgentState(wf, task.status) && !this.ctx.hasActiveItem(task.id)) this.ctx.enqueue(task.id);
      }
    }
  }

  /**
   * A READY board item is handed out only while its story is active (a pending
   * story's in-flight item, already IN_PROGRESS, isn't READY and so finishes
   * normally), ready, and the task still sits in an agent state. A board WorkDef
   * with no task row (its story is gone) is treated like a plain WorkDef:
   * eligible while it exists — what the daemon did before Story was a source.
   */
  isEligible(def: WorkDef): boolean {
    const task = this.deps.getTask(def.id);
    if (!task) return true;
    const story = this.deps.getStory(task.storyId);
    if (!story || story.pending || !this.deps.isStoryReady(story.id)) return false;
    return isAgentState(this.deps.getWorkflowForStory(story.id), task.status);
  }

  /** A board WorkDef without its own directory runs in its story's. */
  resolveItem(def: WorkDef): { title?: string; directory?: string } {
    if (def.directory || !def.parent) return {};
    return { directory: this.deps.getStory(def.parent.id)?.directory };
  }

  /** The claim records the board's assignment row (who holds the task). */
  onItemClaimed(def: WorkDef, _item: WorkItem, memberId: string): void {
    if (this.deps.getTask(def.id)) this.deps.recordAssignment(def.id, memberId);
  }

  /**
   * COMPLETE advances the task to its workflow's next state (re-running
   * admission); FAILED leaves it where it is — stuck, with no active WorkItem,
   * for a human. The new position goes back to the agent.
   */
  onItemTerminal(def: WorkDef, item: WorkItem): ItemTerminalOutcome | void {
    if (item.state !== "COMPLETE" || !this.deps.getTask(def.id)) return;
    return this.advance(def.id);
  }

  /**
   * Not the base prompt: board work is framed by its workflow state's persona
   * (first — it frames everything after it) and its story, so the prompt is
   * rebuilt with them. A board WorkDef with no task row gets the base.
   */
  buildPrompt(def: WorkDef, base: string): string {
    const task = this.deps.getTask(def.id);
    if (!task) return base;
    const story = this.deps.getStory(task.storyId);
    const comments = this.deps.getComments(def.id);
    return buildWorkDefPrompt({
      workDef: {
        title: def.title, goal: def.goal, acceptanceCriteria: def.acceptanceCriteria,
        additionalContext: def.additionalContext, directory: def.directory,
      },
      story: story ? { id: story.id, title: story.title, description: story.description, directory: story.directory } : undefined,
      state: task.status,
      persona: this.deps.getStatePersona(story?.workflow, task.status),
      comments: comments.length > 0 ? comments : undefined,
      contextEntries: this.deps.resolveContext(story?.context, def.contextRefs),
    });
  }

  /**
   * A pending board task was activated: if it already sits in an agent state it
   * is enqueued now; otherwise admission runs, so a pending task that was
   * holding the story's next slot is admitted. Returns its active item, if any.
   * (`enqueue: false` doesn't apply to the board: its position decides.)
   */
  onActivate(def: WorkDef): WorkItem | null {
    const task = this.deps.getTask(def.id);
    if (!task) return null;
    const wf = this.deps.getWorkflowForStory(task.storyId);
    if (isAgentState(wf, task.status)) {
      const item = this.ctx.hasActiveItem(def.id) ? null : this.ctx.enqueue(def.id);
      if (item) return item;
    } else {
      this.runAdmission(task.storyId);
    }
    return this.deps.getActiveItem(def.id);
  }

  // ─── Board policy (the Store's board methods delegate here) ───

  /**
   * Low-level position setter: persists the position, keeps the story's
   * open/done status in sync, and makes the queue reflect the new position.
   * All position changes flow through here.
   *
   * Queue sync: landing in an agent state enqueues a READY item (unless one is
   * already active). Leaving a position abandons the task's active item as
   * CANCELED — a position change out from under an in-flight attempt is a human
   * override. `keepWorkItem` skips that (the COMPLETE advance, whose item
   * already terminated).
   */
  setPosition(taskId: string, status: string, keepWorkItem = false): void {
    const before = this.deps.getTask(taskId);
    this.deps.writeTaskPosition(taskId, status);

    const task = this.deps.getTask(taskId);
    if (!task) return;
    const story = this.deps.getStory(task.storyId);
    if (!story) return;
    const wf = this.deps.getWorkflowForStory(task.storyId);

    if (!keepWorkItem && before && before.status !== status) this.deps.cancelActiveItem(taskId);
    if (isAgentState(wf, status) && !this.ctx.hasActiveItem(taskId)) this.ctx.enqueue(taskId);

    if (status === DONE_STATE) {
      const tasks = this.deps.getTasksForStory(task.storyId);
      if (tasks.every((t) => t.status === DONE_STATE)) this.deps.setStoryStatus(task.storyId, "done");
    } else if (story.status === "done") {
      // A task moved back out of `done` reopens the story.
      this.deps.setStoryStatus(task.storyId, "open");
    }
  }

  /**
   * Judgment move (human or leader agent): put a task anywhere in its
   * workflow's positions. Any active WorkItem is abandoned (CANCELED) and,
   * when entering an agent state, a fresh READY one is created — re-entry ≡
   * first entry (rework path). Runs admission excluding the moved task, so
   * shelving a task to `todo` doesn't bounce it straight back in.
   */
  moveTask(taskId: string, newStatus: string): { ok: boolean; error?: string } {
    const task = this.deps.getTask(taskId);
    if (!task) return { ok: false, error: "Task not found" };
    const wf = this.deps.getWorkflowForStory(task.storyId);
    if (!isValidPosition(wf, newStatus)) {
      return { ok: false, error: `"${newStatus}" is not a state in this story's workflow` };
    }
    this.setPosition(taskId, newStatus);
    this.deps.releaseAssignment(taskId);
    this.runAdmission(task.storyId, taskId);
    return { ok: true };
  }

  /**
   * Advance a task out of its current agent state to the next state (or
   * `done`), then re-run admission (finishing the last state frees the CONWIP
   * token).
   */
  advance(taskId: string): ItemTerminalOutcome {
    const task = this.deps.getTask(taskId);
    if (!task) return {};
    const next = nextState(this.deps.getWorkflowForStory(task.storyId), task.status);
    this.setPosition(taskId, next, true);
    this.runAdmission(task.storyId);
    return { newStatus: next, completed: next === DONE_STATE };
  }

  /**
   * CONWIP admission: pull the next task (story order) from `todo` into the
   * workflow's first active state — but only when the story has no task
   * anywhere in its active section (WIP = 1 per story). `excludeTaskId` keeps
   * a just-shelved task from being re-admitted by its own move. Idempotent: it
   * returns once the token is taken.
   */
  runAdmission(storyId: string, excludeTaskId?: string): void {
    const story = this.deps.getStory(storyId);
    if (!story || story.status !== "open" || story.pending) return;
    if (!this.deps.isStoryReady(storyId)) return;

    const wf = this.deps.getWorkflowForStory(storyId);
    const first = firstActiveState(wf);
    if (!first) return; // empty workflow: nothing to admit into

    const tasks = this.deps.getTasksForStory(storyId);
    // Token taken: something is already in the active section.
    if (tasks.some((t) => isActiveState(wf, t.status))) return;

    const candidate = tasks.find((t) => t.status === TODO_STATE && t.id !== excludeTaskId);
    if (!candidate) return;
    // A pending task holds its place: tasks are sequential, so admitting the one
    // after it would run step N+1 before step N exists. The story waits until
    // the task is activated (docs/DESIGN.md "Pending: Write, Review, Activate").
    if (this.deps.isPending(candidate.id)) return;

    // setPosition enqueues the READY WorkItem when landing in an agent state.
    this.setPosition(candidate.id, first);
  }

  /**
   * Re-run admission for every active story that `dependsOn` the given one.
   * Called whenever a story stops blocking its dependents in `isStoryReady`'s
   * eyes — it reached done, or was archived or deleted — so a dependent isn't
   * left `ready` with no WorkItem until a restart or a story edit. Safe to
   * call repeatedly: `runAdmission` is idempotent and gates on pending/done/
   * ready itself, and admitting a task never marks its story done, so this
   * can't recurse.
   */
  admitDependents(storyId: string): void {
    for (const s of this.deps.getStories()) {
      if (s.id !== storyId && s.dependsOn.includes(storyId)) this.runAdmission(s.id);
    }
  }
}
