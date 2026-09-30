/**
 * daemon/triage.ts — The auto-triage rules: which notes are due for analysis,
 * and what their WorkDef and WorkItem are called. See TODO.md "Auto Triage".
 *
 * Pure functions with no Store or IO, like cron.ts beside the scheduler, so the
 * turn rule — the fiddly part — is unit-testable (tests/triage.test.ts).
 *
 * The turn rule in one line: **you edit the note, the teammate comments.** A note
 * is due when its text has moved on since the version last handed to triage.
 */

import {
  isTriageDecision,
  type Comment,
  type ThreadEntry,
  type Thought,
  type TriageBadge,
  type TriageOutcome,
  type TriageProposal,
  type TriageProposalState,
} from "../shared/types.ts";
import { isValidCron } from "./cron.ts";

/** Id prefix for a note's triage WorkDef: one per note, derived from its id. */
export const TRIAGE_WORKDEF_PREFIX = "triage-";

/** The triage WorkDef id for a note (stable, so it's found rather than duplicated). */
export function triageWorkDefId(thoughtId: string): string {
  return `${TRIAGE_WORKDEF_PREFIX}${thoughtId}`;
}

/** The note a triage WorkDef id belongs to, or null if it isn't one. */
export function thoughtIdFromTriageWorkDef(workDefId: string): string | null {
  return workDefId.startsWith(TRIAGE_WORKDEF_PREFIX) ? workDefId.slice(TRIAGE_WORKDEF_PREFIX.length) : null;
}

/** Title of a note's triage WorkDef — generic: the note's text lives in the note. */
export function triageWorkDefTitle(thoughtId: string): string {
  return `Triage note ${thoughtId}`;
}

/** First non-empty line of a note, stripped of markdown heading/bullet marks. */
export function noteFirstLine(content: string, max = 60): string {
  const line = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const clean = line.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * The WorkItem's title, resolved at enqueue so the queue and Inbox read as the
 * note rather than as "Triage note th-1790…".
 */
export function triageWorkItemTitle(note: Pick<Thought, "id" | "content">): string {
  const first = noteFirstLine(note.content);
  return first ? `Triage: ${first}` : `Triage note ${note.id}`;
}

/** Why a note isn't due for triage, or null when it is. */
export type TriageSkipReason =
  | "archived"
  | "empty"
  | "in-flight"
  | "unchanged"
  | "too-fresh";

export interface TriageDueInput {
  note: Pick<Thought, "status" | "content" | "updatedAt" | "triagedVersion">;
  /** Does this note already have a READY or IN_PROGRESS triage WorkItem? */
  inFlight: boolean;
  /** Now, as epoch ms. */
  now: number;
  /** Leave a note alone for this many minutes after its last edit. */
  quietMinutes: number;
}

/**
 * Is this note due for a triage run? `null` means yes; otherwise the reason not.
 *
 * - **archived / empty** — never eligible.
 * - **in-flight** — one run at a time per note; the next sweep picks up any edit
 *   made meanwhile (which is why the version is stamped at enqueue).
 * - **unchanged** — its text hasn't moved since the version last handed over.
 *   A *failed* run therefore doesn't retry every sweep: the stamp happened when
 *   it was enqueued (TODO.md "Auto Triage" Decision 3). **Triage now** overrides.
 * - **too-fresh** — edited within the quiet period, so the sweep doesn't read a
 *   half-written thought. It goes in the next sweep.
 */
export function triageSkipReason(input: TriageDueInput): TriageSkipReason | null {
  const { note, inFlight, now, quietMinutes } = input;
  if (note.status !== "active") return "archived";
  if (note.content.trim() === "") return "empty";
  if (inFlight) return "in-flight";
  if (note.triagedVersion && note.triagedVersion >= (note.updatedAt || "")) return "unchanged";
  const editedAt = Date.parse(note.updatedAt || "");
  if (Number.isFinite(editedAt) && now - editedAt < quietMinutes * 60 * 1000) return "too-fresh";
  return null;
}

/** Sugar for the sweep. */
export function isTriageDue(input: TriageDueInput): boolean {
  return triageSkipReason(input) === null;
}

// ─── Analyses, proposals, decisions ──────────────────────────────────

const OUTCOMES: readonly TriageOutcome[] = ["proposals", "nothing", "question"];
const KINDS = ["task", "story-task", "story", "schedule"] as const;

/** What validation needs to know about the team (so this stays pure). */
export interface ProposalContext {
  storyExists: (id: string) => boolean;
}

/**
 * Why this analysis can't be accepted, or null when it's fine. The teammate gets
 * the message back from `propose_work` and can fix it, so these read as
 * instructions rather than error codes.
 */
export function validateAnalysis(
  input: { outcome?: unknown; proposals?: unknown },
  ctx: ProposalContext,
): string | null {
  const outcome = input.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as TriageOutcome)) {
    return `outcome must be one of: ${OUTCOMES.join(", ")}`;
  }
  const proposals = input.proposals;
  if (outcome !== "proposals") {
    if (Array.isArray(proposals) && proposals.length > 0) {
      return `outcome "${outcome}" carries no proposals — use outcome "proposals" if you have some`;
    }
    return null;
  }
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return 'outcome "proposals" needs at least one proposal (use "nothing" or "question" instead)';
  }
  const seen = new Set<string>();
  for (const [i, raw] of proposals.entries()) {
    const where = `proposal ${i + 1}`;
    const p = raw as Partial<TriageProposal>;
    if (!p || typeof p !== "object") return `${where}: must be an object`;
    if (!p.id || typeof p.id !== "string") return `${where}: needs an id (e.g. "p${i + 1}")`;
    if (seen.has(p.id)) return `${where}: duplicate id "${p.id}"`;
    seen.add(p.id);
    const reason = validateProposal(p, ctx);
    if (reason) return `${where} ("${p.id}"): ${reason}`;
  }
  return null;
}

