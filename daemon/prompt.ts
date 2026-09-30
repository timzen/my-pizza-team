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
 * Additional Context → reference context → lead comments → completion guidance.
 *
 * There are no transition instructions: workers never move work (see
 * docs/DESIGN.md "The Work Model") — completing the work advances its story task
 * mechanically (or, for standalone work, just records the outcome).
 *
 * `buildTriagePrompt` is the auto-triage variant (TODO.md "Auto Triage"): a
 * Thought-parented WorkDef carries no authored goal, so its prompt is assembled
 * from the team's `triage.md` plus the note's *current* text.
 */

import type { WorkDef } from "../shared/types.ts";

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
   * The state's persona (`workflows/<wf>/<state>.md`): role framing for
   * whoever works this state — reviewer, implementer, CR-writer, etc.
   */
  persona?: string;
  /**
   * Context-library entries attached to the story/WorkDef, resolved to their
   * bodies and deduped by the caller. Inlined verbatim so every harness gets
   * the same reference material.
   */
  contextEntries?: Array<{ title: string; content: string }>;
  /** Comments on the ref; only lead comments are surfaced (rework/feedback). */
  comments?: Array<{ from: string; body: string; at: string }>;
}

export function buildWorkDefPrompt(input: WorkDefPromptInput): string {
  const { workDef, story, state, persona, comments, contextEntries } = input;
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

  // 5. Reference context — attached context-library entries (story + WorkDef).
  if (contextEntries && contextEntries.length > 0) {
    out += `## Reference Context\n\n`;
    for (const entry of contextEntries) {
      out += `### ${entry.title}\n\n${normalizeInstructionMarkdown(entry.content, 4)}\n\n`;
    }
  }

  // 6. Lead comments (feedback / rework context).
  const leadComments = (comments || []).filter((c) => c.from === "lead");
  if (leadComments.length > 0) {
    const bodies = leadComments.map((c) => `> ${c.body}`).join("\n\n");
    out += `## Comments from Team Lead\n\n${bodies}\n\n`;
  }

  // 7. Completion guidance — workers never move work; finishing IS the signal.
  out += `## Completing This Work\n\n`;
  out += `Do only this work. When you finish, end with a concise summary of what you accomplished`;
  out += state ? ` — the task then advances automatically. ` : `. `;
  out += `Do not pick up other work. If you cannot make progress, post a comment explaining what you need `;
  out += `and mark this work item failed.\n`;

  return out.trimEnd() + "\n";
}

// (Prompt input types are defined above, next to buildWorkDefPrompt.)

// ─── Auto triage (TODO.md "Auto Triage") ─────────────────────────────

/** The built-in triage instructions, used when the team has no `triage.md`. */
export const DEFAULT_TRIAGE_INSTRUCTIONS = `Read the note below and help the author decide what, if anything, should become work.

Lean toward **proposing work**: concrete tasks, a story with tasks, or a scheduled job.
Be specific — a proposal should read like something a teammate could pick up without
asking questions.

Three honest outcomes, in order of preference:

1. **Proposals** — the note describes something worth doing.
2. **A question** — you need one thing from the author before you can propose anything
   useful. Ask exactly one, and say what you'd propose for each likely answer.
3. **Nothing to do** — the note is a reference, a link dump, a journal entry, or
   already-done work. Say so plainly; inventing work from a shopping list is worse
   than saying there's none.

Do not edit the note, and do not create stories, tasks, or schedules yourself — the
author decides. Keep your analysis short: what you think this note is, then your
proposals.`;

export interface TriagePromptInput {
  /** The note, as it reads right now. */
  note: { id: string; content: string; updatedAt?: string };
  /** The note's group name, if it's in one — light context, like a label. */
  groupName?: string;
  /** The team's `triage.md`, or the built-in default when absent. */
  instructions?: string;
  /** Open stories (id + title), so a proposal can attach a task to one. */
  stories?: Array<{ id: string; title: string }>;
  /** Earlier analyses of this note (its triage WorkDef's thread). */
  priorComments?: Array<{ from: string; body: string; at: string }>;
  /**
   * One line per earlier proposal and what the author did with it
   * (Store.triageDecisionSummary), so a rejected idea isn't proposed again.
   */
  priorDecisions?: string[];
}

/**
 * The prompt for one triage run. Deliberately *not* `buildWorkDefPrompt`: there's
 * no goal, no acceptance criteria, and the work is "read this and tell me", so
 * borrowing that shape would mean faking authored fields the WorkDef doesn't have.
 */
export function buildTriagePrompt(input: TriagePromptInput): string {
  const { note, groupName, instructions, stories, priorComments, priorDecisions } = input;
  let out = "## Your Role: Triage\n\n";
  out += `${normalizeInstructionMarkdown((instructions ?? DEFAULT_TRIAGE_INSTRUCTIONS).trim(), 3)}\n\n`;

  out += `## The Note (\`${note.id}\`${groupName ? `, in group “${groupName}”` : ""})\n\n`;
  const content = note.content.trim();
  out += content ? `${normalizeInstructionMarkdown(content, 3)}\n\n` : "_(empty)_\n\n";

  // Open stories, so "add a task to story X" is a proposal it can actually make.
  if (stories && stories.length > 0) {
    out += `## Open Stories\n\nA proposal may add a task to one of these (use its id):\n\n`;
    for (const s of stories) out += `- \`${s.id}\` — ${s.title}\n`;
    out += "\n";
  }

  // Earlier rounds: the note has been triaged before and then edited.
  if (priorComments && priorComments.length > 0) {
    out += `## Earlier Analysis of This Note\n\n`;
    out += `You (or another teammate) already looked at this note; the author has since edited it. `;
    out += `Don't repeat an idea they've already seen unless the edit changes it.\n\n`;
    for (const c of priorComments) out += `> **${c.from}** (${c.at}):\n>\n${c.body.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
  }

  // What the author already decided: the strongest signal about what they want.
  if (priorDecisions && priorDecisions.length > 0) {
    out += `## What the Author Did With Earlier Proposals\n\n`;
    for (const line of priorDecisions) out += `- ${line}\n`;
    out += `\nDon't re-propose something they rejected unless the note's edit changes it.\n\n`;
  }

  out += `## Finishing\n\n`;
  out += `Post your analysis with the \`propose_work\` tool — it takes your written analysis, an `;
  out += `\`outcome\` (\`proposals\`, \`nothing\`, or \`question\`), and the proposals themselves — then mark `;
  out += `this work item complete. Creating the work is the author's decision, not yours: propose it and stop. `;
  out += `Don't pick up other work, and don't change the note — the author answers you by editing it.\n`;
  return out.trimEnd() + "\n";
}
