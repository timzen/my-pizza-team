/**
 * daemon/sources/thought.ts — The built-in Thought (auto-triage) Work Source.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" and "Auto Triage";
 * the turn rule itself (which notes are due) is pure, in daemon/triage.ts.
 *
 * A note is a WorkDef parent: its triage WorkDef (`triage-<noteId>`) is an empty
 * container that owns the thread. This source:
 *   - sweeps the notes on its own interval (`tickEveryMs` = the triage interval)
 *     and enqueues one for each note whose text has moved on — "once per
 *     revision of the source content", via the core `ctx.enqueueRevision` with
 *     the note's `updatedAt` as the revision and its `triagedVersion`
 *     frontmatter as the cursor (stamped at enqueue);
 *   - resolves the item's title from the note and, lacking its own directory,
 *     runs it in the leader's repo;
 *   - keeps an item eligible only while its note is active;
 *   - builds the triage prompt from `triage.md` plus the note as it reads now;
 *   - makes **Run** mean **Triage now**.
 * It needs nothing on terminal: the result is the analysis the teammate posts
 * with `propose_work` before it completes (Store.addTriageAnalysis).
 *
 * Thought is always on: it declares no `toggle`, so daemon/features.ts maps a
 * Triage WorkDef to no feature and it's always registered.
 *
 * Store-level reads it can't get from `SourceContext` (notes, the leader,
 * stories, the thread) come in as `ThoughtSourceDeps`, so the source never
 * imports the Store.
 */

import { resolveTriage, type Comment, type Thought, type ThoughtGroup, type WorkDef, type WorkItem } from "../../shared/types.ts";
import { buildTriagePrompt } from "../prompt.ts";
import {
  isTriageDue,
  thoughtIdFromTriageWorkDef,
  triageSkipReason,
  type TriageSkipReason,
  triageWorkDefId,
  triageWorkDefTitle,
  triageWorkItemTitle,
} from "../triage.ts";
import { getWorkDef, saveWorkDef, updateWorkDef } from "../store/workdefs.ts";
import { getThought as ioGetThought, writeThought } from "../store/thoughts.ts";
import type { RevisionCursor, RunResult, SourceContext, WorkSource } from "./types.ts";

/** The Thought source's id (= its WorkDefs' `parent.kind`). */
export const THOUGHT_SOURCE_ID = "thought";

/** The Store-level reads the Thought source needs (supplied by the Store). */
export interface ThoughtSourceDeps {
  getThought(id: string): Thought | null;
  getActiveThoughts(): Thought[];
  getThoughtGroup(id: string): ThoughtGroup | null;
  /** The registered leader's directory, if any (where triage runs by default). */
  leaderDirectory(): string | undefined;
  /** The team's `triage.md`, or undefined for the built-in default. */
  getTriageInstructions(): string | undefined;
  /** Open (not done) stories, so a proposal can attach a task to one. */
  getOpenStories(): Array<{ id: string; title: string }>;
  getComments(workDefId: string): Comment[];
  /** One line per earlier proposal and its decision (Store.triageDecisionSummary). */
  decisionSummary(thoughtId: string): string[];
}

export class ThoughtSource implements WorkSource {
  readonly id = THOUGHT_SOURCE_ID;
  readonly apiVersion = 1 as const;
  private context: SourceContext | null = null;

  private deps: ThoughtSourceDeps;

  constructor(deps: ThoughtSourceDeps) {
    this.deps = deps;
  }

  /**
   * The cursor for `enqueueRevision`: a note's `triagedVersion` frontmatter, so
   * the stamp stays where it always was (the note file) rather than moving to
   * the source's kv — no change to what's on disk.
   */
  private readonly noteCursor: RevisionCursor = {
    get: (defId) => {
      const thoughtId = thoughtIdFromTriageWorkDef(defId);
      return thoughtId ? this.deps.getThought(thoughtId)?.triagedVersion : undefined;
    },
    set: (defId, revision) => {
      const thoughtId = thoughtIdFromTriageWorkDef(defId);
      const fresh = thoughtId ? ioGetThought(this.ctx.teamDir, thoughtId) : null;
      if (!fresh) return;
      fresh.triagedVersion = revision;
      writeThought(this.ctx.teamDir, fresh);
    },
  };

  private get ctx(): SourceContext {
    if (!this.context) throw new Error("Thought source used before it was registered");
    return this.context;
  }

  init(ctx: SourceContext): void {
    this.context = ctx;
  }

  /** The sweep runs every `intervalMinutes` — and not at all when triage is off. */
  tickEveryMs(ctx: SourceContext): number | null {
    const triage = resolveTriage(ctx.config());
    return triage.enabled ? triage.intervalMinutes * 60 * 1000 : null;
  }

  tick(_ctx: SourceContext, now: Date): void {
    this.sweep(now.getTime());
  }

  /**
   * Only while its note is still there and active: archiving a note archives its
   * WorkDef, but an already-queued item must stop being handed out too.
   */
  isEligible(def: WorkDef): boolean {
    const note = def.parent ? this.deps.getThought(def.parent.id) : null;
    return note !== null && note.status === "active";
  }

  /**
   * The WorkDef is an empty container, so the item's title and where it runs are
   * resolved at enqueue: the title from the note, the directory from the leader
   * (the one place with project context). With no leader registered the item has
   * no directory, so any teammate may take it.
   */
  resolveItem(def: WorkDef): { title?: string; directory?: string } {
    const note = def.parent ? this.deps.getThought(def.parent.id) : null;
    return {
      title: note ? triageWorkItemTitle(note) : undefined,
      directory: def.directory || this.deps.leaderDirectory(),
    };
  }

