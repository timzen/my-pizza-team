// Team lead slash commands
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Store } from "./store.js";
import type { TeamServer } from "./server.js";
import type { TeamConfig, Story, Task } from "../shared/types.js";
import { STORIES_DIR } from "../shared/types.js";
import { spawnTeammate, dismissTeammate, hopToTeammate } from "./tmux.js";

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
    description: "Create a new story interactively",
    handler: async (_args, ctx) => {
      const id = await ctx.ui.input("Story ID (slug):", "my-story");
      if (!id) return;

      const title = await ctx.ui.input("Title:", "");
      if (!title) return;

      const description = await ctx.ui.editor("Description:", "Describe the story...");
      if (!description) return;

      const depsStr = await ctx.ui.input("Dependencies (comma-separated story IDs, or empty):", "");
      const dependsOn = depsStr ? depsStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

      // Ask for tasks
      const tasks: { title: string; description: string }[] = [];
      let addMore = true;
      while (addMore) {
        const taskTitle = await ctx.ui.input(`Task ${tasks.length + 1} title (empty to stop):`, "");
        if (!taskTitle) {
          addMore = false;
          break;
        }
        const taskDesc = await ctx.ui.input(`Task ${tasks.length + 1} description:`, taskTitle);
        tasks.push({ title: taskTitle, description: taskDesc || taskTitle });
      }

      if (tasks.length === 0) {
        ctx.ui.notify("Story needs at least one task", "warning");
        return;
      }

      // Create directory structure
      const storyDir = path.join(teamDir, STORIES_DIR, id);
      const tasksDir = path.join(storyDir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });

      // Write story.json
      const story: Story = { id, title, description, status: "open", dependsOn };
      fs.writeFileSync(path.join(storyDir, "story.json"), JSON.stringify(story, null, 2) + "\n");

      // Write task files
      for (let i = 0; i < tasks.length; i++) {
        const seq = String(i + 1).padStart(2, "0");
        const slug = tasks[i].title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const taskDir = path.join(tasksDir, `${seq}-${slug}`);
        fs.mkdirSync(taskDir, { recursive: true });

        const task: Task = {
          id: `${id}/${seq}`,
          title: tasks[i].title,
          description: tasks[i].description,
          status: "todo",
          result: null,
        };
        fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2) + "\n");
      }

      // Reload store
      const store = getStore();
      store.loadFromDisk();

      ctx.ui.notify(`✓ Story "${title}" created with ${tasks.length} task(s) 🍕`, "info");
    },
  });
}
