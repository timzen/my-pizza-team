// LLM-callable tools for the pi-pizza-team extension
//
// All tools communicate with the daemon HTTP API via DaemonClient.
// No local store or filesystem access (except reading files for upload).
//
// Two registration functions for role-specific tool sets:
//   - registerTeammateTools: upload_attachment, fail, propose_work
//   - registerLeaderTools: create_story, edit_story, add_task, create_task,
//                          create_schedule, set_schedule_pending, get_task,
//                          edit_task, activate_task,
//                          list_workflows, list_context,
//                          team_status, list_thought_groups, list_thoughts,
//                          get_thought, create_thought, edit_thought,
//                          archive_thought, group_thoughts
//
// Pending: add_task / create_task / create_schedule take `pending: true` so the
// assistant can write work for the user to review before anything runs; while
// pending, get_task / edit_task revise it, and activate_task (or the UI's
// Activate) releases it — after which its definition is locked (my-pizza-team
// docs/DESIGN.md "Pending: Write, Review, Activate"). A scheduled job's
// *Schedule* also has a reversible pending flag — set_schedule_pending pauses
// and resumes its cron (resuming at the next occurrence, no catch-up; my-pizza-team
// docs/DESIGN.md "Pending schedules: reversible, no catch-up").
//
// Feature toggles: every leader tool is registered, and features.ts keeps the
// ones owned by a switched-off kind (create_story, create_task, …) out of the
// active set. A tool called anyway gets the daemon's 403, which the client words
// as featureDisabledMessage; propose_work refuses proposals of a disabled kind.
//
// Note: story/task creation can attach context-library entries via the
// `context` parameter; list_context surfaces the available entry ids. The
// assistant persona system prompt itself is still vended by the daemon.

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DaemonClient, featureDisabledMessage, featuresFromStatus, type FeatureName, type WorkDefSummary } from "./runtime/client.js";
import { featureForProposalKind } from "./features.js";

// ═══════════════════════════════════════════════════════════════════════
// LEADER TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the leader — the agent you chat with.
 *
 * The leader answers the team chat (see chat.ts), so it gets the full planning
 * surface: stories, tasks, schedules, thoughts, context, and status. All of it is
 * registered regardless of the feature toggles; leader.ts narrows the active set
 * with `applyFeatureTools` (features.ts).
 *
 * There is deliberately no "send a message" tool (chat v2 mirrors the agent's own
 * prose into bubbles) and no `queue_request`: queueing a request used to hand work
 * to a separate assistant, but the leader IS that assistant now, so it would just
 * be posting a message to itself and then answering it.
 */
export function registerLeaderTools(pi: ExtensionAPI, client: DaemonClient): void {
  registerCreateStory(pi, client);
  registerEditStory(pi, client);
  registerAddTask(pi, client);
  registerCreateTask(pi, client);
  registerCreateSchedule(pi, client);
  registerSetSchedulePending(pi, client);
  registerGetTask(pi, client);
  registerEditTask(pi, client);
  registerActivateTask(pi, client);
  registerListWorkflows(pi, client);
  registerListContext(pi, client);
  registerTeamStatus(pi, client);
  registerListThoughtGroups(pi, client);
  registerListThoughts(pi, client);
  registerGetThought(pi, client);
  registerCreateThought(pi, client);
  registerEditThought(pi, client);
  registerArchiveThought(pi, client);
  registerGroupThoughts(pi, client);
}

// ═══════════════════════════════════════════════════════════════════════
// TEAMMATE TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the teammate role.
 * Includes file upload for attachments, the `fail` escape hatch, and `propose_work`
 * (the answer to an auto-triage item). "Giving up" is two primitives the agent
 * composes: post a comment, then set the WorkItem FAILED (the daemon bundles
 * nothing).
 */
export function registerTeammateTools(
  pi: ExtensionAPI,
  client: DaemonClient,
  getCurrentWorkItemId: () => string | null,
  onWorkItemFailed?: (workItemId: string) => void
): void {
  registerUploadAttachment(pi, client, getCurrentWorkItemId);
  registerFailWorkItem(pi, client, getCurrentWorkItemId, onWorkItemFailed);
  registerProposeWork(pi, client, getCurrentWorkItemId);
}

// ─── propose_work (the answer to an auto-triage item) ───────────

/**
 * How a teammate answers a triage work item: its reading of the note plus the work
 * it proposes, structured so the author can accept one with a click (my-pizza-team
 * docs/DESIGN.md "Auto Triage"). The author decides — this creates nothing.
 */
