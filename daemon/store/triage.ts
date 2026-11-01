/**
 * daemon/store/triage.ts — Triage: the sweep, triage threads, proposals, badges.
 *
 * The triage side of the Store (docs/DESIGN.md "Auto Triage", "External
 * sources" — "Triage mode"):
 *   - the entry points into the Thought source's sweep, Triage now, and due rule;
 *   - what a triage *subject* is (a note's triage container, or a triage-mode
 *     mirror — `isTriageModeMirror`, read from the source's kv on disk);
 *   - analyses posted to a subject's thread, the folded thread state
 *     (`getTriageThread`), the notes' badges, and accepting/rejecting a proposal
 *     (accepting creates the work; it never starts anything itself);
 *   - the team's triage persona (`resolveTriagePersona`, `getTriageInstructions`).
 *
 * The pure rules (turns, folding, validation) live in daemon/triage.ts. The Store
 * delegates its triage methods here one line each. What this needs from the
 * other domains comes in as `TriageStoreDeps`.
 */

import {
  type Comment,
  type ResolvedPersona,
  type BuiltinPersonaId,
  type PersonaVia,
  type TeamConfig,
  type ThreadEntry,
  type TriageBadge,
  type TriageDecision,
  type TriageOutcome,
  type TriageProposal,
  type TriageProposalState,
  type WorkDef,
  type WorkDefOrigin,
  type WorkDefParent,
  type WorkItem,
} from "../../shared/types.ts";
import {
  decisionSummary, foldProposals, latestAnalysis, pendingProposals, triageBadge,
  triageWorkDefId, validateAnalysis,
  type TriageSkipReason,
} from "../triage.ts";
import { isValidCron } from "../cron.ts";
import { sourceIdForWorkDef } from "../sources/registry.ts";
import { isTriageModeMirror } from "../sources/external-triage.ts";
import type { ThoughtSource } from "../sources/thought.ts";
import { fileSourceKv } from "./source-kv.ts";
import { getWorkDef, listWorkDefs, updateWorkDef } from "./workdefs.ts";
import { saveSchedule } from "./schedules.ts";
import type { BoardStore } from "./board.ts";
import type { ThreadStore } from "./threads.ts";
import type { StoreDomainContext } from "./domain.ts";

/**
 * The outcome of accepting or rejecting a triage proposal. The failure carries a
 * `code` so routes map it to a status without reading the message (a missing
 * proposal is a 404; one already decided is a 409).
 */
export type ProposalResult =
  | { ok: true; decision: TriageDecision }
  | { ok: false; code: "not-found" | "conflict"; error: string };

/** Options for accepting a proposal (`Store.acceptProposal`). */
export interface AcceptProposalOptions {
  from?: string;
  /** Record work the author already created through the normal form (the "Edit" path). */
  existingWorkDefId?: string;
  /** The "Edit" path's changes, applied over the proposal. */
  overrides?: TriageProposalOverrides;
}

/** The fields the "Edit" path may change before accepting. */
export type TriageProposalOverrides = Partial<
  Pick<TriageProposal, "title" | "goal" | "acceptanceCriteria" | "additionalContext" | "directory" | "cron" | "storyId">
>;

/** A triage subject's whole triage state (`Store.getTriageThread`). */
export interface TriageThread {
  workDefId: string;
  exists: boolean;
  entries: ThreadEntry[];
  proposals: TriageProposalState[];
  pending: TriageProposalState[];
  badge: TriageBadge;
  latestOutcome: TriageOutcome | null;
}

/** What the triage domain needs from the rest of the Store. */
export interface TriageStoreDeps {
  /** The Thought source: the sweep, Triage now, and the due rule (daemon/sources/thought.ts). */
  notes: Pick<ThoughtSource, "sweep" | "triageNow" | "statusFor" | "ensureWorkDef">;
  /** A subject's thread (read, and append analyses/decisions with no onComment hook). */
  threads: Pick<ThreadStore, "getThreadEntries" | "appendThreadEntry">;
  /** Stories and board tasks, for validating and accepting proposals. */
  board: Pick<BoardStore, "getStory" | "addTask" | "createStory" | "uniqueStoryId">;
  /** Create a WorkDef (the Store's `createWorkDef`; accepting never enqueues, so `enqueue` is false). */
  createWorkDef(input: {
    title: string; parent?: WorkDefParent; goal: string; acceptanceCriteria: string;
    additionalContext?: string; directory?: string; origin?: WorkDefOrigin;
  }, enqueue: boolean): WorkDef;
  /** Resolve a persona reference (the persona domain's `resolvePersona`). */
  resolvePersona(ref: string | undefined | null, opts: { via: PersonaVia; fallback: BuiltinPersonaId | null }, where?: string): ResolvedPersona | null;
}

