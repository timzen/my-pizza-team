// LLM-callable tools for the pi-pizza-team extension
//
// All tools communicate with the daemon HTTP API via DaemonClient.
// No local store or filesystem access (except reading files for upload).
//
// Three registration functions for role-specific tool sets:
//   - registerLeaderTools: create_story, edit_story, add_task, queue_request,
//                          save_memory, search_memory, team_status
//   - registerTeammateTools: search_memory, upload_attachment
//   - registerAssistantTools: create_story, edit_story, add_task,
//                             save_memory, search_memory, queue_request

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DaemonClient } from "./client.js";

// ═══════════════════════════════════════════════════════════════════════
// LEADER TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the leader role.
 * Includes story/task management, assistant queue, memory, and status.
 */
export function registerLeaderTools(pi: ExtensionAPI, client: DaemonClient): void {
  registerCreateStory(pi, client);
  registerEditStory(pi, client);
  registerAddTask(pi, client);
  registerQueueRequest(pi, client);
  registerSaveMemory(pi, client);
  registerSearchMemory(pi, client);
  registerTeamStatus(pi, client);
}

// ═══════════════════════════════════════════════════════════════════════
// TEAMMATE TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the teammate role.
 * Includes memory search and file upload.
 */
export function registerTeammateTools(
  pi: ExtensionAPI,
  client: DaemonClient,
  getCurrentTaskId: () => string | null
): void {
  registerSearchMemory(pi, client);
  registerUploadAttachment(pi, client, getCurrentTaskId);
}

// ═══════════════════════════════════════════════════════════════════════
// ASSISTANT TOOLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register tools for the assistant role.
 * Includes story/task management, memory save/search, and queue.
 */
export function registerAssistantTools(
  pi: ExtensionAPI,
  client: DaemonClient,
  categories?: string[]
): void {
  registerCreateStory(pi, client);
  registerEditStory(pi, client);
  registerAddTask(pi, client);
  registerQueueRequest(pi, client);
  registerSaveMemory(pi, client, categories);
  registerSearchMemory(pi, client);
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
      directory: Type.Optional(Type.String({ description: "Required working directory — only agents in this dir will pick up the story (e.g., '~/Workspace/my-project')" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Required capabilities — only agents advertising all of these will pick up the story (e.g., ['python','docker'])" })),
      paused: Type.Optional(Type.Boolean({ description: "If true, the story's tasks are not handed out until unpaused" })),
      workflow: Type.Optional(Type.String({ description: "Named workflow to use for this story (defaults to the team's default)" })),
    }),
    async execute(_toolCallId, params) {
      const requirements = buildRequirements(params.directory, params.skills);
      const result = await client.createStory({
        id: params.id,
        title: params.title,
        description: params.description,
        dependsOn: params.dependsOn,
        requirements: Object.keys(requirements).length > 0 ? requirements : undefined,
        paused: params.paused,
        workflow: params.workflow,
      });

      if (!result.success) throw new Error(result.error || "Failed to create story");

      return {
        content: [{ type: "text", text: `Created story "${params.title}" (${params.id}). Add tasks with add_task.` }],
        details: { storyId: params.id },
      };
    },
  });
}

/** Build a story requirements map from a directory and a list of presence-only skills. */
function buildRequirements(directory?: string, skills?: string[]): Record<string, string | null> {
  const requirements: Record<string, string | null> = {};
  if (directory) requirements.directory = directory;
  for (const skill of skills || []) if (skill.trim()) requirements[skill.trim()] = null;
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
      "Provide directory and/or skills together to set the story's requirements; pass an empty directory and empty skills to clear them.",
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story to edit" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done")], { description: "New status" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "New dependency list" })),
      directory: Type.Optional(Type.String({ description: "Required working directory (empty string to clear)" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Required capabilities (replaces the existing set)" })),
      paused: Type.Optional(Type.Boolean({ description: "Whether the story's tasks are withheld from agents" })),
      workflow: Type.Optional(Type.String({ description: "New workflow name (empty for default)" })),
    }),
    async execute(_toolCallId, params) {
      const { storyId, directory, skills, ...rest } = params;
      const updates: Record<string, unknown> = { ...rest };
      if (updates.workflow === "") updates.workflow = null;
      // If either directory or skills was provided, (re)build the requirements map.
      if (directory !== undefined || skills !== undefined) {
        const requirements = buildRequirements(directory, skills);
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
    }),
    async execute(_toolCallId, params) {
      const result = await client.createTask(params.storyId, params.title, params.description);
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
      "add tasks, spawn teammates, save memories, or handle any operational request.",
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

// ─── save_memory ─────────────────────────────────────────────────────

function registerSaveMemory(pi: ExtensionAPI, client: DaemonClient, categories?: string[]): void {
  const categoryList = (categories || ["coding", "research", "doc-writing"]).join(", ");

  pi.registerTool({
    name: "save_memory",
    label: "Save Memory",
    description: `Save a memory to the team's knowledge base. You MUST specify at least one category from: [${categoryList}].`,
    promptSnippet: "Save a memory for the team",
    promptGuidelines: [
      "Use save_memory to persist information, research, decisions, or context for the team.",
      `You MUST always include the 'categories' parameter. Available categories: ${categoryList}`,
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Title for the note" }),
      content: Type.String({ description: "Markdown content of the note" }),
      categories: Type.Array(Type.String(), { description: `Categories for the note. REQUIRED. Choose from: ${categoryList}` }),
    }),
    async execute(_toolCallId, params) {
      const cats = params.categories?.length > 0 ? params.categories : [(categories || ["coding"])[0]];
      const result = await client.saveNote(params.title, params.content, cats);
      if (!result.success) throw new Error(result.error || "Failed to save memory");
      return {
        content: [{ type: "text", text: `Saved memory: "${params.title}" [${cats.join(", ")}]` }],
        details: { noteId: result.note?.id },
      };
    },
  });
}

// ─── search_memory ───────────────────────────────────────────────────

function registerSearchMemory(pi: ExtensionAPI, client: DaemonClient): void {
  pi.registerTool({
    name: "search_memory",
    label: "Search Memory",
    description: "Search the team's memory by keyword. Can filter by category.",
    promptSnippet: "Search team memory for relevant information",
    promptGuidelines: [
      "Use search_memory to find relevant context, conventions, or research from the team's knowledge base.",
      "Search within a specific category for more targeted results (e.g. 'coding', 'research', 'doc-writing').",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query (keywords)" }),
      category: Type.Optional(Type.String({ description: "Category to search within (optional)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const data = await client.searchNotes(params.query, params.category, params.limit);
        const results = data.results || [];
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No matching memories found." }] };
        }
        const formatted = results.map((r) => `- **${r.title}** (score: ${r.score}) — ${r.snippet}`).join("\n");
        return {
          content: [{ type: "text", text: `Found ${results.length} memories:\n${formatted}` }],
          details: { results },
        };
      } catch {
        return { content: [{ type: "text", text: "Failed to search memory (daemon unreachable)." }] };
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
