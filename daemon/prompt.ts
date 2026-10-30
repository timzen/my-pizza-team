/**
 * daemon/prompt.ts — Assembles the full task prompt: the message an agent
 * receives when it claims a task.
 *
 * This lives in the daemon (not the harness) so every adapter — the Pi extension,
 * future wrappers — delivers one identical, canonical prompt
 * verbatim. Keeping it here also means prompt wording/order changes in a single,
 * testable place instead of drifting across harnesses.
 *
 * Section order: state persona (role framing, board work only) → Story (board
 * work only) → working directory instruction → Goal → Acceptance Criteria →
 * Additional Context → lead comments → completion guidance. (The former
 * "Reference Context" section went with the context library; the persona
 * migration inlined its text into Additional Context — docs/DESIGN.md "Personas".)
 *
 * There are no transition instructions: workers never move work (see
 * docs/DESIGN.md "The Work Model") — completing the work advances its story task
 * mechanically (or, for standalone work, just records the outcome).
 *
 * `buildTriagePrompt` is the auto-triage variant (TODO.md "Auto Triage"): a
 * Thought-parented WorkDef carries no authored goal, so its prompt is assembled
 * from the team's triage persona plus the note's *current* text.
 * `buildExternalTriagePrompt` is the same prompt with a triage-mode external
 * item as its subject (docs/DESIGN.md "External sources" — "Triage mode").
 */

import type { WorkDef } from "../shared/types.ts";
import { DEFAULT_TRIAGE_INSTRUCTIONS } from "./personas/builtins.ts";

/**
 * Demote instruction-file headings so they nest *below* the prompt's own
 * section headers (`##`), preventing author markdown from competing with or
 * mangling the prompt structure. Fence-aware: never rewrites `#` inside fenced
 * code blocks. Preserves relative hierarchy (shifts every heading by the same
 * amount so the shallowest becomes `minLevel`). No-op if there are no headings
 * or they're already deep enough.
 */
export function normalizeInstructionMarkdown(md: string, minLevel = 3): string {
  const lines = md.split("\n");
  const isFence = (line: string) => /^\s*(```+|~~~+)/.test(line);

  // Pass 1: find the shallowest heading level outside code fences.
  let inFence = false;
  let shallowest = 7;
  for (const line of lines) {
    if (isFence(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s/);
    if (h) shallowest = Math.min(shallowest, h[1]!.length);
  }
  if (shallowest === 7 || shallowest >= minLevel) return md;

  // Pass 2: shift every heading down by the same delta (capped at 6).
  const shift = minLevel - shallowest;
  inFence = false;
  return lines
    .map((line) => {
      if (isFence(line)) { inFence = !inFence; return line; }
      if (inFence) return line;
      const h = line.match(/^(#{1,6})(\s.*)$/);
      if (!h) return line;
      const newLevel = Math.min(6, h[1]!.length + shift);
      return "#".repeat(newLevel) + h[2]!;
    })
    .join("\n");
}

/** Build the complete prompt an agent gets on claim. Every unit of work is a
 * WorkDef; the optional `story`/`state`/`persona` add board framing when the
 * WorkDef's parent is a story (see docs/DESIGN.md "WorkDefs & Parents"). */
export interface WorkDefPromptInput {
  /** The work to do (authored content). */
  workDef: Pick<WorkDef, "title" | "goal" | "acceptanceCriteria" | "additionalContext" | "directory">;
  /** Parent story (board work only) — the bigger picture. */
  story?: { id: string; title: string; description: string; directory?: string };
  /** The workflow state being worked (board work only). */
  state?: string;
  /**
   * The state's persona body (the persona its workflow state names): role
   * framing for whoever works this state — reviewer, implementer, CR-writer, etc.
   */
  persona?: string;
  /**
   * Comments on the ref; only the human's comments are surfaced (rework/feedback).
   * The human posts as "lead" from TaskDetailPage but as "you" from WorkDefDetailPage,
   * so both count. Teammate comments (status, summaries) are left out.
   */
  comments?: Array<{ from: string; body: string; at: string }>;
}

/** Comment authors that are the human (see WorkDefPromptInput.comments). */
const HUMAN_COMMENT_AUTHORS = new Set(["lead", "you"]);

export function buildWorkDefPrompt(input: WorkDefPromptInput): string {
  const { workDef, story, state, persona, comments } = input;
  const directory = workDef.directory || story?.directory;
  let out = "";

  // 1. State persona (board work only) — who the worker is *in this state*.
  //    First, because it frames how everything after it should be approached.
  if (state) {
    out += `## Your Role: ${state}\n\n`;
    out += persona
      ? `${normalizeInstructionMarkdown(persona, 3)}\n\n`
      : `You are working in the '${state}' state of this story's workflow.\n\n`;
  }

  // 2. Story (board work only) — the bigger picture.
  if (story) {
    out += `## Story: ${story.title}\n\n${story.description}\n\n`;
  }

  // 3. Working directory — the WorkDef (or its story) declares where the work
  //    happens; the agent cds there and picks up that repo's conventions (pi
  //    only auto-loads project context from its startup cwd; see docs/DESIGN.md "The Work Model").
  if (directory) {
    out += `## Working Directory\n\nWork in \`${directory}\`. Change to that directory before starting. `;
    out += `If it contains an AGENTS.md (or CLAUDE.md), read it first and follow its instructions while working there.\n\n`;
  }

  // 4. The work itself.
  out += `## Task: ${workDef.title}\n\n`;
  out += `## Goal\n\n${workDef.goal.trim()}\n\n`;
  if (workDef.acceptanceCriteria.trim()) {
    out += `## Acceptance Criteria\n\n${workDef.acceptanceCriteria.trim()}\n\n`;
  }
  if (workDef.additionalContext && workDef.additionalContext.trim()) {
    out += `## Additional Context\n\n${normalizeInstructionMarkdown(workDef.additionalContext, 3)}\n\n`;
  }

  // 5. Lead comments (feedback / rework context).
  const leadComments = (comments || []).filter((c) => HUMAN_COMMENT_AUTHORS.has(c.from));
  if (leadComments.length > 0) {
    const bodies = leadComments.map((c) => `> ${c.body}`).join("\n\n");
    out += `## Comments from Team Lead\n\n${bodies}\n\n`;
  }

  // 6. Completion guidance — workers never move work; finishing IS the signal.
  out += `## Completing This Work\n\n`;
  out += `Do only this work. When you finish, end with a concise summary of what you accomplished`;
  out += state ? ` — the task then advances automatically. ` : `. `;
  out += `Do not pick up other work. If you cannot make progress, post a comment explaining what you need `;
  out += `and mark this work item failed.\n`;

  return out.trimEnd() + "\n";
}

