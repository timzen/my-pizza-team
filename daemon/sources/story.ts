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
 *     landing in a teammate state enqueues one (re-entry ≡ first entry — the
 *     rework path), and the story's open/done status follows its tasks;
 *   - advancing the task when its item COMPLETEs (`onItemTerminal`);
 *   - poll states (docs/DESIGN.md "Polling States"): a fresh poll record when a
 *     task lands in one, the wait outcome (`recordWait` — the task stays put),
 *     the poll framing of the prompt, and the poll schedule on the daemon tick
 *     (`runPollChecks`: the next check after `pollEvery`, the readiness hold,
 *     `pollTimeout`/`onTimeout`) plus **Check now** (`checkNow`);
 *   - eligibility: a READY item is handed out only while its story is active
 *     (not pending), ready, and the task still sits in a teammate state;
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

import {
  type Comment, DONE_STATE, type Story, type TaskPollRecord, TODO_STATE, type WorkDef, type WorkflowConfig, type WorkItem, type WorkItemState,
} from "../../shared/types.ts";
import { buildWorkDefPrompt } from "../prompt.ts";
import { firstActiveState, isActiveState, isTeammateState, isValidPosition, nextState, pollSettings, type PollSettings } from "../workflow-engine.ts";
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
  /** Poll bookkeeping while the task sits in a poll state. */
  poll?: TaskPollRecord;
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
  /** Persist a task's poll record, or drop it (null). No queue side effects. */
  writeTaskPoll(taskId: string, poll: TaskPollRecord | null): void;
  /** The newest WorkItem's state for a WorkDef (CANCELED included), or null. */
  getLatestItemState(defId: string): WorkItemState | null;
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
  /** The persona body a workflow state names (resolved through the persona library), if any. */
  getStatePersona(workflow: string | undefined, state: string): string | undefined;
  getComments(defId: string): Comment[];
  /** The readiness probe's reason while the team is not ready (undefined when ready or unreported). */
  getReadinessReason(): string | undefined;
  /** Post a daemon comment on a task's thread (a poll timeout's record). */
  addDaemonComment(taskId: string, body: string): void;
  /**
   * `onTimeout: "fail"`: turn the task's latest WorkItem — its last check,
   * WAITED — into FAILED (unread, so it surfaces in the Inbox), leaving the
   * task stuck as for any failed run. False when the latest item isn't WAITED.
   */
  failWaitedCheck(taskId: string): boolean;
}

/** The outcome of **Check now** (`StorySource.checkNow`). */
export type CheckNowResult =
  | { ok: true; workItem: WorkItem }
  /** `notFound`: no such task; `readiness`: refused because the team isn't ready (the probe's reason). */
  | { ok: false; error: string; notFound?: boolean; readiness?: string };

/** A board task's poll status, for display (`StorySource.pollStatusFor`). */
export interface TaskPollStatus extends TaskPollRecord {
  /** When the next check is due (ISO), while polling is on and no check is in flight. */
  nextCheckAt?: string;
  /** When `pollTimeout` runs out (ISO): `startedAt` + `pollTimeout`. */
  timeoutAt: string;
  onTimeout: PollSettings["onTimeout"];
}