function registerProposeWork(
  pi: ExtensionAPI,
  client: DaemonClient,
  getCurrentWorkItemId: () => string | null,
): void {
  const proposal = Type.Object({
    id: Type.String({ description: 'Unique within this analysis, e.g. "p1"' }),
    kind: Type.Union([
      Type.Literal("task"), Type.Literal("story-task"), Type.Literal("story"), Type.Literal("schedule"),
    ], { description: "task = standalone; story-task = into an existing story; story = new story with tasks; schedule = recurring" }),
    title: Type.String(),
    goal: Type.Optional(Type.String({ description: "What to achieve. Required for every kind except story." })),
    acceptanceCriteria: Type.Optional(Type.String({ description: "MUST/SHOULD/MAY bullets" })),
    additionalContext: Type.Optional(Type.String()),
    directory: Type.Optional(Type.String({ description: "Where the work happens (repo path)" })),
    storyId: Type.Optional(Type.String({ description: "story-task: the existing story's id, from the Open Stories list" })),
    cron: Type.Optional(Type.String({ description: "schedule: 5-field cron, e.g. '0 9 * * 1-5'" })),
    description: Type.Optional(Type.String({ description: "story: the new story's description" })),
    tasks: Type.Optional(Type.Array(Type.Object({
      title: Type.String(),
      goal: Type.String(),
      acceptanceCriteria: Type.Optional(Type.String()),
    }), { description: "story: its tasks, in order (at least one)" })),
  });

  pi.registerTool({
    name: "propose_work",
    label: "Propose Work",
    description:
      "Answer an auto-triage work item: post your reading of the note plus any work you think should come out of it. " +
      "Use it once per triage item, then end your turn. It creates nothing — the author accepts, edits, or rejects " +
      "each proposal. Only valid while holding a triage item (one whose prompt shows 'Your Role: Triage').",
    promptSnippet: "Answer a triage item with an analysis and proposed work",
    promptGuidelines: [
      "Prefer concrete proposals a teammate could pick up without asking questions.",
      "outcome 'nothing' is a real answer for a reference note or a journal entry — don't invent work.",
      "outcome 'question' when one missing fact blocks a useful proposal; ask it in the body.",
      "Never create stories/tasks/schedules yourself for a triage item; propose them here instead.",
    ],
    parameters: Type.Object({
      body: Type.String({ description: "Your written analysis: what this note is, then your reasoning" }),
      outcome: Type.Union([Type.Literal("proposals"), Type.Literal("nothing"), Type.Literal("question")], {
        description: "proposals = there's work; nothing = nothing to create; question = you need something first",
      }),
      proposals: Type.Optional(Type.Array(proposal, { description: "Required (and only allowed) when outcome is 'proposals'" })),
    }),
    async execute(_toolCallId, params) {
      const workItemId = getCurrentWorkItemId();
      if (!workItemId) {
        return { content: [{ type: "text", text: "No work item is currently claimed — nothing to propose against." }], details: undefined };
      }
      const p = params as { body: string; outcome: "proposals" | "nothing" | "question"; proposals?: { kind?: string }[] };
      // A proposal of a switched-off kind could only ever be rejected, so refuse it
      // here with the fix. Unknown toggles (daemon too old / unreachable) pass.
      const disabled = await disabledProposalFeatures(client, p.proposals ?? []);
      if (disabled.length > 0) {
        const msgs = disabled.map((f) => featureDisabledMessage(f)).join("; ");
        return { content: [{ type: "text", text: `Not accepted: ${msgs}. Propose only kinds the team has on (or outcome "nothing"), then call propose_work again.` }], details: undefined };
      }
      try {
        const res = await client.proposeWork(workItemId, { body: p.body, outcome: p.outcome, proposals: p.proposals });
        if (!res.success) {
          // The daemon's validation message is written to be actionable.
          return { content: [{ type: "text", text: `Not accepted: ${res.error || "unknown error"}. Fix it and call propose_work again.` }], details: undefined };
        }
        const n = p.outcome === "proposals" ? (p.proposals?.length ?? 0) : 0;
        const what = p.outcome === "proposals" ? `${n} proposal${n === 1 ? "" : "s"}` : `outcome "${p.outcome}"`;
        return { content: [{ type: "text", text: `Posted your analysis with ${what}. The author decides from here — end your turn.` }], details: undefined };
      } catch {
        return { content: [{ type: "text", text: "Failed to post the analysis (daemon unreachable)." }], details: undefined };
      }
    },
  });
}

/** The switched-off features these proposals would create work in (none if unknown). */
async function disabledProposalFeatures(client: DaemonClient, proposals: { kind?: string }[]): Promise<FeatureName[]> {
  const needed = new Set(proposals.map((p) => featureForProposalKind(p.kind ?? "")).filter((f): f is FeatureName => f !== null));
  if (needed.size === 0) return [];
  let features;
  try {
    features = featuresFromStatus(await client.getStatus());
  } catch {
    return [];
  }
  return [...needed].filter((f) => !features[f]);
}

// ─── fail (teammate escape hatch) ──────────────────────────────

/**
 * The teammate's "I can't do this" action: post a comment explaining the blocker,
 * then set the current WorkItem FAILED. The task is left in place (stuck) for a
 * human to re-enqueue, move, or edit — the daemon never auto-recovers it.
 */
