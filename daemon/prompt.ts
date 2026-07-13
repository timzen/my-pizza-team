/**
 * daemon/prompt.ts — Assembles the full task prompt: the message an agent
 * receives when it claims a task.
 *
 * This lives in the daemon (not the harness) so every adapter — pi-pizza-team,
 * mpt-mcp-server, future wrappers — delivers one identical, canonical prompt
 * verbatim. Keeping it here also means prompt wording/order changes in a single,
 * testable place instead of drifting across harnesses.
 *
 * Section order: Story → Task → prior-task context → lead comments →
 * State Context (guidance) → Instructions (leaving the previous state, then the
 * entered state — whose file already carries its exit criteria).
 *
 * Note: no session-specific framing (e.g. "ignore task IDs from earlier in this
 * conversation") lives here — that belongs to a stateful harness, not the
 * canonical prompt. Harnesses deliver this verbatim.
 */

export interface TaskPromptInput {
  /** The parent story (the bigger picture); omitted only if unavailable. */
  story?: { id: string; title: string; description: string };
  /** The task being worked. */
  task: { id: string; storyId: string; title: string; description: string };
  /** One-line guidance about the entered state and where release advances to. */
  guidance: string;
  /**
   * Raw transition instructions from the workflow ".md" files. `exit` = the
   * state being left (handoff/continuation details when coming from a previous
   * state); `enter` = the state being entered (how to do the work + its exit
   * criteria). Both are surfaced; `exit` is skipped when it would just repeat
   * `enter` (a re-claim that stays in the same state).
   */
  transition?: { fromState: string; toState: string; exit?: string; enter?: string };
  /** Results of earlier tasks in the story (execution order), if any. */
  previousResults?: string;
  /** Task comments; only lead comments are surfaced (rework/feedback). */
  comments?: Array<{ from: string; body: string; at: string }>;
}

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

/** Build the complete prompt an agent gets on claim. */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const { story, task, guidance, transition, previousResults, comments } = input;
  let out = "";

  // 1. Story — the bigger picture
  if (story) {
    out += `## Story: ${story.title}\n\n${story.description}\n\n---\n\n`;
  }

  // 2. Task — what to do (kept right next to the story)
  out += `## Task: ${task.title}\n**Task ID: ${task.id}** (Story: ${task.storyId})\n\n${task.description}\n\n---\n\n`;

  // 3. Context from previous tasks in the story
  if (previousResults) {
    out += `## Context from previous tasks\n\n${previousResults}\n\n---\n\n`;
  }

  // 4. Lead comments (feedback / rework context)
  const leadComments = (comments || []).filter((c) => c.from === "lead");
  if (leadComments.length > 0) {
    const bodies = leadComments.map((c) => `> ${c.body}`).join("\n\n");
    out += `## Comments from Team Lead\n\n${bodies}\n\n---\n\n`;
  }

  // 5. What to do now: state guidance + transition instructions (leaving the
  //    previous state, then entering the working state).
  out += `## State Context\n\n${guidance}\n\n`;
  if (transition) {
    const { fromState, toState, exit, enter } = transition;
    // Skip `exit` when it would just duplicate `enter` (re-claim into the same
    // state, where the file being left and entered are identical).
    const showExit = exit && fromState !== toState;
    if (showExit || enter) {
      out += `## Instructions\n\n`;
      if (showExit) out += `**On leaving "${fromState}":**\n\n${normalizeInstructionMarkdown(exit!)}\n\n`;
      if (enter) out += `**On entering "${toState}":**\n\n${normalizeInstructionMarkdown(enter)}\n\n`;
    }
  }
  out += `---\n\nWhen you're done, provide a brief summary of what you accomplished.`;

  return out;
}