// (Prompt input types are defined above, next to buildWorkDefPrompt.)

// ─── Auto triage (TODO.md "Auto Triage") ─────────────────────────────

/** The built-in triage instructions (`builtin:triage`), re-exported from daemon/personas/builtins.ts. */
export { DEFAULT_TRIAGE_INSTRUCTIONS };

/** What every triage prompt carries besides its subject. */
interface TriagePromptCommon {
  /** The team's triage persona body, or the built-in default (`builtin:triage`) when absent. */
  instructions?: string;
  /** Open stories (id + title), so a proposal can attach a task to one. */
  stories?: Array<{ id: string; title: string }>;
  /** Earlier analyses of this subject (its triage WorkDef's thread). */
  priorComments?: Array<{ from: string; body: string; at: string }>;
  /**
   * One line per earlier proposal and what the author did with it
   * (Store.triageDecisionSummary), so a rejected idea isn't proposed again.
   */
  priorDecisions?: string[];
}

export interface TriagePromptInput extends TriagePromptCommon {
  /** The note, as it reads right now. */
  note: { id: string; content: string; updatedAt?: string };
  /** The note's group name, if it's in one — light context, like a label. */
  groupName?: string;
}

/**
 * A triage-mode external item (docs/DESIGN.md "External sources" — "Triage
 * mode"): its mirrored WorkDef's *current* content, which the source's sync keeps.
 */
export interface ExternalTriagePromptInput extends TriagePromptCommon {
  item: {
    /** The mirrored WorkDef's id. */
    id: string;
    /** The source's display name ("SIM-T"). */
    sourceLabel: string;
    /** The source's own id for the item. */
    externalId: string;
    title: string;
    goal: string;
    acceptanceCriteria?: string;
    additionalContext?: string;
    url?: string;
  };
}

/**
 * How the shared triage prompt names its subject. The note's wording is the
 * original, so a note's prompt reads exactly as it always has.
 */
interface TriageSubject {
  /** The `## …` heading over the subject's content. */
  heading: string;
  /** The subject's content, already rendered as markdown (may be empty). */
  content: string;
  /** Any framing between the instructions and the subject (external items only). */
  preamble?: string;
  /** "note" / "item" — in "Earlier Analysis of This …". */
  noun: string;
  /** Why there's a new round: the subject changed since the last analysis. */
  changedSince: string;
  /** "Don't repeat an idea … unless <this> changes it." */
  edit: string;
  /** "Don't re-propose something they rejected unless <this> changes it." */
  changeName: string;
  /** The last line's "don't change the …" clause. */
  dontChange: string;
}

