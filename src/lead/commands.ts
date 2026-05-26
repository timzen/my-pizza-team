// Team lead slash commands
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Store } from "./store.js";
import type { TeamServer } from "./server.js";
import type { TeamConfig, Story, Task } from "../shared/types.js";
import { STORIES_DIR } from "../shared/types.js";
import { spawnTeammate, dismissTeammate, hopToTeammate } from "./tmux.js";

/** Helper: add a task to an existing story on disk + reload store */
function addTaskToStory(store: Store, storyId: string, title: string, description: string, teamDir: string): void {
  const story = store.getStory(storyId);
  if (!story) throw new Error(`Story "${storyId}" not found`);

  // Determine next sequence number
  const existingTasks = store.getTasksForStory(storyId);
  const nextSeq = existingTasks.length > 0
    ? Math.max(...existingTasks.map((t) => t.seq)) + 1
    : 1;
  const seq = String(nextSeq).padStart(2, "0");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const tasksDir = path.join(story.dirPath, "tasks");
  const taskDir = path.join(tasksDir, `${seq}-${slug}`);
  fs.mkdirSync(taskDir, { recursive: true });

  const task: Task = {
    id: `${storyId}/${seq}`,
    title,
    description,
    status: "todo",
    result: null,
  };
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2) + "\n");

  // Reload store to pick up the new task
  store.loadFromDisk();
}

