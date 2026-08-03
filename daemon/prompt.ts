/**
 * daemon/prompt.ts — Assembles the full task prompt: the message an agent
 * receives when it claims a task.
 *
 * This lives in the daemon (not the harness) so every adapter — pi-pizza-team,
 * mpt-mcp-server, future wrappers — delivers one identical, canonical prompt
 * verbatim. Keeping it here also means prompt wording/order changes in a single,
 * testable place instead of drifting across harnesses.
 *
 * Section order: state persona (role framing, board work only) → Story (board
 * work only) → working directory instruction → Goal → Acceptance Criteria →
 * Additional Context → reference context → lead comments → completion guidance.
 *
 * There are no transition instructions: workers never move work (see
 * docs/WORK-MODEL.md) — completing the work advances its story task
 * mechanically (or, for standalone work, just records the outcome).
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
 * WorkDef's parent is a story (see docs/WORKDEF_UNIFICATION.md). */
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
  //    only auto-loads project context from its startup cwd; see WORK-MODEL.md).
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
