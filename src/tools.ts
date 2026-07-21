// LLM-callable tools for the pi-pizza-team extension
//
// All tools communicate with the daemon HTTP API via DaemonClient.
// No local store or filesystem access (except reading files for upload).
//
// Three registration functions for role-specific tool sets:
//   - registerLeaderTools: create_story, edit_story, add_task, list_workflows,
//                          list_context, queue_request, team_status
//   - registerTeammateTools: upload_attachment
//   - registerAssistantTools: send_message, create_story, edit_story, add_task,
//                             list_workflows, list_context, queue_request,
//                             read_scratchpad
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
 * Includes file upload for task attachments and return_task (the escape hatch
 * for work the agent cannot complete; see the daemon's WORK-MODEL.md).
 */
export function registerTeammateTools(
  pi: ExtensionAPI,
  client: DaemonClient,
  getCurrentTaskId: () => string | null,
  onTaskReturned?: (taskId: string) => void
): void {
  registerUploadAttachment(pi, client, getCurrentTaskId);
  registerReturnTask(pi, client, getCurrentTaskId, onTaskReturned);
}

// ─── return_task (teammate escape hatch) ──────────────────────────────

/**
 * The teammate's "I can't do this" protocol action: puts the claimed task back
 * to `ready` with an explanatory comment, instead of finishing (which would
 * advance it) or silently stalling. A human/leader resolves the blocker.
 */
function registerReturnTask(
  pi: ExtensionAPI,
  client: DaemonClient,
  getCurrentTaskId: () => string | null,
  onTaskReturned?: (taskId: string) => void
): void {
  pi.registerTool({
    name: "return_task",
    label: "Return Task",
    description:
      "Return your current task to the queue because you cannot make progress (missing information, blocked on " +
      "access, prerequisites not met). The task goes back to 'ready' with your comment so a human can resolve the " +
      "blocker. Do NOT use this for finished work — just end your turn with a summary instead.",
    promptSnippet: "Return the current task to the queue",
    promptGuidelines: [
      "Use return_task only when you genuinely cannot proceed; explain exactly what you need in the comment.",
      "Never use return_task for completed work — finishing your turn signals completion.",
    ],
    parameters: Type.Object({
      comment: Type.String({ description: "What is blocking you and what you need to proceed (shown to the team)" }),
    }),
    async execute(_toolCallId, params) {
      const taskId = getCurrentTaskId();
      if (!taskId) {
        return { content: [{ type: "text", text: "No task is currently claimed — nothing to return." }] };
      }
      try {
        const res = await client.returnTask(taskId, (params as { comment: string }).comment);
        if (!res.success) {
          return { content: [{ type: "text", text: `Failed to return task: ${res.error || "unknown error"}` }] };
        }
        onTaskReturned?.(taskId);
        return { content: [{ type: "text", text: `Task ${taskId} returned to the queue with your comment. Stop working on it.` }] };
      } catch {
        return { content: [{ type: "text", text: "Failed to return task (daemon unreachable)." }] };
      }
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ASSISTANT TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the assistant role.
 * Includes story/task management and the assistant queue.
 */
export function registerAssistantTools(
  pi: ExtensionAPI,
  client: DaemonClient,
  getActiveTurnId: () => string | null
): void {
  registerSendMessage(pi, client, getActiveTurnId);
  registerCreateStory(pi, client);
  registerEditStory(pi, client);
  registerAddTask(pi, client);
  registerListWorkflows(pi, client);
  registerListContext(pi, client);
  registerQueueRequest(pi, client);
  registerReadScratchpad(pi, client);
}

// ─── send_message (assistant chat bubbles) ────────────────────────────

/**
 * The assistant's primary output: send one chat bubble to the user. Call it
 * multiple times per turn to deliver a batched, iMessage-style reply. Bubbles
 * are appended to the active response turn (resolved via getActiveTurnId) and
 * show up in the web UI progressively as the turn runs. See the daemon's
 * ASSISTANT_CHAT_FRAMING for the batching guidance the assistant follows.
 */
function registerSendMessage(
  pi: ExtensionAPI,
  client: DaemonClient,
  getActiveTurnId: () => string | null
): void {
  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send one chat message (a single bubble) to the user in the live chat. This is how you reply — the user only " +
      "sees content sent via this tool, not your final response text. Call it several times in a row to send several " +
      "short bubbles instead of one long message, like texting.",
    promptSnippet: "Send a chat message to the user",
    promptGuidelines: [
      "Reply to the user by calling send_message, one call per chat bubble.",
      "Prefer several short bubbles over one long one: lead with a headline, then one point per bubble, and put any question in its own final bubble.",
      "Do not rely on your final response text — only send_message content reaches the user.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "The message text for this single chat bubble (markdown allowed). Keep it short." }),
    }),
    async execute(_toolCallId, params) {
      const turnId = getActiveTurnId();
      if (!turnId) {
        return { content: [{ type: "text", text: "No active chat turn — cannot send a message right now." }] };
      }
      try {
        const res = await client.sayAssistantMessage(turnId, (params as { content: string }).content);
        if (!res.success) {
          return { content: [{ type: "text", text: `Failed to send message: ${res.error || "unknown error"}` }] };
        }
        return { content: [{ type: "text", text: "Sent." }] };
      } catch {
        return { content: [{ type: "text", text: "Failed to send message (daemon unreachable)." }] };
      }
    },
  });
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
      directory: Type.Optional(Type.String({ description: "Where the work happens (e.g., '~/Workspace/my-project'). Teammates cd here and read its AGENTS.md before starting." })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Required capabilities — `name` for presence-only, `name:value` for an exact value (e.g., ['python','java:8'])" })),
      paused: Type.Optional(Type.Boolean({ description: "If true, the story's tasks are not handed out until unpaused" })),
      workflow: Type.Optional(Type.String({ description: "Named workflow to use for this story (defaults to the team's default). Use list_workflows to see valid names." })),
      context: Type.Optional(Type.Array(Type.String(), { description: "Context-library entry ids to attach to the whole story (injected into every task's prompt). Use list_context to find ids." })),
    }),
    async execute(_toolCallId, params) {
      const requirements = buildRequirements(params.skills);
      const result = await client.createStory({
        id: params.id,
        title: params.title,
        description: params.description,
        dependsOn: params.dependsOn,
        requirements: Object.keys(requirements).length > 0 ? requirements : undefined,
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

/** Build a story requirements map from skill entries: `name` = presence-only (null), `name:value` = exact-value. */
function buildRequirements(skills?: string[]): Record<string, string | null> {
  const requirements: Record<string, string | null> = {};
  for (const entry of skills || []) {
    const i = entry.indexOf(":");
    if (i > 0) {
      const name = entry.slice(0, i).trim();
      const value = entry.slice(i + 1).trim();
      if (name) requirements[name] = value || null;
    } else if (entry.trim()) {
      requirements[entry.trim()] = null;
    }
  }
  return requirements;
}

// ─── edit_story ──────────────────────────────────────────────────────

function registerEditStory(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "edit_story",
    label: "Edit Story",
    description:
      "Edit an existing story on the pi-pizza-team kanban board. Can update title, description, status, " +
      "dependencies, required directory/skills, paused state, and workflow.",
    promptSnippet: "Edit an existing story on the pi-pizza-team board",
    promptGuidelines: [
      "Use edit_story to modify existing stories.",
      "Only the fields you provide will be changed.",
      "Pass directory to set where the work happens (empty string to clear); skills replace the story's capability requirements.",
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story to edit" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done")], { description: "New status" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "New dependency list" })),
      directory: Type.Optional(Type.String({ description: "Where the work happens (empty string to clear). Teammates cd here." })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Required capabilities (replaces the existing set); `name` presence-only or `name:value` exact" })),
      paused: Type.Optional(Type.Boolean({ description: "Whether the story's tasks are withheld from agents" })),
      workflow: Type.Optional(Type.String({ description: "New workflow name (empty for default)" })),
    }),
    async execute(_toolCallId, params) {
      const { storyId, directory, skills, ...rest } = params;
      const updates: Record<string, unknown> = { ...rest };
      if (updates.workflow === "") updates.workflow = null;
      // Directory is plain story data; empty string clears it.
      if (directory !== undefined) updates.directory = directory || null;
      if (skills !== undefined) {
        const requirements = buildRequirements(skills);
        updates.requirements = Object.keys(requirements).length > 0 ? requirements : null;
      }

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
        content: [{ type: "text", text: `Queued request for assistant (id: ${result.item?.id}).` }],
        details: { itemId: result.item?.id },
      };
    },
  });
}