/** A duration for a comment: "7d", "2h", "15m" (the largest whole unit; else minutes). */
function formatSpan(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / 60_000)}m`;
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

  private deps: StorySourceDeps;

  constructor(deps: StorySourceDeps) {
    this.deps = deps;
  }

  private get ctx(): SourceContext {
    if (!this.context) throw new Error("Story source used before it was registered");
    return this.context;
  }

  init(ctx: SourceContext): void {
    this.context = ctx;
  }

  /** The daemon tick (every 30s): the poll schedule (`runPollChecks`). */
  tick(_ctx: SourceContext, now: Date): void {
    this.runPollChecks(now);
  }

  // ─── Hooks ───

  /**
   * On daemon load: run admission so every ready story has its one in-flight
   * task (CONWIP), then reconcile the queue — every task in a teammate state must
   * have an active (READY/IN_PROGRESS/MORIBUND) WorkItem (rebuilds after a
   * restart, a hand-edit, or a task admitted before the queue existed). Never
   * touches tasks in buckets/manual states, and never resurrects terminal items.
   * A poll-state task whose last check ended with wait is left alone: when its
   * next check runs is the poll schedule's call, not a restart's.
   */
  reconcile(): void {
    for (const story of this.deps.getStories()) this.runAdmission(story.id);
    for (const story of this.deps.getStories()) {
      const wf = this.deps.getWorkflowForStory(story.id);
      for (const task of this.deps.getTasksForStory(story.id)) {
        if (!isTeammateState(wf, task.status) || this.ctx.hasActiveItem(task.id)) continue;
        if (pollSettings(wf, task.status) && this.deps.getLatestItemState(task.id) === "WAITED") continue;
        this.ctx.enqueue(task.id);
      }
    }
  }

  /**
   * A READY board item is handed out only while its story is active (a pending
   * story's in-flight item, already IN_PROGRESS, isn't READY and so finishes
   * normally), ready, and the task still sits in a teammate state. A board WorkDef
   * with no task row (its story is gone) is treated like a plain WorkDef:
   * eligible while it exists — what the daemon did before Story was a source.
   */
  isEligible(def: WorkDef): boolean {
    const task = this.deps.getTask(def.id);
    if (!task) return true;
    const story = this.deps.getStory(task.storyId);
    if (!story || story.pending || !this.deps.isStoryReady(story.id)) return false;
    return isTeammateState(this.deps.getWorkflowForStory(story.id), task.status);
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
   * for a human. WAITED (a poll state's "not yet") leaves it too, but isn't
   * stuck: `recordWait` has noted the check. The new position goes back to the agent.
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
    const poll = story ? pollSettings(this.deps.getWorkflowForStory(story.id), task.status) : null;
    return buildWorkDefPrompt({
      workDef: {
        title: def.title, goal: def.goal, acceptanceCriteria: def.acceptanceCriteria,
        additionalContext: def.additionalContext, directory: def.directory,
      },
      story: story ? { id: story.id, title: story.title, description: story.description, directory: story.directory } : undefined,
      state: task.status,
      persona: this.deps.getStatePersona(story?.workflow, task.status),
      comments: comments.length > 0 ? comments : undefined,
      ...(poll ? { poll: { since: task.poll?.state === task.status ? task.poll.startedAt : undefined, checks: task.poll?.checks ?? 0 } } : {}),
    });
  }

  /**
   * A pending board task was activated: if it already sits in a teammate state it
   * is enqueued now; otherwise admission runs, so a pending task that was
   * holding the story's next slot is admitted. Returns its active item, if any.
   * (`enqueue: false` doesn't apply to the board: its position decides.)
   */
  onActivate(def: WorkDef): WorkItem | null {
    const task = this.deps.getTask(def.id);
    if (!task) return null;
    const wf = this.deps.getWorkflowForStory(task.storyId);
    if (isTeammateState(wf, task.status)) {
      const item = this.ctx.hasActiveItem(def.id) ? null : this.ctx.enqueue(def.id);
      if (item) return item;
    } else {
      this.runAdmission(task.storyId);
    }
    return this.deps.getActiveItem(def.id);
  }

  // ─── Poll states (docs/DESIGN.md "Polling States") ───

  /**
   * The poll settings of the state a board task sits in, or null when it is
   * not a board task or its state isn't a poll state (`completion` once, the
   * default). Decides whether a run may end with wait, and the claim's
   * `completion` (which offers the harness's wait tool).
   */
  pollSettingsFor(taskId: string): PollSettings | null {
    const task = this.deps.getTask(taskId);
    if (!task) return null;
    return pollSettings(this.deps.getWorkflowForStory(task.storyId), task.status);
  }

  /**
   * A check of a poll state ended with wait: note it on the task's poll record
   * (last check time, reason, one more check). The task doesn't move and its
   * item is already WAITED. A record from another state (or none — a task that
   * predates poll records) is started over from now.
   */
  recordWait(taskId: string, reason: string, now: Date = new Date()): TaskPollRecord | null {
    const task = this.deps.getTask(taskId);
    if (!task) return null;
    const at = now.toISOString();
    const base = task.poll?.state === task.status ? task.poll : { state: task.status, startedAt: at, checks: 0 };
    // A check that ran isn't held: drop any hold left by a check queued some
    // other way (Run, Check now), so the rhythm restarts from this check's end.
    const { heldForReadiness: _held, heldReason: _reason, ...rest } = base;
    const record: TaskPollRecord = { ...rest, lastCheckAt: at, lastWaitReason: reason, checks: base.checks + 1 };
    this.deps.writeTaskPoll(taskId, record);
    return record;
  }

  /**
   * The poll schedule, run on the daemon tick (docs/DESIGN.md "Polling
   * States"). For each task polling in a poll state — its record is for the
   * state it sits in, it hasn't timed out, its latest item WAITED, and none is
   * in flight — decide, as of `now`:
   *   - **due**: last check's end + `pollEvery` has passed → queue one check
   *     through the normal enqueue path (`ctx.enqueue`);
   *   - **timed out**: `startedAt` + `pollTimeout` has passed → apply `onTimeout`;
   *   - **not ready** (the daemon's `readiness.canEnqueueNow`, the same gate
   *     schedules use): neither — the task is marked `heldForReadiness` with
   *     the probe's reason. A held task is retried every tick; on recovery it
   *     gets **exactly one** check (missed intervals collapse), and the timeout
   *     is never applied while held: the recovery check runs first, and the
   *     timeout applies only if that check also waits.
   * A task stops polling when it leaves the state (its record goes), its story
   * goes pending or loses readiness, it is pending, or its latest item isn't
   * WAITED (canceled, failed — or a check in flight). Time the daemon was down
   * just makes a check due once. Nothing here keeps a timer per task.
   */
  runPollChecks(now: Date = new Date()): void {
    for (const story of this.deps.getStories()) {
      if (story.pending || !this.deps.isStoryReady(story.id)) continue;
      const wf = this.deps.getWorkflowForStory(story.id);
      for (const task of this.deps.getTasksForStory(story.id)) {
        const settings = pollSettings(wf, task.status);
        if (settings) this.pollTask(task, settings, now);
      }
    }
  }

  /** One task's turn of the poll schedule (see `runPollChecks`). */
  private pollTask(task: BoardTask, settings: PollSettings, now: Date): void {
    const rec = task.poll;
    if (!rec || rec.state !== task.status || rec.timedOutAt) return;
    if (this.deps.isPending(task.id) || this.ctx.hasActiveItem(task.id)) return; // one check in flight at most
    if (this.deps.getLatestItemState(task.id) !== "WAITED") return;

    const nowMs = now.getTime();
    const held = rec.heldForReadiness === true;
    const timeUp = nowMs >= Date.parse(rec.startedAt) + settings.pollTimeoutMs;
    const due = nowMs >= Date.parse(rec.lastCheckAt ?? rec.startedAt) + settings.pollEveryMs;
    if (!held && !timeUp && !due) return;

    // Readiness gating, as a Schedule holds its firing (docs/DESIGN.md
    // "Readiness Gating"): hold, and keep the probe's reason for display. The
    // timeout decision is deferred too — never applied while held.
    if (!this.ctx.readiness.canEnqueueNow()) {
      const reason = this.deps.getReadinessReason() ?? "the team isn't ready";
      if (!held || rec.heldReason !== reason) this.deps.writeTaskPoll(task.id, { ...rec, heldForReadiness: true, heldReason: reason });
      return;
    }

    // Ready. Not held and out of time: the last check waited, so apply onTimeout.
    // Held (even out of time): run the one recovery check first.
    if (timeUp && !held) {
      this.applyPollTimeout(task, rec, settings, now);
      return;
    }
    this.queueCheck(task.id, rec);
  }

  /** Queue one check and clear any readiness hold (the rhythm resumes from its end). */
  private queueCheck(taskId: string, rec: TaskPollRecord): WorkItem | null {
    const item = this.ctx.enqueue(taskId);
    if (item && (rec.heldForReadiness || rec.heldReason !== undefined)) {
      const { heldForReadiness: _held, heldReason: _reason, ...rest } = rec;
      this.deps.writeTaskPoll(taskId, rest);
    }
    return item;
  }

  /**
   * `pollTimeout` ran out on a task whose last check waited: stop polling
   * (`timedOutAt`), post the daemon's `[timeout]` comment, and apply
   * `onTimeout` — `fail` fails that last check (the task is stuck, as for any
   * failed run); `manual` leaves it in the state for a human to move on or fail.
   */
  private applyPollTimeout(task: BoardTask, rec: TaskPollRecord, settings: PollSettings, now: Date): void {
    this.deps.writeTaskPoll(task.id, { ...rec, timedOutAt: now.toISOString() });
    const span = formatSpan(settings.pollTimeoutMs);
    const checks = `${rec.checks} check${rec.checks === 1 ? "" : "s"}`;
    const last = rec.lastWaitReason ? ` Last wait: ${rec.lastWaitReason}` : "";
    if (settings.onTimeout === "fail") {
      this.deps.addDaemonComment(task.id, `[timeout] "${task.status}" didn't finish within its poll timeout (${span}, ${checks}); the task is failed.${last}`);
      this.deps.failWaitedCheck(task.id);
    } else {
      this.deps.addDaemonComment(task.id,
        `[timeout] "${task.status}" didn't finish within its poll timeout (${span}, ${checks}); polling has stopped. ` +
        `It needs a human: move it on if it's done, or back into the state to poll again.${last}`);
    }
  }

  /**
   * **Check now** (a human): queue one check of a poll-state task immediately,
   * outside its rhythm. Refused when it isn't a board task in a poll state, a
   * check is already queued or running (one in flight at most), the task or its
   * story is pending, or the team isn't ready — then with the probe's reason,
   * rather than queuing a check that would fail. A timed-out task's extra check
   * doesn't resume polling (moving it back into the state does).
   */
  checkNow(taskId: string): CheckNowResult {
    const task = this.deps.getTask(taskId);
    if (!task) return { ok: false, error: `Task "${taskId}" not found`, notFound: true };
    if (!this.pollSettingsFor(taskId)) return { ok: false, error: `"${task.status}" isn't a poll state` };
    const story = this.deps.getStory(task.storyId);
    if (!story || story.pending) return { ok: false, error: "The story is pending" };
    if (this.deps.isPending(taskId)) return { ok: false, error: "The task is pending" };
    if (this.ctx.hasActiveItem(taskId)) return { ok: false, error: "A check is already queued or running" };
    if (!this.ctx.readiness.canEnqueueNow()) {
      const reason = this.deps.getReadinessReason() ?? "the team isn't ready";
      return { ok: false, error: `The team isn't ready: ${reason}`, readiness: reason };
    }
    const rec = task.poll?.state === task.status ? task.poll : { state: task.status, startedAt: new Date().toISOString(), checks: 0 };
    if (!task.poll || task.poll.state !== task.status) this.deps.writeTaskPoll(taskId, rec);
    const item = this.queueCheck(taskId, rec);
    return item ? { ok: true, workItem: item } : { ok: false, error: "The check couldn't be queued" };
  }

  /**
   * A task's poll status for display (the board chip, the task page): its
   * record plus when the next check is due and when the timeout runs out. Null
   * when it isn't in a poll state (or has no record for it).
   */
  pollStatusFor(taskId: string): TaskPollStatus | null {
    const task = this.deps.getTask(taskId);
    const settings = task ? this.pollSettingsFor(taskId) : null;
    if (!task || !settings || !task.poll || task.poll.state !== task.status) return null;
    const rec = task.poll;
    const status: TaskPollStatus = {
      ...rec,
      timeoutAt: new Date(Date.parse(rec.startedAt) + settings.pollTimeoutMs).toISOString(),
      onTimeout: settings.onTimeout,
    };
    const polling = !rec.timedOutAt && !this.ctx.hasActiveItem(taskId) && this.deps.getLatestItemState(taskId) === "WAITED";
    if (polling) status.nextCheckAt = new Date(Date.parse(rec.lastCheckAt ?? rec.startedAt) + settings.pollEveryMs).toISOString();
    return status;
  }

  // ─── Board policy (the Store's board methods delegate here) ───

  /**
   * Low-level position setter: persists the position, keeps the story's
   * open/done status in sync, and makes the queue reflect the new position.
   * All position changes flow through here.
   *
   * Queue sync: landing in a teammate state enqueues a READY item (unless one is
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

    // Poll bookkeeping: landing in a poll state starts a fresh record (re-entry
    // ≡ first entry, so a move back in restarts the clock); anywhere else drops it.
    if (pollSettings(wf, status)) this.deps.writeTaskPoll(taskId, { state: status, startedAt: new Date().toISOString(), checks: 0 });
    else if (task.poll) this.deps.writeTaskPoll(taskId, null);

    if (!keepWorkItem && before && before.status !== status) this.deps.cancelActiveItem(taskId);
    if (isTeammateState(wf, status) && !this.ctx.hasActiveItem(taskId)) this.ctx.enqueue(taskId);

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
   * when entering a teammate state, a fresh READY one is created — re-entry ≡
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
   * Advance a task out of its current teammate state to the next state (or
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

    // setPosition enqueues the READY WorkItem when landing in a teammate state.
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
