// LLM-callable tools for the pi-pizza-team extension
//
// All tools communicate with the daemon HTTP API via DaemonClient.
// No local store or filesystem access (except reading files for upload).
//
// Three registration functions for role-specific tool sets:
//   - registerLeaderTools: create_story, edit_story, add_task, list_workflows,
//                          list_context, queue_request, team_status
//   - registerTeammateTools: upload_attachment
//   - registerAssistantTools: create_story, edit_story, add_task,
//                             create_task, create_schedule, list_workflows,
//                             list_context, queue_request, list_thought_groups,
//                             list_thoughts, get_thought, create_thought,
//                             edit_thought, archive_thought, group_thoughts
//
// Note: story/task creation can attach context-library entries via the
// `context` parameter; list_context surfaces the available entry ids. The
// assistant persona system prompt itself is still vended by the daemon.

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DaemonClient } from "./client.js";

// ═══════════════════════════════════════════════════════════════════════
// LEADER TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the leader role.
 * Includes story/task management, assistant queue, and status.
 */
export function registerLeaderTools(pi: ExtensionAPI, client: DaemonClient): void {
  registerCreateStory(pi, client);
  registerEditStory(pi, client);
  registerAddTask(pi, client);
  registerListWorkflows(pi, client);
  registerListContext(pi, client);
  registerQueueRequest(pi, client);
  registerTeamStatus(pi, client);
}

// ═══════════════════════════════════════════════════════════════════════
// TEAMMATE TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the teammate role.
 * Includes file upload for attachments and the `fail` escape hatch. "Giving up"
 * is two primitives the agent composes: post a comment, then set the WorkItem
 * FAILED (the daemon bundles nothing).
 */
export function registerTeammateTools(
  pi: ExtensionAPI,
  client: DaemonClient,
  getCurrentWorkItemId: () => string | null,
  onWorkItemFailed?: (workItemId: string) => void
): void {
  registerUploadAttachment(pi, client, getCurrentWorkItemId);
  registerFailWorkItem(pi, client, getCurrentWorkItemId, onWorkItemFailed);
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
        return { content: [{ type: "text", text: "No work item is currently claimed — nothing to fail." }] };
      }
      try {
        await client.postComment(workItemId, `[failed] ${(params as { comment: string }).comment}`).catch(() => {});
        const res = await client.setWorkItemState(workItemId, "FAILED");
        if (!res.success) {
          return { content: [{ type: "text", text: `Failed to mark the work item failed: ${res.error || "unknown error"}` }] };
        }
        onWorkItemFailed?.(workItemId);
        return { content: [{ type: "text", text: `Work item ${workItemId} marked failed with your comment. Stop working on it.` }] };
      } catch {
        return { content: [{ type: "text", text: "Failed to mark the work item failed (daemon unreachable)." }] };
      }
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ASSISTANT TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the assistant role.
 *
 * There is deliberately no "send a message" tool: chat v2 mirrors the agent's
 * own prose into bubbles, so replying is just replying (see
 * my-pizza-team/docs/ASSISTANT_CHAT_V2.md §5.4). These tools are for *doing*
 * things — stories, tasks, schedules, thoughts, context.
 */
export function registerAssistantTools(pi: ExtensionAPI, client: DaemonClient): void {
  registerCreateStory(pi, client);
  registerEditStory(pi, client);
  registerAddTask(pi, client);
  registerCreateTask(pi, client);
  registerCreateSchedule(pi, client);
  registerListWorkflows(pi, client);
  registerListContext(pi, client);
  registerQueueRequest(pi, client);
  registerListThoughtGroups(pi, client);
  registerListThoughts(pi, client);
  registerGetThought(pi, client);
  registerCreateThought(pi, client);
  registerEditThought(pi, client);
  registerArchiveThought(pi, client);
  registerGroupThoughts(pi, client);
}