/** Why one proposal is unusable, or null. */
export function validateProposal(p: Partial<TriageProposal>, ctx: ProposalContext): string | null {
  if (!p.kind || !(KINDS as readonly string[]).includes(p.kind)) {
    return `kind must be one of: ${KINDS.join(", ")}`;
  }
  if (!p.title || typeof p.title !== "string" || !p.title.trim()) return "needs a title";
  if (p.kind === "story") {
    if (!Array.isArray(p.tasks) || p.tasks.length === 0) return "a story proposal needs at least one task";
    for (const [i, t] of p.tasks.entries()) {
      if (!t?.title?.trim()) return `task ${i + 1} needs a title`;
      if (!t?.goal?.trim()) return `task ${i + 1} needs a goal`;
    }
    return null;
  }
  if (!p.goal || typeof p.goal !== "string" || !p.goal.trim()) return "needs a goal";
  if (p.kind === "story-task") {
    if (!p.storyId) return "a story-task proposal needs the storyId it belongs to";
    if (!ctx.storyExists(p.storyId)) return `no story "${p.storyId}" — use one from the Open Stories list, or propose kind "task"`;
  }
  if (p.kind === "schedule" && !isValidCron(p.cron ?? "")) {
    return "a schedule proposal needs a valid 5-field cron (e.g. \"0 9 * * 1-5\")";
  }
  return null;
}

/**
 * Every proposal in a thread, in order, with the author's decision folded in.
 * Reading the file top to bottom *is* the state: a proposal no decision names is
 * still pending.
 */
export function foldProposals(entries: ThreadEntry[]): TriageProposalState[] {
  const states: TriageProposalState[] = [];
  const byId = new Map<string, TriageProposalState>();
  for (const entry of entries) {
    if (isTriageDecision(entry)) {
      const target = byId.get(entry.proposalId);
      if (target) target.decision = entry;
      continue;
    }
    for (const proposal of entry.proposals ?? []) {
      // A later analysis may reuse an id; the newest wins the name.
      const state: TriageProposalState = { proposal, at: entry.at, from: entry.from };
      states.push(state);
      byId.set(proposal.id, state);
    }
  }
  return states;
}

/** The most recent analysis (a comment carrying an `outcome`), if any. */
export function latestAnalysis(entries: ThreadEntry[]): Comment | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!isTriageDecision(e) && e.outcome) return e;
  }
  return null;
}

/**
 * The note's badge: the latest analysis's outcome — except that proposals whose
 * every item has been decided are done with, and show nothing.
 */
export function triageBadge(entries: ThreadEntry[]): TriageBadge {
  const latest = latestAnalysis(entries);
  if (!latest) return "none";
  if (latest.outcome === "question") return "question";
  if (latest.outcome === "nothing") return "nothing";
  const ids = new Set((latest.proposals ?? []).map((p) => p.id));
  const pending = foldProposals(entries).filter((s) => ids.has(s.proposal.id) && !s.decision);
  return pending.length > 0 ? "proposal" : "none";
}

/** The proposals from the latest analysis that are still waiting on the author. */
export function pendingProposals(entries: ThreadEntry[]): TriageProposalState[] {
  const latest = latestAnalysis(entries);
  if (!latest || latest.outcome !== "proposals") return [];
  const ids = new Set((latest.proposals ?? []).map((p) => p.id));
  return foldProposals(entries).filter((s) => ids.has(s.proposal.id) && !s.decision);
}

/**
 * One line per earlier proposal and what the author did with it, for the next
 * run's prompt — so a rejected idea isn't proposed again.
 */
export function decisionSummary(entries: ThreadEntry[]): string[] {
  return foldProposals(entries).map((s) => {
    const what = `${s.proposal.kind}: ${s.proposal.title}`;
    if (!s.decision) return `${what} — still undecided`;
    if (s.decision.action === "rejected") return `${what} — REJECTED by the author`;
    const created = s.decision.workDefId || s.decision.storyId;
    return `${what} — accepted${created ? ` (created ${created})` : ""}`;
  });
}