export function registerLeadCommands(
  pi: ExtensionAPI,
  getStore: () => Store,
  getServer: () => TeamServer,
  getConfig: () => TeamConfig,
  teamDir: string
): void {
  // /team-init
  pi.registerCommand("team-init", {
    description: "Initialize current directory as a pi-pizza-team board",
    handler: async (_args, ctx) => {
      if (fs.existsSync(teamDir)) {
        ctx.ui.notify("Already initialized! .pi-pizza-team/ exists.", "warning");
        return;
      }

      const { DEFAULT_CONFIG } = await import("../shared/types.js");
      fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, "config.json"),
        JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n"
      );

      // Add .gitignore for state.db
      fs.writeFileSync(
        path.join(teamDir, ".gitignore"),
        "state.db\nstate.db-wal\nstate.db-shm\n"
      );

      ctx.ui.notify("✓ Initialized .pi-pizza-team/ — your kanban board is ready! 🍕", "info");
    },
  });

  // /team-board
  pi.registerCommand("team-board", {
    description: "Show kanban board — stories, tasks, and team status",
    handler: async (_args, ctx) => {
      const store = getStore();
      const stories = store.getStories();
      const members = store.getMembers();

      let output = "📋 pi-pizza-team board\n══════════════════════\n\n";

      // Stories
      output += "Stories:\n";
      for (const story of stories) {
        const tasks = store.getTasksForStory(story.id);
        const done = tasks.filter((t) => t.status === "done").length;
        const ready = store.isStoryReady(story.id);
        const icon = story.status === "done" ? "✓" : ready ? "●" : "○";
        const blocked = !ready && story.status !== "done" ? ` (blocked by: ${story.dependsOn.join(", ")})` : "";
        output += `  ${icon} ${story.title} [${done}/${tasks.length}]${blocked}\n`;

        for (const task of tasks) {
          const assignment = store.getAssignment(task.id);
          const assignee = assignment ? ` → ${assignment.memberId}` : "";
          const statusIcon =
            task.status === "done" ? "✓" :
            task.status === "in_progress" ? "▶" :
            task.status === "needs_input" ? "❓" :
            task.status === "review" ? "👀" : "·";
          output += `    ${statusIcon} ${task.title} [${task.status}]${assignee}\n`;
        }
        output += "\n";
      }

      // Team
      output += "Team:\n";
      if (members.length === 0) {
        output += "  (no teammates yet — use /team-spawn to hire)\n";
      }
      for (const member of members) {
        const assignment = store.getAssignmentForMember(member.id);
        const taskInfo = assignment ? `🔨 ${assignment.task.title}` : "☕ idle";
        output += `  ${member.name}: ${taskInfo}\n`;
      }

      ctx.ui.notify(output, "info");
    },
  });

  // /team-spawn
  pi.registerCommand("team-spawn", {
    description: "Hire a new teammate: /team-spawn <name> [cwd]",
    handler: async (args, ctx) => {
      const config = getConfig();
      const parts = args?.trim().split(/\s+/) || [];
      if (parts.length < 1 || !parts[0]) {
        ctx.ui.notify("Usage: /team-spawn <name> [cwd]", "warning");
        return;
      }

      const name = parts[0];
      const cwd = parts[1] || ctx.cwd;
      const resolvedCwd = cwd.startsWith("~")
        ? cwd.replace("~", process.env.HOME || "")
        : path.resolve(cwd);

      try {
        spawnTeammate(name, resolvedCwd, {
          session: config.tmuxSession,
          leaderUrl: config.leaderUrl,
        });
        ctx.ui.notify(`✓ ${name} has joined the team (tmux window '${name}') 🍕`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to spawn ${name}: ${err.message}`, "error");
      }
    },
  });

  // /team-dismiss
  pi.registerCommand("team-dismiss", {
    description: "Stop a teammate: /team-dismiss <name>",
    handler: async (args, ctx) => {
      const config = getConfig();
      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("Usage: /team-dismiss <name>", "warning");
        return;
      }

      const store = getStore();
      store.removeMember(name);
      dismissTeammate(name, config.tmuxSession);
      ctx.ui.notify(`✓ ${name} has left the team`, "info");
    },
  });

  // /team-hop
  pi.registerCommand("team-hop", {
    description: "Jump to a teammate's tmux window: /team-hop <name>",
    handler: async (args, ctx) => {
      const config = getConfig();
      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("Usage: /team-hop <name>", "warning");
        return;
      }

      try {
        hopToTeammate(name, config.tmuxSession);
        ctx.ui.notify(`→ Switching to ${name}'s window (Ctrl+B 0 to return)`, "info");
      } catch (err: any) {
        ctx.ui.notify(err.message, "error");
      }
    },
  });

  // /team-inbox
  pi.registerCommand("team-inbox", {
    description: "Show messages from teammates needing your input",
    handler: async (_args, ctx) => {
      const store = getStore();
      const inboxTasks = store.getInboxTasks();

      if (inboxTasks.length === 0) {
        ctx.ui.notify("📬 Inbox empty — no messages needing your attention!", "info");
        return;
      }

      let output = "📬 Messages needing your attention:\n\n";
      for (const task of inboxTasks) {
        const messages = store.getMessages(task.id);
        const lastMsg = messages[messages.length - 1];
        output += `  ${task.storyId}/${task.slug} [${task.status}]\n`;
        output += `  "${task.title}"\n`;
        if (lastMsg) {
          output += `  Last from ${lastMsg.from}: "${lastMsg.body.slice(0, 80)}${lastMsg.body.length > 80 ? "..." : ""}"\n`;
        }
        output += "\n";
      }
      output += "Use /team-reply <name> <message> to respond.";
      ctx.ui.notify(output, "info");
    },
  });

  // /team-reply
  pi.registerCommand("team-reply", {
    description: "Reply to a teammate's message: /team-reply <task-id> <message>",
    handler: async (args, ctx) => {
      const parts = args?.trim().match(/^(\S+)\s+(.+)$/);
      if (!parts) {
        ctx.ui.notify("Usage: /team-reply <task-id> <message>", "warning");
        return;
      }

      const [, taskId, message] = parts;
      const store = getStore();
      const task = store.getTask(taskId);

      if (!task) {
        ctx.ui.notify(`Task "${taskId}" not found`, "error");
        return;
      }

      store.addMessage(taskId, "lead", message);

      // If task is in needs_input, move it back to in_progress
      if (task.status === "needs_input") {
        const check = store.canTransition(taskId, "in_progress", "lead");
        if (check.ok) {
          store.updateTaskStatus(taskId, "in_progress");
          ctx.ui.notify(`✓ Reply sent + task moved back to in_progress`, "info");
          return;
        }
      }

      ctx.ui.notify(`✓ Reply sent to ${taskId}`, "info");
    },
  });

  // /team-move
  pi.registerCommand("team-move", {
    description: "Move a task to a new status: /team-move <task-id> [status]",
    getArgumentCompletions: (prefix: string) => {
      const store = getStore();
      const config = getConfig();
      const parts = prefix.split(/\s+/);

      if (parts.length <= 1) {
        // Autocomplete task IDs
        const stories = store.getStories();
        const items: { value: string; label: string; description?: string }[] = [];
        for (const story of stories) {
          const tasks = store.getTasksForStory(story.id);
          for (const task of tasks) {
            if (task.id.startsWith(parts[0] || "")) {
              items.push({ value: task.id, label: task.id, description: `[${task.status}] ${task.title}` });
            }
          }
        }
        return items.length > 0 ? items : null;
      }

      if (parts.length === 2) {
        // Autocomplete status for the given task
        const taskId = parts[0];
        const task = store.getTask(taskId);
        if (!task) return null;

        const transitions = config.workflow.transitions[task.status] || {};
        const leadTransitions = Object.entries(transitions)
          .filter(([_, perm]) => perm === "lead" || perm === "any")
          .map(([state]) => state)
          .filter((s) => s.startsWith(parts[1] || ""));

        if (leadTransitions.length === 0) return null;
        return leadTransitions.map((s) => ({ value: `${taskId} ${s}`, label: s }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      if (parts.length < 1 || !parts[0]) {
        ctx.ui.notify("Usage: /team-move <task-id> [status]", "warning");
        return;
      }

      const taskId = parts[0];
      const store = getStore();
      const config = getConfig();
      const task = store.getTask(taskId);

      if (!task) {
        ctx.ui.notify(`Task "${taskId}" not found`, "error");
        return;
      }

      // Determine available transitions for the lead from current status
      const transitions = config.workflow.transitions[task.status] || {};
      const leadTransitions = Object.entries(transitions)
        .filter(([_, perm]) => perm === "lead" || perm === "any")
        .map(([state]) => state);

      if (leadTransitions.length === 0) {
        ctx.ui.notify(`No transitions available for lead from "${task.status}"`, "warning");
        return;
      }

      let newStatus = parts[1];

      if (!newStatus) {
        // If only one option, use it; otherwise prompt
        if (leadTransitions.length === 1) {
          newStatus = leadTransitions[0];
        } else {
          const choice = await ctx.ui.select(
            `Move "${task.title}" [${task.status}] to:`,
            leadTransitions
          );
          if (!choice) return;
          newStatus = choice;
        }
      }

      const check = store.canTransition(taskId, newStatus, "lead");
      if (!check.ok) {
        ctx.ui.notify(`Cannot move: ${check.error}`, "error");
        return;
      }

      store.updateTaskStatus(taskId, newStatus);

      // If moving back to in_progress, release assignment so it can be re-claimed
      if (newStatus === "in_progress") {
        store.releaseTask(taskId);
      }

      ctx.ui.notify(`✓ ${task.title} moved to ${newStatus}`, "info");
    },
  });

  // /team-pause
  pi.registerCommand("team-pause", {
    description: "Pause task distribution (teammates finish current work)",
    handler: async (_args, ctx) => {
      const server = getServer();
      await fetch(`${getConfig().leaderUrl}/api/control/pause`, { method: "POST" });
      ctx.ui.notify("⏸ Task distribution paused", "info");
    },
  });

  // /team-resume
  pi.registerCommand("team-resume", {
    description: "Resume task distribution",
    handler: async (_args, ctx) => {
      const server = getServer();
      await fetch(`${getConfig().leaderUrl}/api/control/resume`, { method: "POST" });
      ctx.ui.notify("▶ Task distribution resumed", "info");
    },
  });

  // /team-save
  pi.registerCommand("team-save", {
    description: "Flush current state to JSON files",
    handler: async (_args, ctx) => {
      const store = getStore();
      store.flushToDisk();
      ctx.ui.notify("✓ State flushed to JSON files", "info");
    },
  });

  // /team-commit
  pi.registerCommand("team-commit", {
    description: "Flush + git commit: /team-commit [message]",
    handler: async (args, ctx) => {
      const store = getStore();
      store.flushToDisk();
      store.commitToGit(args?.trim() || undefined);
      ctx.ui.notify("✓ State flushed and committed", "info");
    },
  });

  // /team-add-story
  pi.registerCommand("team-add-story", {
    description: "Create a new story: /team-add-story [id]",
    handler: async (args, ctx) => {
      const id = args?.trim() || (await ctx.ui.input("Story ID (slug):", "my-story"));
      if (!id) return;

      const title = await ctx.ui.input("Title:", "");
      if (!title) return;

      const description = await ctx.ui.editor("Description:", "Describe the story...");
      if (!description) return;

      const depsStr = await ctx.ui.input("Dependencies (comma-separated story IDs, or empty):", "");
      const dependsOn = depsStr ? depsStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

      // Create directory structure (no tasks required upfront)
      const storyDir = path.join(teamDir, STORIES_DIR, id);
      const tasksDir = path.join(storyDir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });

      // Write story.json
      const story: Story = { id, title, description, status: "open", dependsOn };
      fs.writeFileSync(path.join(storyDir, "story.json"), JSON.stringify(story, null, 2) + "\n");

      // Reload store
      const store = getStore();
      store.loadFromDisk();

      ctx.ui.notify(`✓ Story "${title}" created 🍕\n  Add tasks with /team-add-task ${id}\n  Or ask me to break it down from a design doc!`, "info");
    },
  });

  // /team-add-task
  pi.registerCommand("team-add-task", {
    description: "Add a task to a story: /team-add-task <story-id>",
    handler: async (args, ctx) => {
      const storyId = args?.trim();
      if (!storyId) {
        ctx.ui.notify("Usage: /team-add-task <story-id>", "warning");
        return;
      }

      const store = getStore();
      const story = store.getStory(storyId);
      if (!story) {
        ctx.ui.notify(`Story "${storyId}" not found`, "error");
        return;
      }

      const title = await ctx.ui.input("Task title:", "");
      if (!title) return;

      const description = await ctx.ui.editor("Task description (this is what the teammate receives):", title);
      if (!description) return;

      addTaskToStory(store, storyId, title, description, teamDir);
      ctx.ui.notify(`✓ Task "${title}" added to ${storyId}`, "info");
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
        throw new Error(`Story "${params.storyId}" not found. Use /team-add-story to create it first.`);
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
}
