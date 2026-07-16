/**
 * daemon/prompt.ts — Assembles the full task prompt: the message an agent
 * receives when it claims a task.
 *
 * This lives in the daemon (not the harness) so every adapter — pi-pizza-team,
 * mpt-mcp-server, future wrappers — delivers one identical, canonical prompt
 * verbatim. Keeping it here also means prompt wording/order changes in a single,
 * testable place instead of drifting across harnesses.
 *
 * Section order: Story → Task → reference context → prior-task context →
 * lead comments → State Context (guidance) → Instructions (leaving the previous
 * state, then the entered state — whose file already carries its exit criteria).
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
  /**
   * Context-library entries attached to the story/task, resolved to their
   * bodies and deduped by the caller. Inlined verbatim so every harness gets
   * the same reference material (no Pi-specific skills/AGENTS.md needed).
   */
  contextEntries?: Array<{ title: string; content: string }>;
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
  const { story, task, guidance, transition, previousResults, comments, contextEntries } = input;
  let out = "";

  // Sections are delimited by their `##`/`###` headings alone — no `---` rules
  // (which would just add noise, and which we warn authors against in their
  // instruction files).

  // 1. Story — the bigger picture
  if (story) {
    out += `## Story: ${story.title}\n\n${story.description}\n\n`;
  }

  // 2. Task — what to do (kept right next to the story)
  out += `## Task: ${task.title}\n**Task ID: ${task.id}** (Story: ${task.storyId})\n\n${task.description}\n\n`;

  // 3. Reference context — attached context-library entries (story + task).
  //    Inlined so the teammate has the relevant conventions/context to hand.
  if (contextEntries && contextEntries.length > 0) {
    out += `## Reference Context\n\n`;
    for (const entry of contextEntries) {
      out += `### ${entry.title}\n\n${normalizeInstructionMarkdown(entry.content, 4)}\n\n`;
    }
  }

  // 4. Context from previous tasks in the story
  if (previousResults) {
    out += `## Context from previous tasks\n\n${previousResults}\n\n`;
  }

  // 5. Lead comments (feedback / rework context)
  const leadComments = (comments || []).filter((c) => c.from === "lead");
  if (leadComments.length > 0) {
    const bodies = leadComments.map((c) => `> ${c.body}`).join("\n\n");
    out += `## Comments from Team Lead\n\n${bodies}\n\n`;
  }

  // 6. What to do now: state guidance, with the transition instructions nested
  //    beneath it as `###` — they're the detail of the state being entered.
  out += `## State Context\n\n${guidance}\n\n`;
  if (transition) {
    const { fromState, toState, exit, enter } = transition;
    // Skip `exit` when it would just duplicate `enter` (re-claim into the same
    // state). Each block is a `###` section named by state (the guidance above
    // frames which is being left vs entered); file headings normalize to `####`+
    // so they nest cleanly beneath.
    const showExit = exit && fromState !== toState;
    if (showExit) out += `### Instructions: ${fromState}\n\n${normalizeInstructionMarkdown(exit!, 4)}\n\n`;
    if (enter) out += `### Instructions: ${toState}\n\n${normalizeInstructionMarkdown(enter, 4)}\n\n`;
  }

  return out.trimEnd() + "\n";
}