// ═══════════════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════

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
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Story ID slug (lowercase, hyphens, e.g., 'auth-refactor')" }),
      title: Type.String({ description: "Human-readable title for the story" }),
      description: Type.String({ description: "Full description of what this story accomplishes" }),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Array of story IDs this story depends on" })),
      directory: Type.Optional(Type.String({ description: "Where the work happens (e.g., '~/Workspace/my-project'). Teammates biased to this directory pick it up and cd here." })),
      paused: Type.Optional(Type.Boolean({ description: "If true, the story's tasks are not handed out until unpaused" })),
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
        paused: params.paused,
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
      "dependencies, working directory, paused state, and workflow.",
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
      paused: Type.Optional(Type.Boolean({ description: "Whether the story's tasks are withheld from agents" })),
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
      "Add a task to an existing story on the pi-pizza-team board. Tasks are executed sequentially within a story.",
    promptSnippet: "Add a task to a pi-pizza-team story",
    promptGuidelines: [
      "Use add_task when breaking a story into tasks or planning work.",
      "Call add_task multiple times to add multiple sequential tasks.",
      "The task description should be a complete prompt for autonomous execution.",
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story to add the task to" }),
      title: Type.String({ description: "Short title for the task" }),
      description: Type.String({ description: "Full task description/prompt for the teammate to execute" }),
      context: Type.Optional(Type.Array(Type.String(), { description: "Context-library entry ids to attach to this task (injected into its prompt). Use list_context to find ids." })),
    }),
    async execute(_toolCallId, params) {
      const result = await client.createTask(params.storyId, params.title, params.description, params.context);
      if (!result.success) throw new Error(result.error || "Failed to add task");

      return {
        content: [{ type: "text", text: `Added task "${params.title}" to story "${params.storyId}"` }],
        details: { storyId: params.storyId, taskId: result.task?.id },
      };
    },
  });
}

// ─── queue_request ───────────────────────────────────────────────────