  /**
   * Not the base prompt: a triage WorkDef has no authored goal, so the prompt is
   * the team's `triage.md` plus the note as it reads *now*, its earlier analyses,
   * and what the author decided about earlier proposals.
   */
  buildPrompt(def: WorkDef, _base: string): string {
    const note = def.parent ? this.deps.getThought(def.parent.id) : null;
    if (!note) return "";
    const group = note.groupId ? this.deps.getThoughtGroup(note.groupId) : null;
    return buildTriagePrompt({
      note: { id: note.id, content: note.content, updatedAt: note.updatedAt },
      groupName: group?.title,
      instructions: this.deps.getTriageInstructions(),
      stories: this.deps.getOpenStories(),
      priorComments: this.deps.getComments(def.id),
      priorDecisions: this.deps.decisionSummary(note.id),
    });
  }

  /** **Run** on a triage thread is **Triage now**, which knows the note's rules. */
  run(def: WorkDef): RunResult {
    const res = this.triageNow(def.parent?.id ?? "");
    return res.ok ? res : { ok: false, conflict: true, error: res.error };
  }

  // ─── Triage operations (the Store's public triage methods delegate here) ───

  /**
   * One triage pass over the notes: enqueue a WorkItem for every note whose text
   * has moved on since its last analysis. Returns the items enqueued.
   *
   * Every non-archived, non-empty note is eligible and there is no per-sweep cap,
   * so the first sweep after enabling triage covers the whole board (TODO.md
   * "Auto Triage" Decisions 1–2).
   */
  sweep(now: number = Date.now()): WorkItem[] {
    const { enabled, quietMinutes } = resolveTriage(this.ctx.config());
    if (!enabled) return [];
    const out: WorkItem[] = [];
    for (const note of this.deps.getActiveThoughts()) {
      if (!isTriageDue({ note, inFlight: this.inFlight(note.id), now, quietMinutes })) continue;
      const item = this.enqueue(note.id, false);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * Enqueue a triage run for one note now, skipping the quiet period and the
   * "unchanged" rule — the **Triage now** button, and the only way to retry a
   * note whose last run failed (its version was already stamped). Refuses only
   * when a run is already in flight, or the note can't be triaged.
   */
  triageNow(thoughtId: string): { ok: true; workItem: WorkItem } | { ok: false; error: string } {
    const note = this.deps.getThought(thoughtId);
    if (!note) return { ok: false, error: `Thought "${thoughtId}" not found` };
    const reason = triageSkipReason({ note, inFlight: this.inFlight(thoughtId), now: 0, quietMinutes: 0 });
    // "unchanged"/"too-fresh" are what this button exists to override.
    if (reason === "archived") return { ok: false, error: "An archived note isn't triaged" };
    if (reason === "empty") return { ok: false, error: "An empty note has nothing to triage" };
    if (reason === "in-flight") return { ok: false, error: "This note is already being triaged" };
    const item = this.enqueue(thoughtId, true);
    return item ? { ok: true, workItem: item } : { ok: false, error: "Could not enqueue triage" };
  }

  /** Why the sweep would skip this note right now (null = it's due). */
  statusFor(thoughtId: string, now: number = Date.now()): TriageSkipReason | null {
    const note = this.deps.getThought(thoughtId);
    if (!note) return "archived";
    const { quietMinutes } = resolveTriage(this.ctx.config());
    return triageSkipReason({ note, inFlight: this.inFlight(thoughtId), now, quietMinutes });
  }

  /** A note's triage WorkDef, created on first use (never for a note that's never analysed). */
  ensureWorkDef(thoughtId: string): WorkDef | null {
    const note = this.deps.getThought(thoughtId);
    if (!note) return null;
    const teamDir = this.ctx.teamDir;
    const id = triageWorkDefId(thoughtId);
    const existing = getWorkDef(teamDir, id);
    if (existing) {
      // A note un-archived after its WorkDef was archived: bring it back.
      if (existing.status === "archived" && note.status === "active") {
        return updateWorkDef(teamDir, id, { status: "active" });
      }
      return existing;
    }
    // Authored content only, and there is none: the instructions live in
    // triage.md and the note's text is injected at claim time.
    return saveWorkDef(teamDir, {
      id,
      title: triageWorkDefTitle(thoughtId),
      parent: { kind: "thought", id: thoughtId },
      goal: "",
      acceptanceCriteria: "",
    });
  }

  /** Is a triage run for this note queued or running? */
  private inFlight(thoughtId: string): boolean {
    return this.ctx.hasActiveItem(triageWorkDefId(thoughtId));
  }

  /**
   * Create the WorkDef if needed and enqueue once for the note's current version
   * (`updatedAt`), stamping it as `triagedVersion`. Stamping **at enqueue** is what
   * makes an edit during a run survive (it lands after the stamp, so the note is
   * due again) and a failed run not retry every sweep. The due rule
   * (`triageSkipReason`) has already been applied by the caller; `force` is
   * **Triage now** re-running an unchanged note.
   */
  private enqueue(thoughtId: string, force: boolean): WorkItem | null {
    const note = this.deps.getThought(thoughtId);
    if (!note) return null;
    if (!this.ensureWorkDef(thoughtId)) return null;
    return this.ctx.enqueueRevision(triageWorkDefId(thoughtId), note.updatedAt, { force, cursor: this.noteCursor });
  }
}