function registerFailWorkItem(
  pi: ExtensionAPI,
  client: DaemonClient,
  getCurrentWorkItemId: () => string | null,
  onWorkItemFailed?: (workItemId: string) => void
): void {
  pi.registerTool({
    name: "fail",
    label: "Fail Work Item",
    description:
      "Give up on your current work item because you cannot make progress (missing information, blocked on " +
      "access, prerequisites not met). Posts your comment and marks the item failed; the work is left for a human to " +
      "resolve. Do NOT use this for finished work — just end your turn with a summary instead.",
    promptSnippet: "Fail the current work item (cannot proceed)",
    promptGuidelines: [
      "Use fail only when you genuinely cannot proceed; explain exactly what you need in the comment.",
      "Never use fail for completed work — finishing your turn signals completion.",
    ],
    parameters: Type.Object({
      comment: Type.String({ description: "What is blocking you and what you need to proceed (shown to the team)" }),
    }),
    async execute(_toolCallId, params) {
      const workItemId = getCurrentWorkItemId();
      if (!workItemId) {
        return { content: [{ type: "text", text: "No work item is currently claimed — nothing to fail." }], details: undefined };
      }
      try {
        await client.postComment(workItemId, `[failed] ${(params as { comment: string }).comment}`).catch(() => {});
        const res = await client.setWorkItemState(workItemId, "FAILED");
        if (!res.success) {
          return { content: [{ type: "text", text: `Failed to mark the work item failed: ${res.error || "unknown error"}` }], details: undefined };
        }
        onWorkItemFailed?.(workItemId);
        return { content: [{ type: "text", text: `Work item ${workItemId} marked failed with your comment. Stop working on it.` }], details: undefined };
      } catch {
        return { content: [{ type: "text", text: "Failed to mark the work item failed (daemon unreachable)." }], details: undefined };
      }
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════

/** The optional `pending` parameter shared by every work-creating tool. */
const PENDING_PARAM = Type.Optional(Type.Boolean({
  description: "Save as PENDING for the user to review: nothing is dispatched until it is activated " +
    "(from the UI, or activate_task when the user asks). While pending you can revise it with edit_task. " +
    "Omit or false to activate immediately (an active definition is locked).",
}));

/** Guideline text shared by the creating tools: when to save as pending. */
const PENDING_GUIDELINE =
  "Pass pending: true when the user wants to review the work before it runs, when you're unsure the " +
  "spec is right, or when you've been asked to write tasks up rather than start them.";

// ─── create_story ────────────────────────────────────────────────────

function registerCreateStory(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "create_story",
    label: "Create Story",
    description:
      "Create a new story on the pi-pizza-team kanban board. Stories are high-level work items that contain " +
      "sequential tasks. Use this when planning work, breaking down a project, or when the user asks to create a story.",
    promptSnippet: "Create a new story on the pi-pizza-team board",
    promptGuidelines: [
      "Use create_story to create stories when the user discusses new features, epics, or work items for the team.",
      "After creating a story with create_story, use add_task to add tasks to it.",
      "Story IDs should be short slugs (lowercase, hyphens, e.g., 'auth-refactor').",
      "Pass pending: true when the story should wait (e.g. for a review or a decision) — nothing is handed out until it's activated with edit_story pending: false.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Story ID slug (lowercase, hyphens, e.g., 'auth-refactor')" }),
      title: Type.String({ description: "Human-readable title for the story" }),
      description: Type.String({ description: "Full description of what this story accomplishes" }),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Array of story IDs this story depends on" })),
      directory: Type.Optional(Type.String({ description: "Where the work happens (e.g., '~/Workspace/my-project'). Teammates biased to this directory pick it up and cd here." })),
      pending: Type.Optional(Type.Boolean({ description: "If true, the story is created pending: none of its tasks are handed out until it is activated (edit_story pending: false)" })),
      workflow: Type.Optional(Type.String({ description: "Named workflow to use for this story (defaults to the team's default). Use list_workflows to see valid names." })),
      context: Type.Optional(Type.Array(Type.String(), { description: "Context-library entry ids to attach to the whole story (injected into every task's prompt). Use list_context to find ids." })),
    }),
    async execute(_toolCallId, params) {
      const result = await client.createStory({
        id: params.id,
        title: params.title,
        description: params.description,
        dependsOn: params.dependsOn,
        directory: params.directory,
        pending: params.pending,
        workflow: params.workflow,
        context: params.context,
      });

      if (!result.success) throw new Error(result.error || "Failed to create story");

      return {
        content: [{ type: "text", text: `Created story "${params.title}" (${params.id}). Add tasks with add_task.` }],
        details: { storyId: params.id },
      };
    },
  });
}

/** (removed: capability/requirements matching — stories match by directory affinity now.) */

// ─── edit_story ──────────────────────────────────────────────────────

function registerEditStory(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "edit_story",
    label: "Edit Story",
    description:
      "Edit an existing story on the pi-pizza-team kanban board. Can update title, description, status, " +
      "dependencies, working directory, pending state, and workflow. A story is active or pending (reversible): " +
      "pending: true holds it (an in-flight task finishes, nothing new starts, stories depending on it wait); " +
      "pending: false activates it again.",
    promptSnippet: "Edit an existing story on the pi-pizza-team board",
    promptGuidelines: [
      "Use edit_story to modify existing stories.",
      "Only the fields you provide will be changed.",
      "Pass directory to set where the work happens (empty string to clear).",
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story to edit" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done")], { description: "New status" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "New dependency list" })),
      directory: Type.Optional(Type.String({ description: "Where the work happens (empty string to clear). Teammates cd here." })),
      pending: Type.Optional(Type.Boolean({ description: "true makes the story pending (nothing new is handed out); false activates it" })),
      workflow: Type.Optional(Type.String({ description: "New workflow name (empty for default)" })),
    }),
    async execute(_toolCallId, params) {
      const { storyId, directory, ...rest } = params;
      const updates: Record<string, unknown> = { ...rest };
      if (updates.workflow === "") updates.workflow = null;
      // Directory is plain story data; empty string clears it.
      if (directory !== undefined) updates.directory = directory || null;

      const result = await client.updateStory(storyId, updates);
      if (!result.success) throw new Error(result.error || "Failed to update story");

      const changed = Object.keys(updates).join(", ");
      return {
        content: [{ type: "text", text: `Updated story "${storyId}": changed ${changed}.` }],
        details: { storyId, updatedFields: Object.keys(updates) },
      };
    },
  });
}

// ─── add_task ────────────────────────────────────────────────────────

