// LLM-callable tools for the pi-pizza-team extension
//
// Registers tools that the LLM can invoke conversationally. All operations
// go through the daemon HTTP API — no local store or filesystem access.
//
// Tools:
//   - team_add_story: Create a new story on the kanban board
//   - team_edit_story: Edit an existing story
//   - team_add_task: Add a task to an existing story
//   - team_queue_request: Queue a request for the assistant
//   - search_memory: Search the team's memory by keyword
//   - save_memory: Save a memory to the team's knowledge base
//   - upload_attachment: Upload a file to a task

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DaemonClient } from "./client.js";

export function registerTools(
  pi: ExtensionAPI,
  client: DaemonClient,
  options: {
    /** If true, register save_memory (assistant role) */
    canSaveMemory?: boolean;
    /** If true, register upload_attachment (teammate role) */
    canUpload?: boolean;
    /** Function to get current task ID (for upload_attachment) */
    getCurrentTaskId?: () => string | null;
    /** Category list for save_memory descriptions */
    categories?: string[];
  } = {}
): void {
  // ─── team_add_story ────────────────────────────────────────────────

  pi.registerTool({
    name: "team_add_story",
    label: "Add Team Story",
    description:
      "Create a new story on the pi-pizza-team kanban board. Stories are high-level work items that contain " +
      "sequential tasks. Use this when planning work, breaking down a project, or when the user asks to create a story.",
    promptSnippet: "Create a new story on the pi-pizza-team board",
    promptGuidelines: [
      "Use team_add_story to create stories when the user discusses new features, epics, or work items for the team.",
      "After creating a story with team_add_story, use team_add_task to add tasks to it.",
      "Story IDs should be short slugs (lowercase, hyphens, e.g., 'auth-refactor').",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Story ID slug (lowercase, hyphens, e.g., 'auth-refactor')" }),
      title: Type.String({ description: "Human-readable title for the story" }),
      description: Type.String({ description: "Full description of what this story accomplishes" }),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Array of story IDs this story depends on" })),
      dir: Type.Optional(Type.String({ description: "Working directory hint for teammates (e.g., '~/Workspace/my-project')" })),
      workflow: Type.Optional(Type.String({ description: "Named workflow to use for this story (defaults to the team's default)" })),
    }),
    async execute(_toolCallId, params) {
      const result = await client.createStory({
        id: params.id,
        title: params.title,
        description: params.description,
        dependsOn: params.dependsOn,
        dir: params.dir,
        workflow: params.workflow,
      });

      if (!result.success) throw new Error(result.error || "Failed to create story");

      return {
        content: [{ type: "text", text: `Created story "${params.title}" (${params.id}). Add tasks with team_add_task.` }],
        details: { storyId: params.id },
      };
    },
  });

  // ─── team_edit_story ───────────────────────────────────────────────

  pi.registerTool({
    name: "team_edit_story",
    label: "Edit Team Story",
    description:
      "Edit an existing story on the pi-pizza-team kanban board. Can update title, description, status, " +
      "dependencies, working directory, and workflow.",
    promptSnippet: "Edit an existing story on the pi-pizza-team board",
    promptGuidelines: [
      "Use team_edit_story to modify existing stories.",
      "Only the fields you provide will be changed.",
      "Set dir or workflow to empty string to clear them.",
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story to edit" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done")], { description: "New status" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "New dependency list" })),
      dir: Type.Optional(Type.String({ description: "New working directory (empty to clear)" })),
      workflow: Type.Optional(Type.String({ description: "New workflow name (empty for default)" })),
    }),
    async execute(_toolCallId, params) {
      const { storyId, ...updates } = params;
      // Convert empty strings to null for clearing
      if (updates.dir === "") (updates as any).dir = null;
      if (updates.workflow === "") (updates as any).workflow = null;

      const result = await client.updateStory(storyId, updates);
      if (!result.success) throw new Error(result.error || "Failed to update story");

      const changed = Object.keys(updates).join(", ");
      return {
        content: [{ type: "text", text: `Updated story "${storyId}": changed ${changed}.` }],
        details: { storyId, updatedFields: Object.keys(updates) },
      };
    },
  });

  // ─── team_add_task ─────────────────────────────────────────────────

  pi.registerTool({
    name: "team_add_task",
    label: "Add Team Task",
    description:
      "Add a task to an existing story on the pi-pizza-team board. Tasks are executed sequentially within a story.",
    promptSnippet: "Add a task to a pi-pizza-team story",
    promptGuidelines: [
      "Use team_add_task when breaking a story into tasks or planning work.",
      "Call team_add_task multiple times to add multiple sequential tasks.",
      "The task description should be a complete prompt for autonomous execution.",
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story to add the task to" }),
      title: Type.String({ description: "Short title for the task" }),
      description: Type.String({ description: "Full task description/prompt for the teammate to execute" }),
    }),
    async execute(_toolCallId, params) {
      const result = await client.addTask(params.storyId, params.title, params.description);
      if (!result.success) throw new Error(result.error || "Failed to add task");

      return {
        content: [{ type: "text", text: `Added task "${params.title}" to story "${params.storyId}"` }],
        details: { storyId: params.storyId, taskId: result.task?.id },
      };
    },
  });

  // ─── team_queue_request ────────────────────────────────────────────

  pi.registerTool({
    name: "team_queue_request",
    label: "Queue Assistant Request",
    description:
      "Queue a request for the pi-pizza-team assistant to process. The assistant can create stories, " +
      "add tasks, spawn teammates, save memories, or handle any operational request.",
    promptSnippet: "Queue a request for the team assistant",
    promptGuidelines: [
      "Use team_queue_request when you want to delegate operational work to the assistant.",
      "The assistant processes requests asynchronously — it will handle them in order.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Free-form request for the assistant to process" }),
    }),
    async execute(_toolCallId, params) {
      const result = await client.enqueueAssistantRequest(params.prompt);
      if (!result.success) throw new Error(result.error || "Failed to queue request");

      return {
        content: [{ type: "text", text: `Queued request for assistant (id: ${result.item?.id}). It will be processed when the assistant picks it up.` }],
        details: { itemId: result.item?.id },
      };
    },
  });

  // ─── search_memory ─────────────────────────────────────────────────

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

  // ─── save_memory (assistant role only) ─────────────────────────────

  if (options.canSaveMemory) {
    const categoryList = (options.categories || ["coding", "research", "doc-writing"]).join(", ");

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
        const cats = params.categories?.length > 0 ? params.categories : [options.categories?.[0] || "coding"];
        const result = await client.saveNote(params.title, params.content, cats);
        if (!result.success) throw new Error(result.error || "Failed to save memory");
        return {
          content: [{ type: "text", text: `Saved memory: "${params.title}" [${cats.join(", ")}]` }],
          details: { noteId: result.note?.id },
        };
      },
    });
  }

  // ─── upload_attachment (teammate role only) ────────────────────────

  if (options.canUpload && options.getCurrentTaskId) {
    const getTaskId = options.getCurrentTaskId;

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
        const taskId = params.taskId || getTaskId();
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
}