export class TriageStore {
  private teamDir: string;
  private config: TeamConfig;
  private deps: TriageStoreDeps;

  constructor(ctx: StoreDomainContext, deps: TriageStoreDeps) {
    this.teamDir = ctx.teamDir;
    this.config = ctx.config;
    this.deps = deps;
  }

  /**
   * Is this a mirrored WorkDef in **triage mode** (its recorded mode, from the
   * last sync — docs/DESIGN.md "External sources" — "Triage mode")? Read from
   * the source's kv on disk, so it answers across restarts and even when the
   * source isn't registered any more.
   */
  isTriageModeMirror(def: Pick<WorkDef, "id" | "parent">): boolean {
    return def.parent?.kind === "external" && isTriageModeMirror(def, fileSourceKv(this.teamDir, sourceIdForWorkDef(def)));
  }

  // --- Auto triage (TODO.md "Auto Triage") ---
  //
  // A note is a WorkDef parent: its triage WorkDef is an empty container that owns
  // the thread, and the prompt is built from the note's *current* text at claim
  // time. The turn rule (only a content edit is the author's turn) is in
  // daemon/triage.ts; the note's frontmatter holds the version last handed over.

  // The sweep, Triage now, and the due rule live in the Thought Work Source
  // (daemon/sources/thought.ts); these are the triage domain's entry points into it.

  /**
   * One triage pass over the notes: enqueue a WorkItem for every note whose text
   * has moved on since its last analysis. Returns the items enqueued. (The
   * Thought source's timer calls the same sweep.)
   */
  runTriageSweep(now: number = Date.now()): WorkItem[] {
    return this.deps.notes.sweep(now);
  }

  /**
   * Enqueue a triage run for one note now, skipping the quiet period and the
   * "unchanged" rule — the **Triage now** button. Refuses only when a run is
   * already in flight, or the note can't be triaged.
   */
  triageNow(thoughtId: string): { ok: true; workItem: WorkItem } | { ok: false; error: string } {
    return this.deps.notes.triageNow(thoughtId);
  }

  /** Why the sweep would skip this note right now (null = it's due). */
  triageStatusFor(thoughtId: string, now: number = Date.now()): TriageSkipReason | null {
    return this.deps.notes.statusFor(thoughtId, now);
  }

  /** A note's triage WorkDef, created on first use (never for a note that's never analysed). */
  ensureTriageWorkDef(thoughtId: string): WorkDef | null {
    return this.deps.notes.ensureWorkDef(thoughtId);
  }

  /**
   * The note-triage persona's body, or undefined when the team selected none —
   * the prompt builder then uses `builtin:triage` (DEFAULT_TRIAGE_INSTRUCTIONS).
   * One `triage.persona` for the team, so changing how triage works is one edit
   * rather than one per note. A selection that doesn't resolve falls back to
   * `builtin:triage` with a warning (docs/DESIGN.md "Resolution").
   */
  getTriageInstructions(): string | undefined {
    if (!this.config.triage?.persona) return undefined;
    return this.resolveTriagePersona().body;
  }

  /**
   * What a WorkDef is the triage *subject* of, or null when it isn't one: a
   * note's triage container (`parent.kind: "thought"`), or a triage-mode
   * mirrored WorkDef (docs/DESIGN.md "External sources" — "Triage mode"). Its
   * thread holds the analyses, proposals, and decisions either way.
   */
  triageSubjectOf(workDefId: string): { kind: "thought"; thoughtId: string } | { kind: "mirror" } | null {
    const def = getWorkDef(this.teamDir, workDefId);
    if (!def) return null;
    if (def.parent?.kind === "thought") return { kind: "thought", thoughtId: def.parent.id };
    return this.isTriageModeMirror(def) ? { kind: "mirror" } : null;
  }

  /**
   * Post one analysis (a teammate's reply to a triage run): its prose plus the
   * structured outcome and any proposals. Validated here, so a bad proposal is a
   * fixable error the agent sees instead of a broken thread line.
   */
  addTriageAnalysis(thoughtId: string, from: string, body: string, outcome: TriageOutcome, proposals?: TriageProposal[]):
    { ok: true } | { ok: false; error: string } {
    const workDefId = triageWorkDefId(thoughtId);
    if (!getWorkDef(this.teamDir, workDefId)) return { ok: false, error: `No triage thread for note "${thoughtId}"` };
    return this.addTriageAnalysisForWorkDef(workDefId, from, body, outcome, proposals);
  }