function registerAddTask(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "add_task",
    label: "Add Task",
    description:
      "Add a task to an existing story on the pi-pizza-team board. Tasks are executed sequentially within a story. " +
      "With pending: true the task is saved for review: it holds its place in the story (later tasks wait behind it) " +
      "and gets no work item until it is activated.",
    promptSnippet: "Add a task to a pi-pizza-team story (optionally as pending)",
    promptGuidelines: [
      "Use add_task when breaking a story into tasks or planning work.",
      "Call add_task multiple times to add multiple sequential tasks.",
      "The task description should be a complete prompt for autonomous execution.",
      PENDING_GUIDELINE,
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story to add the task to" }),
      title: Type.String({ description: "Short title for the task" }),
      description: Type.String({ description: "Full task description/prompt for the teammate to execute" }),
      context: Type.Optional(Type.Array(Type.String(), { description: "Context-library entry ids to attach to this task (injected into its prompt). Use list_context to find ids." })),
      pending: PENDING_PARAM,
    }),
    async execute(_toolCallId, params) {
      const result = await client.createTask(params.storyId, params.title, params.description, params.context, params.pending);
      if (!result.success) throw new Error(result.error || "Failed to add task");

      const suffix = params.pending ? ` as PENDING (${result.task?.id}) — it won't run until activated` : "";
      return {
        content: [{ type: "text", text: `Added task "${params.title}" to story "${params.storyId}"${suffix}` }],
        details: { storyId: params.storyId, taskId: result.task?.id, pending: params.pending === true },
      };
    },
  });
}

// ─── read_scratchpad ──────────────────────────────────────────

// ─── create_task (standalone Solitary work) ───────────────────────────

function registerCreateTask(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "create_task",
    label: "Create Task",
    description:
      "Create a standalone one-off task (a Solitary WorkDef). It is enqueued immediately and, when a teammate " +
      "finishes it, lands in the user's Inbox — unless pending: true, which saves it for the user to review and " +
      "activate first. Use this for a single unit of work that doesn't belong to a story " +
      "(e.g. turning a thought into an actionable task).",
    promptSnippet: "Create a standalone one-off task (optionally as pending)",
    promptGuidelines: [
      PENDING_GUIDELINE,
      "Use create_task for a single actionable item; use create_story + add_task (when available) when work needs multiple sequential steps.",
      "Write goal as a complete prompt the teammate can execute autonomously; put concrete, checkable acceptance criteria in acceptanceCriteria.",
      "Pass directory when the work targets a specific repo/folder so a teammate biased there picks it up.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short title for the task" }),
      goal: Type.String({ description: "Full task description/prompt for autonomous execution" }),
      acceptanceCriteria: Type.Optional(Type.String({ description: "Checkable done criteria (markdown list; RFC-2119 MUST/SHOULD encouraged)" })),
      additionalContext: Type.Optional(Type.String({ description: "Any extra background the teammate should have" })),
      directory: Type.Optional(Type.String({ description: "Working directory the task targets (e.g. '~/Workspace/proj')" })),
      pending: PENDING_PARAM,
    }),
    async execute(_toolCallId, params) {
      const p = params as { title: string; goal: string; acceptanceCriteria?: string; additionalContext?: string; directory?: string; pending?: boolean };
      const res = await client.createWorkDef({ title: p.title, goal: p.goal, acceptanceCriteria: p.acceptanceCriteria, additionalContext: p.additionalContext, directory: p.directory, pending: p.pending });
      if (!res.success) throw new Error(res.error || "Failed to create task");
      const text = p.pending
        ? `Created PENDING task "${p.title}" (${res.workDef?.id}) — not enqueued; it runs once activated.`
        : `Created task "${p.title}" (${res.workDef?.id}) — enqueued; it'll appear in the Inbox when done.`;
      return {
        content: [{ type: "text", text }],
        details: { workDefId: res.workDef?.id, pending: p.pending === true },
      };
    },
  });
}

// ─── create_schedule (recurring job) ──────────────────────────────────

function registerCreateSchedule(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "create_schedule",
    label: "Create Schedule",
    description:
      "Create a recurring scheduled job: a WorkDef that the daemon enqueues on a 5-field cron. Use this when the " +
      "user wants work to run on a schedule (e.g. 'every weekday at 9am, summarize my open thoughts'). " +
      "With pending: true the job never fires until the user activates it.",
    promptSnippet: "Create a recurring scheduled job (cron), optionally as pending",
    promptGuidelines: [
      PENDING_GUIDELINE,
      "Confirm the cadence with the user and translate it to a standard 5-field cron (MIN HOUR DOM MON DOW).",
      "goal is the prompt the teammate runs each time; keep it self-contained since each run starts fresh.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short title for the scheduled job" }),
      cron: Type.String({ description: "5-field cron expression, e.g. '0 9 * * 1-5' for weekdays at 9am" }),
      goal: Type.String({ description: "The prompt the teammate executes on each run" }),
      acceptanceCriteria: Type.Optional(Type.String({ description: "Checkable done criteria for each run" })),
      directory: Type.Optional(Type.String({ description: "Working directory the job targets" })),
      pending: PENDING_PARAM,
    }),
    async execute(_toolCallId, params) {
      const p = params as { title: string; cron: string; goal: string; acceptanceCriteria?: string; directory?: string; pending?: boolean };
      const res = await client.createWorkDef({ type: "Scheduled", title: p.title, cron: p.cron, goal: p.goal, acceptanceCriteria: p.acceptanceCriteria, directory: p.directory, pending: p.pending });
      if (!res.success) throw new Error(res.error || "Failed to create schedule");
      const suffix = p.pending ? " as PENDING — it won't fire until activated" : "";
      return {
        content: [{ type: "text", text: `Created scheduled job "${p.title}" (${res.workDef?.id}) on cron \`${p.cron}\`${suffix}.` }],
        details: { workDefId: res.workDef?.id, pending: p.pending === true },
      };
    },
  });
}

