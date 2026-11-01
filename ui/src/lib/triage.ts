/**
 * lib/triage.ts — Types and wording for auto triage in the UI
 * (docs/DESIGN.md "Auto Triage: a Note Is a Parent"), for both triage subjects:
 * a note, and a triage-mode external item (docs/DESIGN.md "External sources" —
 * "Triage mode"), whose mirrored WorkDef's own thread holds the analyses.
 *
 * The wire types are shared/types.ts's and shared/protocol.ts's; the rules here
 * are the ones worth testing without a browser (tests/triage-ui.test.ts): what a
 * badge means, how a proposal reads, and which fields a kind lets you edit before
 * accepting.
 */

import type {
  Comment,
  ThreadEntry,
  TriageBadge,
  TriageDecision,
  TriageOutcome,
  TriageProposal,
  TriageProposalKind,
  TriageProposalState,
} from "@shared/types";
import type { ThoughtTriageResponse, WorkDefTriageResponse } from "@shared/protocol";

export type { TriageBadge, TriageDecision, TriageOutcome, TriageProposal, TriageProposalKind, TriageProposalState };

/** An analysis (a comment carrying an outcome) or an ordinary comment. */
export type TriageComment = Comment;

/** One line of a triage thread: an analysis/comment, or a decision. */
export type TriageThreadEntry = ThreadEntry;

/** GET /api/thoughts/:id/triage */
export type TriageView = ThoughtTriageResponse;

/** GET /api/work-defs/:id/triage — any triage subject by WorkDef id (what a triage-mode mirror's page uses). */
export type WorkDefTriageView = WorkDefTriageResponse;

/** What is being triaged: a note, or an external (mirrored) item. Picks the wording. */
export type TriageSubject = "note" | "item";

export function isDecision(entry: TriageThreadEntry): entry is TriageDecision {
  return (entry as TriageDecision).kind === "decision";
}

/**
 * The badge's tooltip — it says what to expect, since the icon is the label.
 * An external item can't be edited here, so its question is answered where it
 * lives: a new revision is the next turn.
 */
export function badgeTitle(badge: TriageBadge, subject: TriageSubject = "note"): string {
  switch (badge) {
    case "proposal": return `A teammate proposed work from this ${subject} — open triage to accept, edit, or reject`;
    case "question": return subject === "note"
      ? "A teammate has a question about this note — answer it by editing the note"
      : "A teammate has a question about this item — answer it in its source; the next revision is triaged again";
    case "nothing": return `A teammate read this ${subject} and found nothing to create`;
    default: return "";
  }
}

/** What an outcome is called in the UI. */
export function outcomeLabel(outcome: TriageOutcome | null): string {
  switch (outcome) {
    case "proposals": return "Proposed work";
    case "question": return "Question for you";
    case "nothing": return "Nothing to create";
    default: return "No analysis yet";
  }
}

/** What a proposal would create, in words. */
export function kindLabel(kind: TriageProposalKind, storyId?: string): string {
  switch (kind) {
    case "task": return "Standalone task";
    case "story-task": return `Task in story ${storyId ?? "?"}`;
    case "story": return "New story";
    case "schedule": return "Scheduled job";
  }
}

/** Which fields the Edit-before-accept form shows for this kind. */
export function editableFields(kind: TriageProposalKind): Array<"title" | "goal" | "acceptanceCriteria" | "directory" | "cron"> {
  // A story's goal lives in its tasks, so there's nothing single to edit here;
  // a schedule additionally owns its cron.
  if (kind === "story") return ["title", "directory"];
  const base: Array<"title" | "goal" | "acceptanceCriteria" | "directory" | "cron"> =
    ["title", "goal", "acceptanceCriteria", "directory"];
  return kind === "schedule" ? [...base, "cron"] : base;
}

/**
 * Why **Triage now** is unavailable, in words — or null when it can run. The
 * button exists to override "unchanged" and the quiet period, so those aren't
 * reasons to disable it.
 */
export function triageNowBlocked(skipReason: TriageView["skipReason"]): string | null {
  switch (skipReason) {
    case "in-flight": return "A triage run for this note is already queued or running";
    case "archived": return "Archived notes aren't triaged";
    case "empty": return "An empty note has nothing to triage";
    default: return null;
  }
}

/**
 * Why **Triage now** is unavailable on a triage-mode external item — or null
 * when it can run. Like a note's, it overrides "unchanged", so only a run in
 * flight or an archived item (sync stopped reporting it) blocks it.
 */
export function mirrorTriageNowBlocked(latestState: string | null, archived: boolean): string | null {
  if (archived) return "Archived items aren't triaged";
  if (latestState === "READY" || latestState === "IN_PROGRESS" || latestState === "MORIBUND") {
    return "A triage run for this item is already queued or running";
  }
  return null;
}

/**
 * The thread as rounds: each analysis with the decisions that answered its
 * proposals, oldest first. Ordinary comments (no outcome) aren't rounds.
 */
export function analysesWithDecisions(entries: TriageThreadEntry[]): Array<{
  analysis: TriageComment;
  decisions: TriageDecision[];
}> {
  const out: Array<{ analysis: TriageComment; decisions: TriageDecision[] }> = [];
  const groupOfProposal = new Map<string, number>();
  for (const entry of entries) {
    if (isDecision(entry)) {
      const i = groupOfProposal.get(entry.proposalId);
      if (i !== undefined) out[i]!.decisions.push(entry);
      continue;
    }
    if (!entry.outcome) continue;
    const index = out.length;
    out.push({ analysis: entry, decisions: [] });
    for (const p of entry.proposals ?? []) groupOfProposal.set(p.id, index);
  }
  return out;
}

/** What the note's own row/card links to. */
export function triagePath(noteId: string): string {
  return `/thoughts/${encodeURIComponent(noteId)}/triage`;
}

/** Where a triage-mode external item's triage view lives: its WorkDef page's Triage tab. */
export function mirrorTriagePath(workDefId: string): string {
  return `/work-defs/${encodeURIComponent(workDefId)}?tab=triage`;
}
