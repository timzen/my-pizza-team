/**
 * lib/triage.ts — Types and wording for auto triage in the UI
 * (docs/DESIGN.md "Auto Triage: a Note Is a Parent").
 *
 * The wire types are hand-mirrored from shared/types.ts (as lib/assistant-types.ts
 * does), and the rules here are the ones worth testing without a browser
 * (tests/triage-ui.test.ts): what a badge means, how a proposal reads, and which
 * fields a kind lets you edit before accepting.
 */

export type TriageOutcome = "proposals" | "nothing" | "question";
export type TriageBadge = "none" | "proposal" | "nothing" | "question";
export type TriageProposalKind = "task" | "story-task" | "story" | "schedule";

export interface TriageProposal {
  id: string;
  kind: TriageProposalKind;
  title: string;
  goal?: string;
  acceptanceCriteria?: string;
  additionalContext?: string;
  directory?: string;
  storyId?: string;
  cron?: string;
  description?: string;
  tasks?: Array<{ title: string; goal: string; acceptanceCriteria?: string }>;
}

export interface TriageDecision {
  kind: "decision";
  proposalId: string;
  action: "accepted" | "rejected";
  workDefId?: string;
  storyId?: string;
  from: string;
  at: string;
}

/** An analysis (a comment carrying an outcome) or an ordinary comment. */
export interface TriageComment {
  from: string;
  body: string;
  at: string;
  outcome?: TriageOutcome;
  proposals?: TriageProposal[];
}

export type TriageThreadEntry = TriageComment | TriageDecision;

export interface TriageProposalState {
  proposal: TriageProposal;
  at: string;
  from: string;
  decision?: TriageDecision;
}

/** GET /api/thoughts/:id/triage */
export interface TriageView {
  note: {
    id: string; content: string; color: string; status: string; groupId: string | null;
    updatedAt: string; createdAt: string; triagedVersion?: string;
  };
  workDefId: string;
  triaged: boolean;
  entries: TriageThreadEntry[];
  proposals: TriageProposalState[];
  pending: TriageProposalState[];
  badge: TriageBadge;
  latestOutcome: TriageOutcome | null;
  /** Why the sweep would skip this note now; null = it's due. */
  skipReason: "archived" | "empty" | "in-flight" | "unchanged" | "too-fresh" | null;
}

export function isDecision(entry: TriageThreadEntry): entry is TriageDecision {
  return (entry as TriageDecision).kind === "decision";
}

/** The badge's tooltip — it says what to expect, since the icon is the label. */
export function badgeTitle(badge: TriageBadge): string {
  switch (badge) {
    case "proposal": return "A teammate proposed work from this note — open triage to accept, edit, or reject";
    case "question": return "A teammate has a question about this note — answer it by editing the note";
    case "nothing": return "A teammate read this note and found nothing to create";
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