// ─── set_schedule_pending (reversible pause/resume) ───────────────────

function registerSetSchedulePending(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "set_schedule_pending",
    label: "Set Schedule Pending",
    description:
      "Pause or resume a scheduled job's cron. pending: true stops it firing; pending: false resumes it at its next " +
      "cron occurrence (runs missed while pending are not back-filled). Reversible, and separate from a task's " +
      "one-way pending: a job whose definition is still pending needs activate_task instead.",
    promptSnippet: "Pause (pending) or resume (active) a scheduled job's cron",
    promptGuidelines: [
      "Use set_schedule_pending when the user wants a recurring job to stop or start firing without deleting it.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The scheduled job's task / WorkDef id (or its Schedule id)" }),
      pending: Type.Boolean({ description: "true = pending (stop firing); false = active (resume at the next occurrence)" }),
    }),
    async execute(_toolCallId, params) {
      const p = params as { id: string; pending: boolean };
      // Accept the job's WorkDef id (what create_schedule returns) and map it to
      // its parent Schedule; anything else is taken as a Schedule id.
      let scheduleId = p.id;
      try {
        const res = await client.getWorkDef(p.id);
        if (res.workDef?.parent?.kind === "schedule") scheduleId = res.workDef.parent.id;
      } catch { /* not a WorkDef id — treat it as a Schedule id */ }
      const res = await client.setSchedulePending(scheduleId, p.pending);
      if (!res.success) throw new Error(res.error || "Failed to update schedule");
      const text = p.pending
        ? `Schedule "${scheduleId}" is now PENDING — it won't fire until activated.`
        : `Schedule "${scheduleId}" is active again; it resumes at its next cron occurrence (missed runs are not back-filled).`;
      return { content: [{ type: "text", text }], details: { scheduleId, pending: p.pending } };
    },
  });
}

// ─── get_task / edit_task / activate_task (pending) ──────────────────

/** Render a WorkDef as markdown for the model. */
function formatWorkDef(d: WorkDefSummary): string {
  const lines = [
    `# ${d.title} (${d.id})`,
    `Type: ${d.type}${d.parent ? ` (parent ${d.parent.kind} ${d.parent.id})` : ""} · ${d.pending ? "PENDING (editable)" : "active (locked)"}`,
  ];
  if (d.directory) lines.push(`Directory: ${d.directory}`);
  if (d.contextRefs && d.contextRefs.length > 0) lines.push(`Context: ${d.contextRefs.join(", ")}`);
  lines.push("", "## Goal", "", d.goal, "", "## Acceptance Criteria", "", d.acceptanceCriteria || "(none)");
  if (d.additionalContext) lines.push("", "## Additional Context", "", d.additionalContext);
  return lines.join("\n");
}

function registerGetTask(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "get_task",
    label: "Get Task",
    description:
      "Read a task's definition by id — a board task (e.g. 'auth-refactor-2'), a standalone task, or a scheduled " +
      "job — including whether it is still pending. Use it before edit_task to see what the user may have changed.",
    promptSnippet: "Read a task (board, standalone, or scheduled) and its pending status",
    promptGuidelines: [
      "Use get_task to review a pending task before revising or activating it.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The task / WorkDef id" }),
    }),
    async execute(_toolCallId, params) {
      const res = await client.getWorkDef(params.id);
      if (!res.workDef) throw new Error(res.error || `Task "${params.id}" not found`);
      return {
        content: [{ type: "text", text: formatWorkDef(res.workDef) }],
        details: { workDefId: res.workDef.id, pending: res.workDef.pending },
      };
    },
  });
}

function registerEditTask(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "edit_task",
    label: "Edit Pending Task",
    description:
      "Revise a PENDING task's definition (title, goal, acceptance criteria, additional context, directory). Only " +
      "pending tasks can be edited: once active a definition is locked, and the way to change what a teammate does " +
      "is a comment on its thread plus a re-run.",
    promptSnippet: "Edit a pending task's definition",
    promptGuidelines: [
      "Use edit_task to revise pending tasks you or the user wrote; only the fields you pass change.",
      "If edit_task says the task is active, don't retry — tell the user it's locked and suggest a comment + Run, or a new pending task.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The pending task / WorkDef id" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      goal: Type.Optional(Type.String({ description: "New goal (for a board task, its description)" })),
      acceptanceCriteria: Type.Optional(Type.String({ description: "New acceptance criteria" })),
      additionalContext: Type.Optional(Type.String({ description: "New additional context (empty string clears it)" })),
      directory: Type.Optional(Type.String({ description: "New working directory (empty string clears it)" })),
    }),
    async execute(_toolCallId, params) {
      const { id, additionalContext, directory, ...rest } = params;
      const updates: Parameters<DaemonClient["updateWorkDef"]>[1] = { ...rest };
      if (additionalContext !== undefined) updates.additionalContext = additionalContext || null;
      if (directory !== undefined) updates.directory = directory || null;
      const res = await client.updateWorkDef(id, updates);
      if (!res.success) throw new Error(res.error || "Failed to edit task");
      return {
        content: [{ type: "text", text: `Updated pending task "${id}": changed ${Object.keys(updates).join(", ") || "nothing"}.` }],
        details: { workDefId: id, updatedFields: Object.keys(updates) },
      };
    },
  });
}