  /**
   * Post one analysis on any triage subject's thread (a note's container or a
   * triage-mode mirror) — the `propose_work` route. Same validation and the
   * same structured comment as a note's.
   */
  addTriageAnalysisForWorkDef(workDefId: string, from: string, body: string, outcome: TriageOutcome, proposals?: TriageProposal[]):
    { ok: true } | { ok: false; error: string } {
    if (!this.triageSubjectOf(workDefId)) return { ok: false, error: `WorkDef "${workDefId}" isn't a triage subject` };
    const invalid = validateAnalysis({ outcome, proposals }, { storyExists: (id) => this.deps.board.getStory(id) !== null });
    if (invalid) return { ok: false, error: invalid };
    const entry: Comment = { from, body, at: new Date().toISOString(), outcome };
    if (outcome === "proposals" && proposals) entry.proposals = proposals;
    return this.deps.threads.appendThreadEntry({ workDefId }, entry) ? { ok: true } : { ok: false, error: "Could not write the thread" };
  }

  /**
   * A triage subject's whole triage state — the thread, its proposals with
   * decisions, the badge — by its WorkDef id (a note's container,
   * `triageWorkDefId(noteId)`, or a triage-mode mirror). `exists` is false when
   * there's no such def.
   */
  getTriageThread(workDefId: string): TriageThread {
    const exists = getWorkDef(this.teamDir, workDefId) !== null;
    const entries = exists ? this.deps.threads.getThreadEntries({ workDefId }) : [];
    return {
      workDefId,
      exists,
      entries,
      proposals: foldProposals(entries),
      pending: pendingProposals(entries),
      badge: triageBadge(entries),
      latestOutcome: latestAnalysis(entries)?.outcome ?? null,
    };
  }

  /** The badge for every note that has one, keyed by note id (the Thoughts list). */
  getTriageBadges(): Record<string, TriageBadge> {
    const out: Record<string, TriageBadge> = {};
    for (const def of listWorkDefs(this.teamDir)) {
      if (def.parent?.kind !== "thought") continue;
      const badge = triageBadge(this.deps.threads.getThreadEntries({ workDefId: def.id }));
      if (badge !== "none") out[def.parent.id] = badge;
    }
    return out;
  }