function registerQueueRequest(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "queue_request",
    label: "Queue Assistant Request",
    description:
      "Queue a request for the pi-pizza-team assistant to process. The assistant can create stories, " +
      "add tasks, spawn teammates, curate the context library, or handle any operational request.",
    promptSnippet: "Queue a request for the team assistant",
    promptGuidelines: [
      "Use queue_request when you want to delegate operational work to the assistant.",
      "The assistant processes requests asynchronously — it will handle them in order.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Free-form request for the assistant to process" }),
    }),
    async execute(_toolCallId, params) {
      const result = await client.enqueueAssistantRequest(params.prompt);
      if (!result.success) throw new Error(result.error || "Failed to queue request");

      return {
        content: [{ type: "text", text: `Queued request for the assistant.` }],
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
      "finishes it, lands in the user's Inbox. Use this for a single unit of work that doesn't belong to a story " +
      "(e.g. turning a thought into an actionable task).",
    promptSnippet: "Create a standalone one-off task",
    promptGuidelines: [
      "Use create_task for a single actionable item; use create_story + add_task when work needs multiple sequential steps.",
      "Write goal as a complete prompt the teammate can execute autonomously; put concrete, checkable acceptance criteria in acceptanceCriteria.",
      "Pass directory when the work targets a specific repo/folder so a teammate biased there picks it up.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short title for the task" }),
      goal: Type.String({ description: "Full task description/prompt for autonomous execution" }),
      acceptanceCriteria: Type.Optional(Type.String({ description: "Checkable done criteria (markdown list; RFC-2119 MUST/SHOULD encouraged)" })),
      additionalContext: Type.Optional(Type.String({ description: "Any extra background the teammate should have" })),
      directory: Type.Optional(Type.String({ description: "Working directory the task targets (e.g. '~/Workspace/proj')" })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { title: string; goal: string; acceptanceCriteria?: string; additionalContext?: string; directory?: string };
      const res = await client.createWorkDef({ title: p.title, goal: p.goal, acceptanceCriteria: p.acceptanceCriteria, additionalContext: p.additionalContext, directory: p.directory });
      if (!res.success) throw new Error(res.error || "Failed to create task");
      return {
        content: [{ type: "text", text: `Created task "${p.title}" (${res.workDef?.id}) — enqueued; it'll appear in the Inbox when done.` }],
        details: { workDefId: res.workDef?.id },
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
      "user wants work to run on a schedule (e.g. 'every weekday at 9am, summarize my open thoughts').",
    promptSnippet: "Create a recurring scheduled job (cron)",
    promptGuidelines: [
      "Confirm the cadence with the user and translate it to a standard 5-field cron (MIN HOUR DOM MON DOW).",
      "goal is the prompt the teammate runs each time; keep it self-contained since each run starts fresh.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short title for the scheduled job" }),
      cron: Type.String({ description: "5-field cron expression, e.g. '0 9 * * 1-5' for weekdays at 9am" }),
      goal: Type.String({ description: "The prompt the teammate executes on each run" }),
      acceptanceCriteria: Type.Optional(Type.String({ description: "Checkable done criteria for each run" })),
      directory: Type.Optional(Type.String({ description: "Working directory the job targets" })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { title: string; cron: string; goal: string; acceptanceCriteria?: string; directory?: string };
      const res = await client.createWorkDef({ type: "Scheduled", title: p.title, cron: p.cron, goal: p.goal, acceptanceCriteria: p.acceptanceCriteria, directory: p.directory });
      if (!res.success) throw new Error(res.error || "Failed to create schedule");
      return {
        content: [{ type: "text", text: `Created scheduled job "${p.title}" on cron \`${p.cron}\`.` }],
        details: { workDefId: res.workDef?.id },
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
        if (groups.length === 0) return { content: [{ type: "text", text: "No thought groups." }] };
        return {
          content: [{ type: "text", text: `Thought groups:\n${groups.map((g) => `- ${g.title} (${g.id})`).join("\n")}` }],
          details: { groups },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to list thought groups (daemon unreachable)." }] };
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
        if (notes.length === 0) return { content: [{ type: "text", text: p.groupId ? "No notes in that group." : "No thoughts on the board." }] };
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
        return { content: [{ type: "text", text: "Failed to read thoughts (daemon unreachable)." }] };
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
        if (!res.success || !res.thought) return { content: [{ type: "text", text: `Thought "${id}" not found.` }] };
        const t = res.thought;
        return {
          content: [{ type: "text", text: `# ${t.id}${t.pinned ? " 📌" : ""}\nstatus: ${t.status}\n\n${t.content.trim() || "(empty)"}` }],
          details: { thought: t },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to read the thought (daemon unreachable)." }] };
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
          return { content: [{ type: "text", text: "No workflows found." }] };
        }
        const lines = workflows.map((w) =>
          `- ${w.name}${w.isDefault ? " (default)" : ""} — ${w.stateCount} states (${w.agentCount} agent, ${w.manualCount} manual)`
        );
        return {
          content: [{ type: "text", text: `Workflows:\n${lines.join("\n")}` }],
          details: { workflows },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to list workflows (daemon unreachable)." }] };
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
          return { content: [{ type: "text", text: "The context library is empty." }] };
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
        return { content: [{ type: "text", text: "Failed to list context entries (daemon unreachable)." }] };
      }
    },
  });
}

// ─── team_status ─────────────────────────────────────────────────────

function registerTeamStatus(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "team_status",
    label: "Team Status",
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

        let text = `🍕 Team Status\n\n`;
        text += `Stories: ${status.stories.open} open, ${status.stories.done} done (${status.stories.open + status.stories.done} total)\n`;
        text += `Tasks: ${status.tasks.total} total (${byStatus})\n`;
        text += `Team: ${status.members.total} members (${status.members.working} working, ${status.members.idle} idle)\n`;

        return {
          content: [{ type: "text", text }],
          details: { status },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to fetch team status (daemon unreachable)." }] };
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
      if (!workItemId) return { content: [{ type: "text", text: "No work item is currently claimed — nothing to attach to." }] };

      let fileContent: string;
      if (params.filePath) {
        if (!fs.existsSync(params.filePath)) {
          return { content: [{ type: "text", text: `File not found: ${params.filePath}` }] };
        }
        fileContent = fs.readFileSync(params.filePath, "utf-8");
      } else if (params.content) {
        fileContent = params.content;
      } else {
        return { content: [{ type: "text", text: "Provide either 'content' or 'filePath'." }] };
      }

      const uploadRes = await client.uploadAttachment(workItemId, params.filename, fileContent);
      if (!uploadRes.success) throw new Error(uploadRes.error || "Upload failed");

      const msgBody = params.message || `Attached ${params.filename} for review.`;
      await client.postComment(workItemId, msgBody, [{ name: params.filename, size: fileContent.length, type: uploadRes.type || "other" }]);

      return { content: [{ type: "text", text: `Uploaded ${params.filename} (${fileContent.length} bytes) and posted message.` }] };
    },
  });
}