function registerActivateTask(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "activate_task",
    label: "Activate Pending Task",
    description:
      "Activate a PENDING task: its definition is locked and the daemon may now dispatch it (a standalone task is " +
      "enqueued now, a board task when its story reaches it, a scheduled job on its next cron firing).",
    promptSnippet: "Activate a pending task so it can run",
    promptGuidelines: [
      "Only use activate_task when the user explicitly asks you to activate — pending tasks exist so the user can review first.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The pending task / WorkDef id" }),
    }),
    async execute(_toolCallId, params) {
      const res = await client.activateWorkDef(params.id);
      if (!res.success) throw new Error(res.error || "Failed to activate task");
      const queued = res.workItemId ? " and enqueued it" : "";
      return {
        content: [{ type: "text", text: `Activated "${params.id}"${queued}. Its definition is now locked.` }],
        details: { workDefId: params.id, workItemId: res.workItemId ?? null },
      };
    },
  });
}

// ─── Thoughts (read the user's sticky-note workspace) ─────────────────

function registerListThoughtGroups(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "list_thought_groups",
    label: "List Thought Groups",
    description:
      "List the groups on the user's Thoughts board (their sticky-note workspace). Use this to resolve a group the " +
      "user names (e.g. 'the Q3 group') to its id before reading its notes with list_thoughts.",
    promptSnippet: "List the user's thought groups",
    promptGuidelines: [
      "Use list_thought_groups when the user refers to a group by name so you can find its id.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const { groups } = await client.listThoughts();
        if (groups.length === 0) return { content: [{ type: "text", text: "No thought groups." }], details: undefined };
        return {
          content: [{ type: "text", text: `Thought groups:\n${groups.map((g) => `- ${g.title} (${g.id})`).join("\n")}` }],
          details: { groups },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to list thought groups (daemon unreachable)." }], details: undefined };
      }
    },
  });
}

function registerListThoughts(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "list_thoughts",
    label: "List Thoughts",
    description:
      "Read the user's Thoughts board: their markdown sticky notes. Optionally filter to one group (groupId) to read " +
      "just that cluster. This is the assistant's window into the user's captured ideas — read them to help turn them " +
      "into work (a story/task/schedule). Read-only.",
    promptSnippet: "Read the user's thoughts (optionally by group)",
    promptGuidelines: [
      "When the user says 'look at the thoughts in group X and help me create a task', resolve X with list_thought_groups, then list_thoughts with that groupId, then propose the work.",
      "It's read-only. Don't invent notes; work from what's there. Note ids let you cite specifics with get_thought.",
    ],
    parameters: Type.Object({
      groupId: Type.Optional(Type.String({ description: "Only return notes in this group (from list_thought_groups)" })),
      includeArchived: Type.Optional(Type.Boolean({ description: "Include archived notes (default false)" })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { groupId?: string; includeArchived?: boolean };
      try {
        const { thoughts, groups } = await client.listThoughts(p.includeArchived ? undefined : "active");
        let notes = thoughts;
        if (p.groupId) notes = notes.filter((t) => t.groupId === p.groupId);
        if (notes.length === 0) return { content: [{ type: "text", text: p.groupId ? "No notes in that group." : "No thoughts on the board." }], details: undefined };
        const titleOf = (id: string | null) => groups.find((g) => g.id === id)?.title;
        const fmt = (t: typeof notes[number]) => {
          const g = t.groupId ? ` [${titleOf(t.groupId) ?? t.groupId}]` : "";
          const pin = t.pinned ? " 📌" : "";
          return `### ${t.id}${g}${pin}\n${t.content.trim() || "(empty)"}`;
        };
        return {
          content: [{ type: "text", text: `${notes.length} thought(s):\n\n${notes.map(fmt).join("\n\n")}` }],
          details: { count: notes.length, ids: notes.map((t) => t.id) },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to read thoughts (daemon unreachable)." }], details: undefined };
      }
    },
  });
}

function registerGetThought(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "get_thought",
    label: "Get Thought",
    description: "Read one sticky note by id (from list_thoughts). Use when the user references a specific note or you need its full content.",
    promptSnippet: "Read one thought by id",
    promptGuidelines: ["Use get_thought to pull the full content of a specific note before acting on it."],
    parameters: Type.Object({
      id: Type.String({ description: "The thought id (e.g. 'th-1786...')" }),
    }),
    async execute(_toolCallId, params) {
      const id = (params as { id: string }).id;
      try {
        const res = await client.getThought(id);
        if (!res.success || !res.thought) return { content: [{ type: "text", text: `Thought "${id}" not found.` }], details: undefined };
        const t = res.thought;
        return {
          content: [{ type: "text", text: `# ${t.id}${t.pinned ? " 📌" : ""}\nstatus: ${t.status}\n\n${t.content.trim() || "(empty)"}` }],
          details: { thought: t },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to read the thought (daemon unreachable)." }], details: undefined };
      }
    },
  });
}

// ─── Thoughts: write (refine the board) ───────────────────────────────

