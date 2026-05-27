// Team lead slash commands
//
// Registers all interactive commands available to the team lead:
//   /ppt-init, /ppt-board, /ppt-spawn, /ppt-dismiss, /ppt-hop,
//   /ppt-inbox, /ppt-reply, /ppt-move, /ppt-pause, /ppt-resume,
//   /ppt-save, /ppt-commit, /ppt-add-story, /ppt-add-task, /ppt-delete-story
//
// LLM tools (team_add_story, team_add_task) are in ./tools.ts.
//
// Helper: addTaskToStory() handles the filesystem operations for
// creating a new task directory with task.json, determining the
// next sequence number, and reloading the store.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Store } from "./store.js";
import type { TeamServer } from "./server.js";
import type { TeamConfig, Story, Task } from "../shared/types.js";
import { STORIES_DIR, slugify, generateTeammateName } from "../shared/types.js";
import { spawnTeammate, dismissTeammate, hopToTeammate } from "./tmux.js";

/** Helper: add a task to an existing story on disk + reload store */
export function addTaskToStory(store: Store, storyId: string, title: string, description: string, teamDir: string): void {
  const story = store.getStory(storyId);
  if (!story) throw new Error(`Story "${storyId}" not found`);

  // Determine next sequence number
  const existingTasks = store.getTasksForStory(storyId);
  const nextSeq = existingTasks.length > 0
    ? Math.max(...existingTasks.map((t) => t.seq)) + 1
    : 1;
  const seq = String(nextSeq).padStart(2, "0");
  const slug = slugify(title);

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
  // /ppt-init
  pi.registerCommand("ppt-init", {
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

  // /ppt-board
  pi.registerCommand("ppt-board", {
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
        output += "  (no teammates yet — use /ppt-spawn to hire)\n";
      }
      for (const member of members) {
        const assignment = store.getAssignmentForMember(member.id);
        const taskInfo = assignment ? `🔨 ${assignment.task.title}` : "☕ idle";
        output += `  ${member.name}: ${taskInfo}\n`;
      }

      ctx.ui.notify(output, "info");
    },
  });

  // /ppt-spawn
  pi.registerCommand("ppt-spawn", {
    description: "Hire a new teammate: /ppt-spawn [cwd]",
    getArgumentCompletions: (prefix: string) => {
      const config = getConfig();
      const store = getStore();
      const items: { value: string; label: string; description?: string }[] = [];

      // Suggest story dirs
      const stories = store.getStories();
      for (const story of stories) {
        if (story.status !== "open" || !story.dir) continue;
        const tasks = store.getTasksForStory(story.id);
        const hasAvailable = tasks.some((t) => t.status === "todo");
        if (!hasAvailable) continue;
        if (story.dir.startsWith(prefix || "")) {
          items.push({ value: story.dir, label: story.dir, description: story.title });
        }
      }

      // Suggest favorite directories
      const favorites = config.teammates?.favoriteDirectories || [];
      for (const dir of favorites) {
        if (dir.startsWith(prefix || "") && !items.some((i) => i.value === dir)) {
          items.push({ value: dir, label: dir, description: "favorite" });
        }
      }

      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const config = getConfig();
      const store = getStore();
      let cwd = args?.trim() || "";

      // If no cwd provided, offer selection from stories with dirs + favorites
      if (!cwd) {
        const options: string[] = [];

        // Stories with dirs that have available tasks
        const stories = store.getStories();
        for (const story of stories) {
          if (story.status !== "open" || !story.dir) continue;
          const tasks = store.getTasksForStory(story.id);
          if (tasks.some((t) => t.status === "todo") && !options.includes(story.dir)) {
            options.push(story.dir);
          }
        }

        // Favorite directories
        const favorites = config.teammates?.favoriteDirectories || [];
        for (const dir of favorites) {
          if (!options.includes(dir)) options.push(dir);
        }

        if (options.length > 0) {
          const choice = await ctx.ui.select("Working directory for teammate:", options);
          if (!choice) return;
          cwd = choice;
        } else {
          cwd = ctx.cwd;
        }
      }

      // Resolve path
      const resolvedCwd = cwd.startsWith("~")
        ? cwd.replace("~", process.env.HOME || "")
        : path.resolve(cwd);

      // Generate name
      const members = store.getMembers();
      const existingNames = new Set(members.map((m) => m.id));
      const name = generateTeammateName(existingNames, config.teammates);

      try {
        spawnTeammate(name, resolvedCwd, {
          session: config.tmuxSession,
          leaderUrl: config.leaderUrl,
        });
        ctx.ui.notify(`✓ ${name} has joined the team working in ${cwd} 🍕`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to spawn ${name}: ${err.message}`, "error");
      }
    },
  });

  // /ppt-dismiss
  pi.registerCommand("ppt-dismiss", {
    description: "Stop a teammate: /ppt-dismiss <name>",
    handler: async (args, ctx) => {
      const config = getConfig();
      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("Usage: /ppt-dismiss <name>", "warning");
        return;
      }

      const store = getStore();
      store.removeMember(name);
      dismissTeammate(name, config.tmuxSession);
      ctx.ui.notify(`✓ ${name} has left the team`, "info");
    },
  });

  // /ppt-hop
  pi.registerCommand("ppt-hop", {
    description: "Jump to a teammate's tmux window: /ppt-hop <name>",
    handler: async (args, ctx) => {
      const config = getConfig();
      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("Usage: /ppt-hop <name>", "warning");
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

  // /ppt-inbox
  pi.registerCommand("ppt-inbox", {
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
      output += "Use /ppt-reply <name> <message> to respond.";
      ctx.ui.notify(output, "info");
    },
  });

  // /ppt-reply
  pi.registerCommand("ppt-reply", {
    description: "Reply to a teammate's message: /ppt-reply <task-id> <message>",
    handler: async (args, ctx) => {
      const parts = args?.trim().match(/^(\S+)\s+(.+)$/);
      if (!parts) {
        ctx.ui.notify("Usage: /ppt-reply <task-id> <message>", "warning");
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

  // /ppt-move
  pi.registerCommand("ppt-move", {
    description: "Move a task to a new status: /ppt-move <task-id> [status]",
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
            if (task.status === "done") continue;
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

        const transitions = store.getWorkflowForTask(taskId).transitions[task.status] || {};
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
        ctx.ui.notify("Usage: /ppt-move <task-id> [status]", "warning");
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
      const transitions = store.getWorkflowForTask(taskId).transitions[task.status] || {};
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

  // /ppt-pause
  pi.registerCommand("ppt-pause", {
    description: "Pause task distribution (teammates finish current work)",
    handler: async (_args, ctx) => {
      const server = getServer();
      await fetch(`${getConfig().leaderUrl}/api/control/pause`, { method: "POST" });
      ctx.ui.notify("⏸ Task distribution paused", "info");
    },
  });

  // /ppt-resume
  pi.registerCommand("ppt-resume", {
    description: "Resume task distribution",
    handler: async (_args, ctx) => {
      const server = getServer();
      await fetch(`${getConfig().leaderUrl}/api/control/resume`, { method: "POST" });
      ctx.ui.notify("▶ Task distribution resumed", "info");
    },
  });

  // /ppt-save
  pi.registerCommand("ppt-save", {
    description: "Flush current state to JSON files",
    handler: async (_args, ctx) => {
      const store = getStore();
      store.flushToDisk();
      ctx.ui.notify("✓ State flushed to JSON files", "info");
    },
  });

  // /ppt-commit
  pi.registerCommand("ppt-commit", {
    description: "Flush + git commit: /ppt-commit [message]",
    handler: async (args, ctx) => {
      const store = getStore();
      store.flushToDisk();
      store.commitToGit(args?.trim() || undefined);
      ctx.ui.notify("✓ State flushed and committed", "info");
    },
  });

  // /ppt-add-story
  pi.registerCommand("ppt-add-story", {
    description: "Create a new story: /ppt-add-story [id]",
    handler: async (args, ctx) => {
      const id = args?.trim() || (await ctx.ui.input("Story ID (slug):", "my-story"));
      if (!id) return;

      const title = await ctx.ui.input("Title:", "");
      if (!title) return;

      const description = await ctx.ui.editor("Description:", "Describe the story...");
      if (!description) return;

      const depsStr = await ctx.ui.input("Dependencies (comma-separated story IDs, or empty):", "");
      const dependsOn = depsStr ? depsStr.split(",").map((s) => s.trim()).filter(Boolean) : [];

      const dir = await ctx.ui.input("Working directory (optional, e.g. ~/Workspace/my-project):", "");

      // Workflow selection (only prompt if multiple workflows defined)
      const config = getConfig();
      const workflowNames = Object.keys(config.workflows);
      let workflow: string | undefined;
      if (workflowNames.length > 1) {
        const choice = await ctx.ui.input(
          `Workflow (${workflowNames.join(", ")}) [default: ${config.defaultWorkflow}]:`,
          ""
        );
        if (choice && workflowNames.includes(choice) && choice !== config.defaultWorkflow) {
          workflow = choice;
        }
      }

      // Create directory structure (no tasks required upfront)
      const storyDir = path.join(teamDir, STORIES_DIR, id);
      const tasksDir = path.join(storyDir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });

      // Write story.json
      const story: Story = { id, title, description, status: "open", dependsOn };
      if (dir) story.dir = dir;
      if (workflow) story.workflow = workflow;
      fs.writeFileSync(path.join(storyDir, "story.json"), JSON.stringify(story, null, 2) + "\n");

      // Reload store
      const store = getStore();
      store.loadFromDisk();

      ctx.ui.notify(`✓ Story "${title}" created 🍕\n  Add tasks with /ppt-add-task ${id}\n  Or ask me to break it down from a design doc!`, "info");
    },
  });

  // /ppt-add-task
  pi.registerCommand("ppt-add-task", {
    description: "Add a task to a story: /ppt-add-task <story-id>",
    handler: async (args, ctx) => {
      const storyId = args?.trim();
      if (!storyId) {
        ctx.ui.notify("Usage: /ppt-add-task <story-id>", "warning");
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

  // /ppt-delete-story
  pi.registerCommand("ppt-delete-story", {
    description: "Delete a story and all its tasks: /ppt-delete-story <story-id>",
    getArgumentCompletions: (prefix: string) => {
      const store = getStore();
      const stories = store.getStories();
      const items: { value: string; label: string; description?: string }[] = [];
      for (const story of stories) {
        if (story.id.startsWith(prefix || "")) {
          items.push({ value: story.id, label: story.id, description: story.title });
        }
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const storyId = args?.trim();
      if (!storyId) {
        ctx.ui.notify("Usage: /ppt-delete-story <story-id>", "warning");
        return;
      }

      const store = getStore();
      const story = store.getStory(storyId);
      if (!story) {
        ctx.ui.notify(`Story "${storyId}" not found`, "error");
        return;
      }

      const tasks = store.getTasksForStory(storyId);
      const confirm = await ctx.ui.input(
        `Delete story "${story.title}" and its ${tasks.length} task(s)? This cannot be undone. Type "yes" to confirm:`,
        ""
      );
      if (confirm?.toLowerCase() !== "yes") {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      try {
        store.deleteStory(storyId);
        ctx.ui.notify(`✓ Story "${story.title}" deleted permanently.`, "info");
      } catch (e: any) {
        ctx.ui.notify(`Error: ${e.message}`, "error");
      }
    },
  });
}
