/**
 * daemon/prompt.ts — Assembles the full task prompt: the message an agent
 * receives when it claims a task.
 *
 * This lives in the daemon (not the harness) so every adapter — pi-pizza-team,
 * mpt-mcp-server, future wrappers — delivers one identical, canonical prompt
 * verbatim. Keeping it here also means prompt wording/order changes in a single,
 * testable place instead of drifting across harnesses.
 *
 * Section order: state persona (role framing for the state being worked) →
 * Story → working directory instruction → Task → reference context →
 * prior-task context → lead comments → completion guidance.
 *
 * There are no transition instructions: workers never move tasks (see
 * docs/WORK-MODEL.md) — completing the work advances the task mechanically.
 */

export interface TaskPromptInput {
  /** The parent story (the bigger picture); omitted only if unavailable. */
  story?: { id: string; title: string; description: string; directory?: string };
  /** The task being worked. */
  task: { id: string; storyId: string; title: string; description: string };
  /** The state the task is being worked in. */
  state: string;
  /**
   * The state's persona (`workflows/<wf>/<state>.md`): role framing for
   * whoever works this state — reviewer, implementer, CR-writer, etc.
   */
  persona?: string;
  /**
   * Context-library entries attached to the story/task, resolved to their
   * bodies and deduped by the caller. Inlined verbatim so every harness gets
   * the same reference material.
   */
  contextEntries?: Array<{ title: string; content: string }>;
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
  const { story, task, state, persona, previousResults, comments, contextEntries } = input;
  let out = "";

  // 1. State persona — who the worker is *in this state*. First, because it
  //    frames how everything after it should be approached.
  out += `## Your Role: ${state}\n\n`;
  if (persona) {
    out += `${normalizeInstructionMarkdown(persona, 3)}\n\n`;
  } else {
    out += `You are working a task in the '${state}' state of its workflow.\n\n`;
  }

  // 2. Story — the bigger picture
  if (story) {
    out += `## Story: ${story.title}\n\n${story.description}\n\n`;
  }

  // 3. Working directory — the story declares where the work happens; the
  //    agent cds there and picks up that repo's conventions (pi only
  //    auto-loads project context from its startup cwd; see WORK-MODEL.md).
  if (story?.directory) {
    out += `## Working Directory\n\nWork in \`${story.directory}\`. Change to that directory before starting. `;
    out += `If it contains an AGENTS.md (or CLAUDE.md), read it first and follow its instructions while working there.\n\n`;
  }

  // 4. Task — what to do
  out += `## Task: ${task.title}\n**Task ID: ${task.id}** (Story: ${task.storyId})\n\n${task.description}\n\n`;

  // 5. Reference context — attached context-library entries (story + task).
  if (contextEntries && contextEntries.length > 0) {
    out += `## Reference Context\n\n`;
    for (const entry of contextEntries) {
      out += `### ${entry.title}\n\n${normalizeInstructionMarkdown(entry.content, 4)}\n\n`;
    }
  }

  // 6. Context from previous tasks in the story
  if (previousResults) {
    out += `## Context from previous tasks\n\n${previousResults}\n\n`;
  }

  // 7. Lead comments (feedback / rework context)
  const leadComments = (comments || []).filter((c) => c.from === "lead");
  if (leadComments.length > 0) {
    const bodies = leadComments.map((c) => `> ${c.body}`).join("\n\n");
    out += `## Comments from Team Lead\n\n${bodies}\n\n`;
  }

  // 8. Completion guidance — workers never move tasks; finishing IS the signal.
  out += `## Completing This Task\n\n`;
  out += `Do only this task's work. When you finish, end with a concise summary of what you accomplished — `;
  out += `it becomes the task's recorded result, and the task advances automatically. Do not move the task or `;
  out += `pick up other work. If you cannot make progress, return the task with a comment explaining what you need.\n`;

  return out.trimEnd() + "\n";
}