// ─── read_scratchpad ──────────────────────────────────────────

function registerReadScratchpad(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "read_scratchpad",
    label: "Read Scratch Pad",
    description: "Read the user's personal scratch pad: their todo list and free-form notes. Use this when the user asks you to look at their scratch pad, todos, or notes (e.g. to help plan their day).",
    promptSnippet: "Read the user's scratch pad (todos + notes)",
    promptGuidelines: [
      "Use read_scratchpad when the user references their scratch pad, todos, or notes.",
      "It's read-only — summarize or help act on what you find; you can't modify it.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      try {
        const { todos, notes } = await client.getScratchpad();
        const open = todos.filter((t) => t.status !== "done");
        const done = todos.filter((t) => t.status === "done");
        const fmt = (t: { item: string; created: string; completed: string }) => `- ${t.item}`;
        let text = "# Scratch Pad\n\n## Todos\n";
        text += open.length > 0 ? `\n### Open\n${open.map(fmt).join("\n")}\n` : "\n(no open todos)\n";
        if (done.length > 0) text += `\n### Done\n${done.map(fmt).join("\n")}\n`;
        text += `\n## Notes\n\n${notes.trim() || "(empty)"}\n`;
        return {
          content: [{ type: "text", text }],
          details: { openCount: open.length, doneCount: done.length },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to read the scratch pad (daemon unreachable)." }] };
      }
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
          `- ${w.name}${w.isDefault ? " (default)" : ""} — ${w.stateCount} states, ${w.transitionCount} transitions`
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
  getCurrentTaskId: () => string | null
): void {
  pi.registerTool({
    name: "upload_attachment",
    label: "Upload Attachment",
    description: "Upload a file as an attachment to a task. For large files (>10KB), write to disk first and pass filePath instead of content.",
    promptSnippet: "Upload a file to the current task",
    promptGuidelines: [
      "Use upload_attachment when transition instructions ask you to provide a diff or other file for review.",
      "For LARGE files (>10KB like diffs): write the file to disk first, then use the filePath parameter.",
      "For SMALL files: you can pass content directly as a string.",
      "You MUST provide either 'content' OR 'filePath' (not both).",
    ],
    parameters: Type.Object({
      filename: Type.String({ description: "Filename with extension (e.g. 'changes.diff')" }),
      content: Type.Optional(Type.String({ description: "File content as text (for small files <10KB)" })),
      filePath: Type.Optional(Type.String({ description: "Absolute path to a file on disk to upload" })),
      message: Type.Optional(Type.String({ description: "Optional message to post alongside the attachment" })),
      taskId: Type.Optional(Type.String({ description: "Task ID to attach to (defaults to current task)" })),
    }),
    async execute(_toolCallId, params) {
      const taskId = params.taskId || getCurrentTaskId();
      if (!taskId) return { content: [{ type: "text", text: "No task to attach file to. Specify a taskId parameter." }] };

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

      const uploadRes = await client.uploadAttachment(taskId, params.filename, fileContent);
      if (!uploadRes.success) throw new Error(uploadRes.error || "Upload failed");

      const msgBody = params.message || `Attached ${params.filename} for review.`;
      await client.postComment(taskId, msgBody, [{ name: params.filename, size: fileContent.length, type: uploadRes.type || "other" }]);

      return { content: [{ type: "text", text: `Uploaded ${params.filename} (${fileContent.length} bytes) and posted message.` }] };
    },
  });
}