function registerCreateThought(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "create_thought",
    label: "Create Thought",
    description:
      "Add a sticky note to the user's Thoughts board. Use this to capture a follow-up, a summary of what you did, " +
      "or a new idea worth keeping — e.g. after turning notes into tasks, drop a note recording what was created.",
    promptSnippet: "Add a note to the user's Thoughts board",
    promptGuidelines: [
      "Use create_thought to leave the user a durable note (a follow-up, a summary, an idea). Markdown is supported (incl. `- [ ]` checklists).",
      "Optionally pass groupId (from list_thought_groups) to file it into a group.",
      "Prefer create_task/create_story for actual work; use create_thought for notes/ideas, not executable tasks.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "The note's markdown content" }),
      color: Type.Optional(Type.String({ description: "Palette color: yellow|blue|green|pink|purple|orange" })),
      groupId: Type.Optional(Type.String({ description: "Group to file the note into (from list_thought_groups)" })),
      pinned: Type.Optional(Type.Boolean({ description: "Pin the note" })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { content: string; color?: string; groupId?: string; pinned?: boolean };
      const res = await client.createThought({ ...p, createdBy: "assistant" });
      if (!res.success) throw new Error(res.error || "Failed to create thought");
      return {
        content: [{ type: "text", text: `Added a note to the board (${res.thought?.id}).` }],
        details: { thoughtId: res.thought?.id },
      };
    },
  });
}

function registerEditThought(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "edit_thought",
    label: "Edit Thought",
    description:
      "Edit an existing note by id: replace its content, or append to it, and/or change color/pin/group. Use append " +
      "to annotate a note without discarding what's there (e.g. add '→ promoted to task X').",
    promptSnippet: "Edit or annotate a note on the board",
    promptGuidelines: [
      "Use `append` to add to a note; use `content` to replace it wholesale (only one is needed).",
      "Pass groupId to move it into a group, or ungroup: true to remove it from its group.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The note id (from list_thoughts)" }),
      content: Type.Optional(Type.String({ description: "Replace the note's content entirely" })),
      append: Type.Optional(Type.String({ description: "Append this text (added after a blank line)" })),
      color: Type.Optional(Type.String({ description: "Palette color" })),
      pinned: Type.Optional(Type.Boolean({ description: "Pin/unpin" })),
      groupId: Type.Optional(Type.String({ description: "Move into this group" })),
      ungroup: Type.Optional(Type.Boolean({ description: "Remove from its current group" })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { id: string; content?: string; append?: string; color?: string; pinned?: boolean; groupId?: string; ungroup?: boolean };
      const updates: { content?: string; color?: string; pinned?: boolean; groupId?: string | null } = {};
      if (p.content !== undefined) {
        updates.content = p.content;
      } else if (p.append) {
        const cur = await client.getThought(p.id);
        if (!cur.success || !cur.thought) throw new Error(`Thought "${p.id}" not found`);
        updates.content = `${cur.thought.content.trimEnd()}\n\n${p.append}`;
      }
      if (p.color !== undefined) updates.color = p.color;
      if (p.pinned !== undefined) updates.pinned = p.pinned;
      if (p.ungroup) updates.groupId = null;
      else if (p.groupId !== undefined) updates.groupId = p.groupId;
      const res = await client.updateThought(p.id, updates);
      if (!res.success) throw new Error(res.error || "Failed to edit thought");
      return { content: [{ type: "text", text: `Updated note ${p.id}.` }], details: { thoughtId: p.id } };
    },
  });
}

function registerArchiveThought(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "archive_thought",
    label: "Archive Thought",
    description:
      "Archive a note (move it off the active board; recoverable). Use this to clear a note you've acted on — e.g. " +
      "after promoting it to a task — so the board reflects what's still open.",
    promptSnippet: "Archive a note you've acted on",
    promptGuidelines: [
      "Archive a note only after you've captured its intent elsewhere (a task/story) or the user asked to clear it.",
      "Archiving is reversible; it is not deletion.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The note id to archive" }),
    }),
    async execute(_toolCallId, params) {
      const id = (params as { id: string }).id;
      const res = await client.archiveThought(id);
      if (!res.success) throw new Error(res.error || "Failed to archive thought");
      return { content: [{ type: "text", text: `Archived note ${id}.` }], details: { thoughtId: id } };
    },
  });
}

function registerGroupThoughts(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "group_thoughts",
    label: "Group Thoughts",
    description:
      "Create a named group on the board, optionally filing existing notes into it. Use this to help the user " +
      "organize related thoughts (e.g. 'group everything about Q3 planning').",
    promptSnippet: "Create a group and file notes into it",
    promptGuidelines: [
      "Pass memberIds (note ids from list_thoughts) to file them into the new group; membership is exclusive.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Group title" }),
      memberIds: Type.Optional(Type.Array(Type.String(), { description: "Note ids to file into the group" })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { title: string; memberIds?: string[] };
      const res = await client.createThoughtGroup(p);
      if (!res.success) throw new Error(res.error || "Failed to create group");
      return {
        content: [{ type: "text", text: `Created group "${p.title}"${p.memberIds?.length ? ` with ${p.memberIds.length} note(s)` : ""}.` }],
        details: { groupId: res.group?.id },
      };
    },
  });
}

// ─── list_workflows ──────────────────────────────────────────────────

