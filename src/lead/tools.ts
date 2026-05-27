// LLM-callable tools for the team lead
//
// Registers tools that the LLM can invoke conversationally:
//   - team_add_story: Create a new story on the kanban board
//   - team_add_task: Add a task to an existing story
//
// These enable workflows like:
//   "Break this design doc into stories and tasks"
//   "Add a new story for the auth refactor"
//   "Add three tasks to the auth-refactor story"
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Store } from "./store.js";
import type { TeamConfig, Story } from "../shared/types.js";
import { STORIES_DIR, ARCHIVED_DIR } from "../shared/types.js";
import { addTaskToStory } from "./commands.js";

export function registerLeadTools(
  pi: ExtensionAPI,
  getStore: () => Store,
  getConfig: () => TeamConfig,
  teamDir: string
): void {
  // LLM-callable tool for creating stories
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
      dependsOn: Type.Optional(
        Type.Array(Type.String(), { description: "Array of story IDs this story depends on (optional)" })
      ),
      dir: Type.Optional(
        Type.String({ description: "Working directory hint for teammates (optional, e.g., '~/Workspace/my-project')" })
      ),
      workflow: Type.Optional(
        Type.String({ description: "Named workflow to use for this story (optional, defaults to the team's default workflow)" })
      ),
    }),
    async execute(_toolCallId, params) {
      const store = getStore();

      // Check if story already exists
      if (store.getStory(params.id)) {
        throw new Error(`Story "${params.id}" already exists.`);
      }

      // Create directory structure
      const storyDir = path.join(teamDir, STORIES_DIR, params.id);
      const tasksDir = path.join(storyDir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });

      // Write story.json
      const story: Story = {
        id: params.id,
        title: params.title,
        description: params.description,
        status: "open",
        dependsOn: params.dependsOn || [],
      };
      if (params.dir) story.dir = params.dir;
      if (params.workflow) story.workflow = params.workflow;
      fs.writeFileSync(path.join(storyDir, "story.json"), JSON.stringify(story, null, 2) + "\n");

      // Reload store
      store.loadFromDisk();

      return {
        content: [
          {
            type: "text",
            text: `Created story "${params.title}" (${params.id}). Add tasks with team_add_task.`,
          },
        ],
        details: { storyId: params.id },
      };
    },
  });

  // LLM-callable tool for adding tasks (so Pi can break down stories conversationally)
  pi.registerTool({
    name: "team_add_task",
    label: "Add Team Task",
    description:
      "Add a task to an existing story on the pi-pizza-team board. Use this when breaking down a story into tasks, " +
      "whether from a design document, a conversation, or planning session. Tasks are executed sequentially within a story.",
    promptSnippet: "Add a task to a pi-pizza-team story",
    promptGuidelines: [
      "Use team_add_task when the user asks to break a story into tasks, plan work from a design doc, or add tasks to the kanban board.",
      "Call team_add_task multiple times to add multiple sequential tasks to a story.",
      "The task description should be a complete prompt that a teammate Pi can execute autonomously.",
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story to add the task to" }),
      title: Type.String({ description: "Short title for the task" }),
      description: Type.String({
        description:
          "Full task description/prompt. This is what a teammate Pi receives as their work instruction. " +
          "Be specific and include enough context for autonomous execution.",
      }),
    }),
    async execute(_toolCallId, params) {
      const store = getStore();
      const story = store.getStory(params.storyId);
      if (!story) {
        throw new Error(`Story "${params.storyId}" not found. Use /ppt-add-story to create it first.`);
      }

      addTaskToStory(store, params.storyId, params.title, params.description, teamDir);

      const tasks = store.getTasksForStory(params.storyId);
      return {
        content: [
          {
            type: "text",
            text: `Added task "${params.title}" to story "${story.title}" (now ${tasks.length} tasks total)`,
          },
        ],
        details: { storyId: params.storyId, taskCount: tasks.length },
      };
    },
  });

  // LLM-callable tool for enriching archived story synopses
  pi.registerTool({
    name: "team_enrich_synopsis",
    label: "Enrich Archived Story Synopsis",
    description:
      "Generate a rich, human-readable SYNOPSIS.md for an archived story using its full context " +
      "(story description, task details, and message history). Returns the context for you to write the synopsis.",
    promptSnippet: "Generate a rich summary for an archived story",
    promptGuidelines: [
      "Use team_enrich_synopsis when the user wants a polished summary of an archived story.",
      "After calling this tool, write a well-structured markdown synopsis and use the returned write instructions.",
    ],
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the archived story to generate a synopsis for" }),
    }),
    async execute(_toolCallId, params) {
      const store = getStore();
      const context = store.getArchivedStoryContext(params.storyId);
      if (!context) {
        throw new Error(`Archived story "${params.storyId}" not found.`);
      }

      const { story, tasks, messages } = context;

      // Build a context summary for the LLM to work with
      let contextText = `# Archived Story Context\n\n`;
      contextText += `**Title**: ${story.title}\n`;
      contextText += `**ID**: ${story.id}\n`;
      contextText += `**Archived**: ${story.archivedAt || "unknown"}\n\n`;
      contextText += `## Description\n${story.description}\n\n`;
      contextText += `## Tasks (${tasks.length})\n\n`;

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        contextText += `### ${i + 1}. ${task.title}\n`;
        contextText += `**Status**: ${task.status}\n`;
        if (task.result) {
          contextText += `**Result**: ${task.result}\n`;
        }
        contextText += `${task.description}\n\n`;

        const taskMessages = messages[task.id];
        if (taskMessages && taskMessages.length > 0) {
          contextText += `**Messages** (${taskMessages.length}):\n`;
          // Include up to 20 messages to keep context manageable
          const displayed = taskMessages.slice(-20);
          for (const msg of displayed) {
            contextText += `- [${msg.from}]: ${msg.body.slice(0, 200)}${msg.body.length > 200 ? "..." : ""}\n`;
          }
          contextText += `\n`;
        }
      }

      contextText += `\n---\n\nPlease write a polished SYNOPSIS.md for this story. Include:\n`;
      contextText += `- A title and metadata header\n`;
      contextText += `- A narrative summary of what was accomplished\n`;
      contextText += `- Key decisions or challenges from the message history\n`;
      contextText += `- A list of completed tasks with brief outcomes\n\n`;
      contextText += `After writing, save it to: ${path.join(teamDir, "archived", params.storyId, "SYNOPSIS.md")}\n`;

      return {
        content: [
          {
            type: "text",
            text: contextText,
          },
        ],
        details: { storyId: params.storyId, taskCount: tasks.length },
      };
    },
  });
}