  /**
   * Accept a proposal on a triage subject (a note's container,
   * `triageWorkDefId(noteId)`, or a triage-mode mirror), by its WorkDef id:
   * create the work it describes and append the decision.
   *
   * **Accepting creates; it never starts anything itself.** What happens next is
   * whatever that kind of work does when you create it by hand: a `task` waits for
   * **Run**, a `schedule` waits for its cron, and a `story-task`/`story` enters its
   * story's workflow — which, exactly as when you add a task to a story yourself,
   * may admit it (CONWIP) and enqueue it immediately. Triage-created work is not a
   * special case of the board (docs/DESIGN.md "Auto Triage").
   *
   * `existingWorkDefId` records an acceptance the author already completed through
   * the normal create form (the "Edit" path), instead of creating it here.
   * `overrides` lets that form's edits land without re-authoring the proposal.
   * The created work's `origin` names the subject: `{ thought }` for a note,
   * `{ workDef }` for a mirror. `where` names the subject in a "No proposal"
   * error (the note routes pass `note <id>`; they check the note exists first).
   */
  acceptProposal(workDefId: string, proposalId: string, opts: AcceptProposalOptions = {}, where = workDefId): ProposalResult {
    const found = this.findProposal(workDefId, proposalId, where);
    if (!found.ok) return found;
    const { state, subject } = found;
    if (state.decision) {
      return { ok: false, code: "conflict", error: `Proposal "${proposalId}" was already ${state.decision.action}` };
    }

    const p = { ...state.proposal, ...opts.overrides };
    const from = opts.from || "you";
    const origin: WorkDefOrigin = subject.kind === "thought"
      ? { thought: subject.thoughtId, proposal: proposalId }
      : { workDef: workDefId, proposal: proposalId };
    let createdId: string | undefined = opts.existingWorkDefId;
    let storyId: string | undefined;

    if (!createdId) {
      switch (p.kind) {
        case "task": {
          const def = this.deps.createWorkDef({
            title: p.title, goal: p.goal ?? "", acceptanceCriteria: p.acceptanceCriteria ?? "",
            additionalContext: p.additionalContext, directory: p.directory, origin,
          }, false); // no WorkItem: a Solitary task waits for the author to press Run
          createdId = def.id;
          break;
        }
        case "story-task": {
          if (!p.storyId || !this.deps.board.getStory(p.storyId)) {
            return { ok: false, code: "conflict", error: `No story "${p.storyId}"` };
          }
          // Board rules apply from here (admission may pull it straight in), the
          // same as adding a task to that story by hand.
          const task = this.deps.board.addTask(p.storyId, { title: p.title, description: p.goal ?? "" });
          if (!task) return { ok: false, code: "conflict", error: "Could not add the task to that story" };
          createdId = task.id;
          storyId = p.storyId;
          updateWorkDef(this.teamDir, task.id, { origin });
          break;
        }
        case "story": {
          const id = this.deps.board.uniqueStoryId(p.title);
          const created = this.deps.board.createStory(
            id, p.title, p.description ?? p.goal ?? "", "open", [],
            (p.tasks ?? []).map((t) => ({ title: t.title, description: t.goal })),
            undefined, undefined, p.directory,
          );
          storyId = created.story.id;
          for (const t of created.tasks) updateWorkDef(this.teamDir, t.id, { origin });
          break;
        }
        case "schedule": {
          if (!isValidCron(p.cron ?? "")) return { ok: false, code: "conflict", error: "That proposal has no valid cron" };
          const schedule = saveSchedule(this.teamDir, { title: p.title, cron: p.cron! });
          const def = this.deps.createWorkDef({
            title: p.title, goal: p.goal ?? "", acceptanceCriteria: p.acceptanceCriteria ?? "",
            additionalContext: p.additionalContext, directory: p.directory,
            parent: { kind: "schedule", id: schedule.id }, origin,
          }, false); // the cron enqueues it, not us
          createdId = def.id;
          break;
        }
      }
    }

    const decision: TriageDecision = {
      kind: "decision", proposalId, action: "accepted", from, at: new Date().toISOString(),
      ...(createdId ? { workDefId: createdId } : {}),
      ...(storyId ? { storyId } : {}),
    };
    this.deps.threads.appendThreadEntry({ workDefId }, decision);
    return { ok: true, decision };
  }

  /**
   * Reject a proposal on a triage subject, by its WorkDef id (`where` as for
   * `acceptProposal`): one appended line, no reason. Not a turn.
   */
  rejectProposal(workDefId: string, proposalId: string, from = "you", where = workDefId): ProposalResult {
    const found = this.findProposal(workDefId, proposalId, where);
    if (!found.ok) return found;
    if (found.state.decision) {
      return { ok: false, code: "conflict", error: `Proposal "${proposalId}" was already ${found.state.decision.action}` };
    }
    const decision: TriageDecision = {
      kind: "decision", proposalId, action: "rejected", from, at: new Date().toISOString(),
    };
    this.deps.threads.appendThreadEntry({ workDefId }, decision);
    return { ok: true, decision };
  }

  /** Locate one proposal in a triage subject's thread (`where` names it in the error). */
  private findProposal(workDefId: string, proposalId: string, where: string):
    | { ok: true; state: TriageProposalState; subject: NonNullable<ReturnType<TriageStore["triageSubjectOf"]>> }
    | { ok: false; code: "not-found"; error: string } {
    const subject = this.triageSubjectOf(workDefId);
    if (!subject) return { ok: false, code: "not-found", error: `WorkDef "${workDefId}" isn't a triage subject` };
    const thread = this.getTriageThread(workDefId);
    // Latest wins if an id was reused across analyses (foldProposals keeps order).
    const state = [...thread.proposals].reverse().find((s) => s.proposal.id === proposalId);
    return state
      ? { ok: true, state, subject }
      : { ok: false, code: "not-found", error: `No proposal "${proposalId}" on ${where}` };
  }

  /**
   * Earlier proposals and what the author decided, for the next run's prompt —
   * any triage subject, by its WorkDef id (a note's container or a triage-mode mirror).
   */
  triageDecisionSummary(workDefId: string): string[] {
    return decisionSummary(this.getTriageThread(workDefId).entries);
  }

  /** The team's triage persona: `triage.persona`, else (or when it doesn't resolve) `builtin:triage`. */
  resolveTriagePersona(): ResolvedPersona {
    const ref = this.config.triage?.persona || "builtin:triage";
    return this.deps.resolvePersona(ref, { via: "triage", fallback: "builtin:triage" }, "triage.persona")!;
  }
}