function registerListWorkflows(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "list_workflows",
    label: "List Workflows",
    description:
      "List the team's workflows (state machines a story can use). Use this before create_story to pick a valid " +
      "workflow name — the daemon rejects unknown ones.",
    promptSnippet: "List the team's workflows",
    promptGuidelines: [
      "Use list_workflows when planning a story so you can choose and confirm the right workflow.",
      "Only pass a workflow name to create_story that appears in this list.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const workflows = await client.listWorkflows();
        if (workflows.length === 0) {
          return { content: [{ type: "text", text: "No workflows found." }], details: undefined };
        }
        const lines = workflows.map((w) =>
          `- ${w.name}${w.isDefault ? " (default)" : ""} — ${w.stateCount} states (${w.agentCount} agent, ${w.manualCount} manual)`
        );
        return {
          content: [{ type: "text", text: `Workflows:\n${lines.join("\n")}` }],
          details: { workflows },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to list workflows (daemon unreachable)." }], details: undefined };
      }
    },
  });
}

// ─── list_context ────────────────────────────────────────────────────

function registerListContext(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "list_context",
    label: "List Context Library",
    description:
      "List the shared context-library entries (reusable prompt/context material). Use this to decide which entries " +
      "to attach to a story or task via the `context` parameter of create_story/add_task.",
    promptSnippet: "List the shared context-library entries",
    promptGuidelines: [
      "Use list_context when deciding what background material would help a teammate succeed.",
      "Attach relevant entries by passing their ids to create_story (story-wide) or add_task (task-only).",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const { entries } = await client.listContext();
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "The context library is empty." }], details: undefined };
        }
        const lines = entries.map((e) => {
          const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
          const desc = e.description ? ` — ${e.description}` : "";
          return `- ${e.id}: ${e.title}${tags}${desc}`;
        });
        return {
          content: [{ type: "text", text: `Context library:\n${lines.join("\n")}` }],
          details: { entries: entries.map((e) => ({ id: e.id, title: e.title, tags: e.tags })) },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to list context entries (daemon unreachable)." }], details: undefined };
      }
    },
  });
}

// ─── team_status ─────────────────────────────────────────────────────

function registerTeamStatus(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "team_status",
    label: "Team Status",
    description:
      "Get a snapshot of the team: how many stories are open or done, the task count by state, and how many " +
      "members are working versus idle. Use it for a quick overview before deciding what to pick up.",
    promptSnippet: "Check the current team status",
    promptGuidelines: [
      "Use team_status to get a quick overview of the team's progress.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const status = await client.getStatus();
        const byStatus = Object.entries(status.tasks.byStatus)
          .map(([s, n]) => `${n} ${s}`)
          .join(", ");

        const features = featuresFromStatus(status);
        const off = (Object.keys(features) as FeatureName[]).filter((f) => !features[f]);

        let text = `🍕 Team Status\n\n`;
        if (features.stories) {
          text += `Stories: ${status.stories.open} open, ${status.stories.done} done (${status.stories.open + status.stories.done} total)\n`;
        }
        text += `Tasks: ${status.tasks.total} total (${byStatus})\n`;
        text += `Team: ${status.members.total} members (${status.members.working} working, ${status.members.idle} idle)\n`;
        if (off.length > 0) text += `Turned off: ${off.join(", ")} (Config → General → Work items)\n`;

        return {
          content: [{ type: "text", text }],
          details: { status },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to fetch team status (daemon unreachable)." }], details: undefined };
      }
    },
  });
}

// ─── upload_attachment ───────────────────────────────────────────────

function registerUploadAttachment(
  pi: ExtensionAPI,
  client: DaemonClient,
  getCurrentWorkItemId: () => string | null
): void {
  pi.registerTool({
    name: "upload_attachment",
    label: "Upload Attachment",
    description: "Upload a file as an attachment to your current work item. For large files (>10KB), write to disk first and pass filePath instead of content.",
    promptSnippet: "Upload a file to the current work item",
    promptGuidelines: [
      "Use upload_attachment when the prompt asks you to provide a diff or other file for review.",
      "For LARGE files (>10KB like diffs): write the file to disk first, then use the filePath parameter.",
      "For SMALL files: you can pass content directly as a string.",
      "You MUST provide either 'content' OR 'filePath' (not both).",
    ],
    parameters: Type.Object({
      filename: Type.String({ description: "Filename with extension (e.g. 'changes.diff')" }),
      content: Type.Optional(Type.String({ description: "File content as text (for small files <10KB)" })),
      filePath: Type.Optional(Type.String({ description: "Absolute path to a file on disk to upload" })),
      message: Type.Optional(Type.String({ description: "Optional message to post alongside the attachment" })),
    }),
    async execute(_toolCallId, params) {
      const workItemId = getCurrentWorkItemId();
      if (!workItemId) return { content: [{ type: "text", text: "No work item is currently claimed — nothing to attach to." }], details: undefined };

      let fileContent: string;
      if (params.filePath) {
        if (!fs.existsSync(params.filePath)) {
          return { content: [{ type: "text", text: `File not found: ${params.filePath}` }], details: undefined };
        }
        fileContent = fs.readFileSync(params.filePath, "utf-8");
      } else if (params.content) {
        fileContent = params.content;
      } else {
        return { content: [{ type: "text", text: "Provide either 'content' or 'filePath'." }], details: undefined };
      }

      const uploadRes = await client.uploadAttachment(workItemId, params.filename, fileContent);
      if (!uploadRes.success) throw new Error(uploadRes.error || "Upload failed");

      const msgBody = params.message || `Attached ${params.filename} for review.`;
      await client.postComment(workItemId, msgBody, [{ name: params.filename, size: fileContent.length, type: uploadRes.type || "other" }]);

      return { content: [{ type: "text", text: `Uploaded ${params.filename} (${fileContent.length} bytes) and posted message.` }], details: undefined };
    },
  });
}