/**
 * The prompt for one triage run of a note. Deliberately *not* `buildWorkDefPrompt`:
 * there's no goal, no acceptance criteria, and the work is "read this and tell me",
 * so borrowing that shape would mean faking authored fields the WorkDef doesn't have.
 */
export function buildTriagePrompt(input: TriagePromptInput): string {
  const { note, groupName } = input;
  return renderTriagePrompt({
    heading: `The Note (\`${note.id}\`${groupName ? `, in group “${groupName}”` : ""})`,
    content: note.content.trim(),
    noun: "note",
    changedSince: "You (or another teammate) already looked at this note; the author has since edited it. ",
    edit: "the edit",
    changeName: "the note's edit",
    dontChange: "don't change the note — the author answers you by editing it.",
  }, input);
}

/**
 * The prompt for one triage run of a triage-mode external item: the same shape as
 * a note's, with the item's current title, goal, criteria, context, and link as
 * the subject. The item is read-only here (pull only), so its next round comes
 * when it changes in the external system.
 */
export function buildExternalTriagePrompt(input: ExternalTriagePromptInput): string {
  const { item } = input;
  let content = `### ${item.title.trim()}\n\n`;
  if (item.url) content += `Link: ${item.url}\n\n`;
  if (item.goal.trim()) content += `${normalizeInstructionMarkdown(item.goal.trim(), 4)}\n\n`;
  if (item.acceptanceCriteria?.trim()) {
    content += `#### Acceptance Criteria\n\n${normalizeInstructionMarkdown(item.acceptanceCriteria.trim(), 5)}\n\n`;
  }
  if (item.additionalContext?.trim()) {
    content += `#### Additional Context\n\n${normalizeInstructionMarkdown(item.additionalContext.trim(), 5)}\n\n`;
  }
  return renderTriagePrompt({
    heading: `The Item (\`${item.externalId}\` from ${item.sourceLabel})`,
    content: content.trim(),
    preamble:
      `This is an item from ${item.sourceLabel}, not a note: wherever the instructions above say "note", ` +
      `read "this item". Don't work the item itself — triage it into proposed work.`,
    noun: "item",
    changedSince: `You (or another teammate) already looked at this item; it has since changed in ${item.sourceLabel}. `,
    edit: "the update",
    changeName: "the item's update",
    dontChange: `don't change the item — it's read-only here; it changes in ${item.sourceLabel}, and each change is a new round.`,
  }, input);
}

/** The shared body of every triage prompt (see `TriageSubject`). */
function renderTriagePrompt(subject: TriageSubject, common: TriagePromptCommon): string {
  const { instructions, stories, priorComments, priorDecisions } = common;
  let out = "## Your Role: Triage\n\n";
  out += `${normalizeInstructionMarkdown((instructions ?? DEFAULT_TRIAGE_INSTRUCTIONS).trim(), 3)}\n\n`;
  if (subject.preamble) out += `${subject.preamble}\n\n`;

  out += `## ${subject.heading}\n\n`;
  out += subject.content ? `${normalizeInstructionMarkdown(subject.content, 3)}\n\n` : "_(empty)_\n\n";

  // Open stories, so "add a task to story X" is a proposal it can actually make.
  if (stories && stories.length > 0) {
    out += `## Open Stories\n\nA proposal may add a task to one of these (use its id):\n\n`;
    for (const s of stories) out += `- \`${s.id}\` — ${s.title}\n`;
    out += "\n";
  }

  // Earlier rounds: the subject has been triaged before and then changed.
  if (priorComments && priorComments.length > 0) {
    const noun = subject.noun.charAt(0).toUpperCase() + subject.noun.slice(1);
    out += `## Earlier Analysis of This ${noun}\n\n`;
    out += subject.changedSince;
    out += `Don't repeat an idea they've already seen unless ${subject.edit} changes it.\n\n`;
    for (const c of priorComments) out += `> **${c.from}** (${c.at}):\n>\n${c.body.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
  }

  // What the author already decided: the strongest signal about what they want.
  if (priorDecisions && priorDecisions.length > 0) {
    out += `## What the Author Did With Earlier Proposals\n\n`;
    for (const line of priorDecisions) out += `- ${line}\n`;
    out += `\nDon't re-propose something they rejected unless ${subject.changeName} changes it.\n\n`;
  }

  out += `## Finishing\n\n`;
  out += `Post your analysis with the \`propose_work\` tool — it takes your written analysis, an `;
  out += `\`outcome\` (\`proposals\`, \`nothing\`, or \`question\`), and the proposals themselves — then mark `;
  out += `this work item complete. Creating the work is the author's decision, not yours: propose it and stop. `;
  out += `Don't pick up other work, and ${subject.dontChange}\n`;
  return out.trimEnd() + "\n";
}
