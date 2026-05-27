// HTTP API server for the team lead
//
// Serves both the REST API (for teammates) and the web UI (for humans).
// Built with Hono for lightweight routing.
//
// Web routes:
//   GET /       → Landing page with status summary
//   GET /board  → Kanban board with swimlanes (auto-polls API)
//
// API routes: see docs/ARCHITECTURE.md for the full route table.
//
// The server enforces workflow permissions on status updates —
// if a teammate tries a transition that requires "lead", it returns 403.
//
// Task distribution can be paused/resumed via /api/control/* endpoints,
// which causes GET /api/next-task to return null while paused.
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "./store.js";
import type { TeamConfig } from "../shared/types.js";
import { slugify, generateTeammateName } from "../shared/types.js";
import { spawnTeammate } from "./tmux.js";
import { BOARD_HTML, ARCHIVED_HTML, CONFIG_HTML, THEME_CSS, BOARD_CSS, ARCHIVED_CSS, CONFIG_CSS, NAV_CSS, SHARED_JS, NAV_JS } from "./assets.js";
import type {
  StatusResponse,
  StoriesResponse,
  NextTaskResponse,
  ClaimRequest,
  ClaimResponse,
  StatusUpdateRequest,
  StatusUpdateResponse,
  PostMessageRequest,
  PostMessageResponse,
  MessagesResponse,
  JoinRequest,
  JoinResponse,
  HeartbeatRequest,
  TeamResponse,
  CreateStoryRequest,
  CreateStoryResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  UpdateTaskRequest,
  UpdateTaskResponse,
  DeleteTaskResponse,
  MoveTaskRequest,
  MoveTaskResponse,
  TokenUsageRequest,
  TokenUsageResponse,
  DeleteStoryResponse,
  ArchiveStoryResponse,
  ArchivedStoriesResponse,
} from "../shared/protocol.js";

// Cost per 1M tokens (input, output) for common models
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-3": { input: 0.25, output: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.80, output: 4.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "o3": { input: 10.0, output: 40.0 },
  "o3-mini": { input: 1.10, output: 4.40 },
};

function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  // Try exact match, then prefix match
  let costs = MODEL_COSTS[model];
  if (!costs) {
    const key = Object.keys(MODEL_COSTS).find(k => model.startsWith(k) || model.includes(k));
    costs = key ? MODEL_COSTS[key] : { input: 3.0, output: 15.0 }; // default to sonnet-ish pricing
  }
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

export class TeamServer {
  private app: Hono;
  private server: ServerType | null = null;
  private store: Store;
  private config: TeamConfig;
  private teamDir: string;
  private paused = false;

  constructor(store: Store, config: TeamConfig, teamDir: string) {
    this.store = store;
    this.config = config;
    this.teamDir = teamDir;
    this.app = new Hono();
    this.setupRoutes();
  }

  /** Assemble transition instructions into a single markdown string (or undefined if none) */
  private getInstructionsMarkdown(fromStatus: string, toStatus: string): string | undefined {
    const { exitInstructions, enterInstructions } = this.store.getTransitionInstructions(fromStatus, toStatus);
    const parts: string[] = [];
    if (exitInstructions) parts.push(exitInstructions);
    if (enterInstructions) parts.push(enterInstructions);
    return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
  }

  private setupRoutes(): void {
    // Landing page
    this.app.get("/", (c) => {
      return c.html(`<!DOCTYPE html>
<html><head><title>🍕 pi-pizza-team</title>
<link rel="stylesheet" href="/css/theme.css">
<link rel="stylesheet" href="/css/nav.css">
<style>
  body { font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: var(--bg-primary); color: var(--text-primary); }
  h1 { font-size: 2em; margin-top: 20px; }
  a { color: var(--accent); }
  .status { background: var(--bg-secondary); padding: 16px; border-radius: 8px; margin: 20px 0; }
  code { background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; }
</style>
<script src="/js/nav.js" defer></script>
</head><body>
<h1>🍕 pi-pizza-team</h1>
<p>The team lead API is running.</p>
<div class="status" id="status">Loading...</div>
<h3>API Endpoints</h3>
<h4>Status &amp; Stories</h4>
<ul>
  <li><a href="/api/status">GET /api/status</a> — Server status, workflow config</li>
  <li><a href="/api/stories">GET /api/stories</a> — All stories + tasks</li>
  <li>POST /api/stories — Create a new story</li>
  <li>DELETE /api/stories/:id — Delete a story</li>
  <li>POST /api/stories/:id/archive — Archive a completed story</li>
  <li>POST /api/stories/:storyId/tasks — Create a task within a story</li>
</ul>
<h4>Tasks</h4>
<ul>
  <li>GET /api/next-task?memberId=X — Next claimable task</li>
  <li>POST /api/tasks/:id/claim — Claim a task</li>
  <li>POST /api/tasks/:id/status — Update task status</li>
  <li>POST /api/tasks/:id/move — Move task (lead-only)</li>
  <li>PUT /api/tasks/:id — Update task title/description</li>
  <li>DELETE /api/tasks/:id — Delete a task</li>
  <li>POST /api/tasks/:id/message — Post a message</li>
  <li>GET /api/tasks/:id/messages — Get message thread</li>
  <li>POST /api/tasks/:id/token-usage — Report token usage</li>
  <li>POST /api/tasks/:id/mark-read — Mark messages as read</li>
</ul>
<h4>Team</h4>
<ul>
  <li><a href="/api/team">GET /api/team</a> — List members</li>
  <li>POST /api/team/join — Register a teammate</li>
  <li>POST /api/team/heartbeat — Keepalive</li>
  <li>POST /api/team/spawn — Spawn a new teammate</li>
  <li><a href="/api/team/spawn-options">GET /api/team/spawn-options</a> — Available directories for spawning</li>
</ul>
<h4>Archive</h4>
<ul>
  <li><a href="/api/archived">GET /api/archived</a> — List archived stories</li>
  <li>POST /api/archived/:id/enrich — Regenerate synopsis</li>
</ul>
<h4>Config &amp; Control</h4>
<ul>
  <li><a href="/api/config">GET /api/config</a> — Read configuration</li>
  <li>PUT /api/config — Update configuration</li>
  <li><a href="/api/browse?path=~">GET /api/browse?path=...</a> — Browse directories</li>
  <li>POST /api/control/pause — Pause task distribution</li>
  <li>POST /api/control/resume — Resume task distribution</li>
</ul>
<script>
fetch('/api/status').then(r=>r.json()).then(d=>{
  document.getElementById('status').innerHTML = 
    '<strong>Stories:</strong> '+d.stories.open+' open, '+d.stories.done+' done<br>'+
    '<strong>Team:</strong> '+d.members.total+' members ('+d.members.working+' working)<br>'+
    '<strong>Inbox:</strong> '+d.inbox+' messages';
});
</script>
</body></html>`);
    });

    // Kanban board
    this.app.get("/board", (c) => {
      return c.html(BOARD_HTML);
    });

    // Archived stories page
    this.app.get("/archived", (c) => {
      return c.html(ARCHIVED_HTML);
    });

    // Config page
    this.app.get("/config", (c) => {
      return c.html(CONFIG_HTML);
    });

    // CSS assets
    this.app.get("/css/theme.css", (c) => {
      c.header("Content-Type", "text/css");
      return c.body(THEME_CSS);
    });
    this.app.get("/css/board.css", (c) => {
      c.header("Content-Type", "text/css");
      return c.body(BOARD_CSS);
    });
    this.app.get("/css/archived-page.css", (c) => {
      c.header("Content-Type", "text/css");
      return c.body(ARCHIVED_CSS);
    });
    this.app.get("/css/config-page.css", (c) => {
      c.header("Content-Type", "text/css");
      return c.body(CONFIG_CSS);
    });
    this.app.get("/css/nav.css", (c) => {
      c.header("Content-Type", "text/css");
      return c.body(NAV_CSS);
    });
    this.app.get("/js/shared.js", (c) => {
      c.header("Content-Type", "application/javascript");
      return c.body(SHARED_JS);
    });
    this.app.get("/js/nav.js", (c) => {
      c.header("Content-Type", "application/javascript");
      return c.body(NAV_JS);
    });

    // GET /api/status
    this.app.get("/api/status", (c) => {
      const stories = this.store.getStories();
      const allTasks: Record<string, number> = {};
      let totalTasks = 0;

      for (const story of stories) {
        const tasks = this.store.getTasksForStory(story.id);
        for (const task of tasks) {
          allTasks[task.status] = (allTasks[task.status] || 0) + 1;
          totalTasks++;
        }
      }

      const members = this.store.getMembers();
      const inbox = this.store.getInboxTasks();

      const response: StatusResponse = {
        running: true,
        stories: {
          total: stories.length,
          open: stories.filter((s) => s.status === "open").length,
          done: stories.filter((s) => s.status === "done").length,
        },
        tasks: { total: totalTasks, byStatus: allTasks },
        members: {
          total: members.length,
          working: members.filter((m) => m.status === "working").length,
          idle: members.filter((m) => m.status === "idle").length,
        },
        inbox: inbox.length,
        defaultWorkflow: this.config.defaultWorkflow,
        workflows: this.config.workflows,
        workflow: this.config.workflows[this.config.defaultWorkflow], // legacy compat
      };
      return c.json(response);
    });

    // GET /api/stories
    this.app.get("/api/stories", (c) => {
      const stories = this.store.getStories();
      const response: StoriesResponse = {
        stories: stories.map((story) => {
          const tasks = this.store.getTasksForStory(story.id);
          return {
            id: story.id,
            title: story.title,
            description: story.description,
            status: story.status,
            dependsOn: story.dependsOn,
            ready: this.store.isStoryReady(story.id),
            dir: story.dir,
            workflow: story.workflow,
            tasks: tasks.map((task) => {
              const assignment = this.store.getAssignment(task.id);
              const tokenSummary = this.store.getTokenUsageSummary(task.id);
              return {
                id: task.id,
                seq: task.seq,
                title: task.title,
                status: task.status,
                description: task.description,
                assignee: assignment?.memberId || null,
                hasMessages: this.store.hasUnreadMessages(task.id),
                tokenUsage: tokenSummary || undefined,
              };
            }),
          };
        }),
      };
      return c.json(response);
    });

    // POST /api/stories
    this.app.post("/api/stories", async (c) => {
      const body = (await c.req.json()) as CreateStoryRequest;

      // Validate required fields
      if (!body.id || typeof body.id !== "string") {
        return c.json({ success: false, error: "Field 'id' is required and must be a string" } satisfies CreateStoryResponse, 400);
      }
      if (!body.title || typeof body.title !== "string") {
        return c.json({ success: false, error: "Field 'title' is required and must be a string" } satisfies CreateStoryResponse, 400);
      }
      if (!body.description || typeof body.description !== "string") {
        return c.json({ success: false, error: "Field 'description' is required and must be a string" } satisfies CreateStoryResponse, 400);
      }

      // Check for duplicate ID
      if (this.store.hasStory(body.id)) {
        return c.json({ success: false, error: `Story with id '${body.id}' already exists` } satisfies CreateStoryResponse, 409);
      }

      const status = body.status || "open";
      const dependsOn = body.dependsOn || [];

      const { story, tasks } = this.store.createStory(
        body.id,
        body.title,
        body.description,
        status,
        dependsOn,
        body.tasks,
        body.dir,
        body.workflow
      );

      const response: CreateStoryResponse = {
        success: true,
        story: {
          id: story.id,
          title: story.title,
          description: story.description,
          status: story.status,
          dependsOn: story.dependsOn,
          ready: this.store.isStoryReady(story.id),
          dir: story.dir,
          workflow: story.workflow,
          tasks: tasks.map((t) => ({
            id: t.id,
            seq: t.seq,
            title: t.title,
            status: t.status,
            assignee: null,
            hasMessages: false,
          })),
        },
      };
      return c.json(response, 201);
    });

    // GET /api/next-task
    this.app.get("/api/next-task", (c) => {
      const memberId = c.req.query("memberId");
      if (!memberId) return c.json({ task: null } satisfies NextTaskResponse);

      if (this.paused) return c.json({ task: null } satisfies NextTaskResponse);

      // Look up member's cwd to filter tasks by matching story dir
      const member = this.store.getMember(memberId);
      const memberCwd = member?.cwd;

      const task = this.store.getNextAvailableTask(memberCwd);
      if (!task) return c.json({ task: null } satisfies NextTaskResponse);

      // Get context from previous tasks in the same story
      const storyTasks = this.store.getTasksForStory(task.storyId);
      const previousResults = storyTasks
        .filter((t) => t.seq < task.seq && t.result)
        .map((t) => `[${t.title}]: ${t.result}`)
        .join("\n\n");

      const response: NextTaskResponse = {
        task: {
          id: task.id,
          storyId: task.storyId,
          title: task.title,
          description: task.description,
          context: previousResults || undefined,
        },
      };
      return c.json(response);
    });

    // POST /api/tasks/:taskId/claim
    this.app.post("/api/tasks/:taskId/claim", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as ClaimRequest;

      const task = this.store.getTask(taskId);
      const success = this.store.claimTask(taskId, body.memberId);
      if (success) {
        const fromStatus = task?.status || "todo";
        this.store.updateTaskStatus(taskId, "in_progress");
        this.store.updateMemberStatus(body.memberId, "working");

        // Get transition instructions
        const instructions = this.getInstructionsMarkdown(fromStatus, "in_progress");

        const response: ClaimResponse = { success, instructions };
        return c.json(response);
      }

      const response: ClaimResponse = {
        success,
        error: success ? undefined : "Task already claimed",
      };
      return c.json(response);
    });

    // POST /api/tasks/:taskId/status
    this.app.post("/api/tasks/:taskId/status", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as StatusUpdateRequest;

      const task = this.store.getTask(taskId);
      const fromStatus = task?.status || "";

      const check = this.store.canTransition(taskId, body.status, body.actor);
      if (!check.ok) {
        const response: StatusUpdateResponse = { success: false, error: check.error };
        return c.json(response, 403);
      }

      this.store.updateTaskStatus(taskId, body.status, body.result);

      // If task is done, release assignment and set member to idle
      if (body.status === "done" && body.memberId) {
        this.store.releaseTask(taskId);
        this.store.updateMemberStatus(body.memberId, "idle");
      }

      // Get transition instructions
      const instructions = this.getInstructionsMarkdown(fromStatus, body.status);

      const response: StatusUpdateResponse = { success: true, instructions };
      return c.json(response);
    });

    // POST /api/tasks/:taskId/message
    this.app.post("/api/tasks/:taskId/message", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as PostMessageRequest;

      this.store.addMessage(taskId, body.from, body.body);

      const response: PostMessageResponse = { success: true };
      return c.json(response);
    });

    // GET /api/tasks/:taskId/messages
    this.app.get("/api/tasks/:taskId/messages", (c) => {
      const taskId = c.req.param("taskId");
      const messages = this.store.getMessages(taskId);
      const response: MessagesResponse = { messages };
      return c.json(response);
    });

    // POST /api/tasks/:taskId/token-usage
    this.app.post("/api/tasks/:taskId/token-usage", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as TokenUsageRequest;

      if (typeof body.inputTokens !== 'number' || typeof body.outputTokens !== 'number' || !body.model) {
        return c.json({ success: false, error: "Fields inputTokens (number), outputTokens (number), and model (string) are required" } satisfies TokenUsageResponse, 400);
      }

      const task = this.store.getTask(taskId);
      if (!task) {
        return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies TokenUsageResponse, 404);
      }

      const costUsd = estimateTokenCost(body.model, body.inputTokens, body.outputTokens);
      this.store.addTokenUsage(taskId, body.inputTokens, body.outputTokens, body.model, costUsd);

      return c.json({ success: true, costUsd } satisfies TokenUsageResponse);
    });

    // POST /api/tasks/:taskId/mark-read
    this.app.post("/api/tasks/:taskId/mark-read", (c) => {
      const taskId = c.req.param("taskId");
      const task = this.store.getTask(taskId);
      if (!task) {
        return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);
      }
      this.store.markMessagesRead(taskId);
      return c.json({ success: true });
    });

    // POST /api/stories/:storyId/tasks
    this.app.post("/api/stories/:storyId/tasks", async (c) => {
      const storyId = c.req.param("storyId");
      const body = (await c.req.json()) as CreateTaskRequest;

      if (!body.title || typeof body.title !== "string") {
        return c.json({ success: false, error: "Field 'title' is required" } satisfies CreateTaskResponse, 400);
      }
      if (!body.description || typeof body.description !== "string") {
        return c.json({ success: false, error: "Field 'description' is required" } satisfies CreateTaskResponse, 400);
      }

      const story = this.store.getStory(storyId);
      if (!story) {
        return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies CreateTaskResponse, 404);
      }

      // Determine next sequence number
      const existingTasks = this.store.getTasksForStory(storyId);
      const nextSeq = existingTasks.length > 0
        ? Math.max(...existingTasks.map((t) => t.seq)) + 1
        : 1;
      const seqStr = String(nextSeq).padStart(2, "0");
      const slug = slugify(body.title);

      const tasksDir = path.join(story.dirPath, "tasks");
      const taskDirPath = path.join(tasksDir, `${seqStr}-${slug}`);
      fs.mkdirSync(taskDirPath, { recursive: true });

      const taskId = `${storyId}-${nextSeq}`;
      const taskData = {
        id: taskId,
        title: body.title,
        description: body.description,
        status: "todo",
        result: null,
      };
      fs.writeFileSync(path.join(taskDirPath, "task.json"), JSON.stringify(taskData, null, 2) + "\n");

      // Reload store
      this.store.loadFromDisk();

      const response: CreateTaskResponse = {
        success: true,
        task: { id: taskId, seq: nextSeq, title: body.title, description: body.description, status: "todo" },
      };
      return c.json(response, 201);
    });

    // PUT /api/tasks/:taskId
    this.app.put("/api/tasks/:taskId", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as UpdateTaskRequest;

      if (!body.title && !body.description) {
        return c.json({ success: false, error: "At least one of 'title' or 'description' is required" } satisfies UpdateTaskResponse, 400);
      }

      const task = this.store.getTask(taskId);
      if (!task) {
        return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies UpdateTaskResponse, 404);
      }

      this.store.updateTaskDetails(taskId, { title: body.title, description: body.description });
      return c.json({ success: true } satisfies UpdateTaskResponse);
    });

    // DELETE /api/tasks/:taskId
    this.app.delete("/api/tasks/:taskId", async (c) => {
      const taskId = c.req.param("taskId");

      const task = this.store.getTask(taskId);
      if (!task) {
        return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies DeleteTaskResponse, 404);
      }

      this.store.deleteTask(taskId);
      return c.json({ success: true } satisfies DeleteTaskResponse);
    });

    // POST /api/tasks/:taskId/move
    this.app.post("/api/tasks/:taskId/move", async (c) => {
      const taskId = c.req.param("taskId");
      const body = (await c.req.json()) as MoveTaskRequest;

      if (!body.status || typeof body.status !== "string") {
        return c.json({ success: false, error: "Field 'status' is required" } satisfies MoveTaskResponse, 400);
      }

      const task = this.store.getTask(taskId);
      if (!task) {
        return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies MoveTaskResponse, 404);
      }

      const check = this.store.canTransition(taskId, body.status, "lead");
      if (!check.ok) {
        return c.json({ success: false, error: check.error } satisfies MoveTaskResponse, 403);
      }

      const fromStatus = task.status;
      this.store.updateTaskStatus(taskId, body.status);

      // Get transition instructions
      const instructions = this.getInstructionsMarkdown(fromStatus, body.status);

      return c.json({ success: true, instructions } satisfies MoveTaskResponse);
    });

    // POST /api/team/join
    this.app.post("/api/team/join", async (c) => {
      const body = (await c.req.json()) as JoinRequest;
      this.store.registerMember(body.id, body.name, body.cwd, body.tmuxWindow);

      const response: JoinResponse = {
        success: true,
        config: {
          defaultWorkflow: this.config.defaultWorkflow,
          workflows: this.config.workflows,
          workflow: this.config.workflows[this.config.defaultWorkflow], // legacy compat
        },
      };
      return c.json(response);
    });

    // POST /api/team/heartbeat
    this.app.post("/api/team/heartbeat", async (c) => {
      const body = (await c.req.json()) as HeartbeatRequest;
      this.store.heartbeat(body.id, body.status);
      return c.json({ ok: true });
    });

    // GET /api/team
    this.app.get("/api/team", (c) => {
      const members = this.store.getMembers();
      const response: TeamResponse = {
        members: members.map((m) => {
          const assignment = this.store.getAssignmentForMember(m.id);
          return {
            id: m.id,
            name: m.name,
            status: m.status,
            currentTask: assignment?.taskId || null,
            tmuxWindow: m.tmuxWindow,
            lastHeartbeat: m.lastHeartbeat,
          };
        }),
      };
      return c.json(response);
    });

    // POST /api/team/spawn — spawn a new teammate
    this.app.post("/api/team/spawn", async (c) => {
      try {
        const body = await c.req.json() as { cwd?: string };
        let cwd = body.cwd || "";

        if (!cwd) {
          return c.json({ success: false, error: "Field 'cwd' is required" }, 400);
        }

        // Resolve path
        const resolvedCwd = cwd.startsWith("~")
          ? cwd.replace("~", process.env.HOME || "")
          : path.resolve(cwd);

        // Generate name
        const members = this.store.getMembers();
        const existingNames = new Set(members.map((m) => m.id));
        const name = generateTeammateName(existingNames, this.config.teammates);

        spawnTeammate(name, resolvedCwd, {
          session: this.config.tmuxSession,
          leaderUrl: this.config.leaderUrl,
        });

        return c.json({ success: true, name, cwd });
      } catch (e: any) {
        return c.json({ success: false, error: e.message }, 500);
      }
    });

    // GET /api/team/spawn-options — available directories for spawning
    this.app.get("/api/team/spawn-options", (c) => {
      const options: Array<{ dir: string; source: string; label?: string }> = [];

      // Story directories with available tasks
      const stories = this.store.getStories();
      for (const story of stories) {
        if (story.status !== "open" || !story.dir) continue;
        const tasks = this.store.getTasksForStory(story.id);
        if (tasks.some((t) => t.status === "todo")) {
          if (!options.some((o) => o.dir === story.dir)) {
            options.push({ dir: story.dir, source: "story", label: story.title });
          }
        }
      }

      // Favorite directories
      const favorites = this.config.teammates?.favoriteDirectories || [];
      for (const dir of favorites) {
        if (!options.some((o) => o.dir === dir)) {
          options.push({ dir, source: "favorite" });
        }
      }

      return c.json({ options });
    });

    // --- Delete story endpoint ---

    // DELETE /api/stories/:id
    this.app.delete("/api/stories/:id", async (c) => {
      const storyId = c.req.param("id");
      const story = this.store.getStory(storyId);
      if (!story) {
        return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies DeleteStoryResponse, 404);
      }
      try {
        this.store.deleteStory(storyId);
        return c.json({ success: true } satisfies DeleteStoryResponse);
      } catch (e: any) {
        return c.json({ success: false, error: e.message } satisfies DeleteStoryResponse, 400);
      }
    });

    // --- Archive endpoints ---

    // POST /api/stories/:id/archive
    this.app.post("/api/stories/:id/archive", (c) => {
      const storyId = c.req.param("id");
      const story = this.store.getStory(storyId);
      if (!story) {
        return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies ArchiveStoryResponse, 404);
      }
      if (!this.store.isStoryArchivable(storyId)) {
        return c.json({ success: false, error: "Cannot archive: not all tasks are done" } satisfies ArchiveStoryResponse, 400);
      }
      try {
        this.store.archiveStory(storyId);
        // Read back the generated synopsis
        const archived = this.store.getArchivedStories().find(s => s.id === storyId);
        return c.json({ success: true, synopsis: archived?.synopsis || "" } satisfies ArchiveStoryResponse);
      } catch (e: any) {
        return c.json({ success: false, error: e.message } satisfies ArchiveStoryResponse, 400);
      }
    });

    // GET /api/archived
    this.app.get("/api/archived", (c) => {
      const stories = this.store.getArchivedStories();
      const response: ArchivedStoriesResponse = {
        stories: stories.map(s => {
          // Read archivedAt from story.json
          const ctx = this.store.getArchivedStoryContext(s.id);
          return {
            id: s.id,
            title: s.title,
            archivedAt: ctx?.story?.archivedAt || "",
            synopsis: s.synopsis,
          };
        }),
      };
      return c.json(response);
    });

    // POST /api/archived/:id/enrich
    this.app.post("/api/archived/:id/enrich", (c) => {
      const storyId = c.req.param("id");
      const context = this.store.getArchivedStoryContext(storyId);
      if (!context) {
        return c.json({ success: false, error: `Archived story "${storyId}" not found` }, 404);
      }

      const { story, tasks, messages } = context;
      const date = story.archivedAt ? story.archivedAt.split("T")[0] : "Unknown";

      // Build enriched synopsis: base info + tasks + summary paragraph
      const lines: string[] = [
        `# ${story.title}`,
        "",
        `**Archived**: ${date}`,
        `**ID**: ${story.id}`,
        "",
        "## Description",
        "",
        story.description,
        "",
        "## Tasks",
        "",
      ];

      for (let i = 0; i < tasks.length; i++) {
        lines.push(`${i + 1}. ${tasks[i].title}`);
      }
      lines.push("");

      // Generate summary paragraph
      const totalMessages = Object.values(messages).reduce((sum, msgs) => sum + msgs.length, 0);
      lines.push("## Summary");
      lines.push("");
      let summary = `This story completed ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
      if (totalMessages > 0) {
        summary += ` with ${totalMessages} message${totalMessages === 1 ? "" : "s"} exchanged between the team lead and teammates`;
      }
      summary += ".";
      lines.push(summary);
      lines.push("");

      const enrichedContent = lines.join("\n");
      this.store.writeArchivedSynopsis(storyId, enrichedContent);

      return c.json({ success: true, synopsis: enrichedContent });
    });

    // --- Config endpoints ---

    // GET /api/config — read current config
    this.app.get("/api/config", (c) => {
      return c.json(this.config);
    });

    // GET /api/browse?path=... — list subdirectories for file browser
    this.app.get("/api/browse", (c) => {
      let browsePath = c.req.query("path") || "~";
      if (browsePath.startsWith("~")) {
        browsePath = browsePath.replace("~", process.env.HOME || "/root");
      }
      browsePath = path.resolve(browsePath);

      try {
        if (!fs.existsSync(browsePath) || !fs.statSync(browsePath).isDirectory()) {
          return c.json({ path: browsePath, dirs: [], error: "Not a directory" }, 400);
        }
        const entries = fs.readdirSync(browsePath, { withFileTypes: true });
        const dirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith("."))
          .map(e => e.name)
          .sort();
        // Show path with ~ for home dir
        const displayPath = browsePath.startsWith(process.env.HOME || "")
          ? browsePath.replace(process.env.HOME || "", "~")
          : browsePath;
        return c.json({ path: displayPath, resolved: browsePath, dirs });
      } catch (e: any) {
        return c.json({ path: browsePath, dirs: [], error: e.message }, 400);
      }
    });

    // PUT /api/config — update config and write to disk
    this.app.put("/api/config", async (c) => {
      try {
        const body = await c.req.json();

        // Validate required fields
        if (!body.workflows || typeof body.workflows !== "object" || Object.keys(body.workflows).length === 0) {
          return c.json({ success: false, error: "At least one workflow is required" }, 400);
        }
        if (!body.defaultWorkflow || !body.workflows[body.defaultWorkflow]) {
          return c.json({ success: false, error: "defaultWorkflow must reference an existing workflow" }, 400);
        }

        // Update in-memory config
        this.config.port = body.port || this.config.port;
        this.config.tmuxSession = body.tmuxSession || this.config.tmuxSession;
        this.config.maxTeammates = body.maxTeammates || this.config.maxTeammates;
        this.config.defaultWorkflow = body.defaultWorkflow;
        this.config.workflows = body.workflows;
        if (body.autosave) {
          this.config.autosave = {
            flushIntervalMinutes: body.autosave.flushIntervalMinutes || 30,
            commitIntervalHours: body.autosave.commitIntervalHours || 24,
            commitMessage: body.autosave.commitMessage || this.config.autosave.commitMessage,
            autoCommit: body.autosave.autoCommit !== false,
          };
        }
        if (body.teammates !== undefined) {
          this.config.teammates = body.teammates;
        }

        // Write to disk (exclude runtime-only fields)
        const configFile = path.join(this.teamDir, "config.json");
        const toWrite: Record<string, any> = {
          port: this.config.port,
          tmuxSession: this.config.tmuxSession,
          defaultWorkflow: this.config.defaultWorkflow,
          workflows: this.config.workflows,
          autosave: this.config.autosave,
          leaderUrl: this.config.leaderUrl,
          maxTeammates: this.config.maxTeammates,
        };
        if (this.config.teammates && Object.keys(this.config.teammates).length > 0) {
          toWrite.teammates = this.config.teammates;
        }
        fs.writeFileSync(configFile, JSON.stringify(toWrite, null, 2) + "\n");

        return c.json({ success: true });
      } catch (e: any) {
        return c.json({ success: false, error: e.message }, 400);
      }
    });

    // Control endpoints
    this.app.post("/api/control/pause", (c) => {
      this.paused = true;
      return c.json({ paused: true });
    });

    this.app.post("/api/control/resume", (c) => {
      this.paused = false;
      return c.json({ paused: false });
    });
  }

  async start(): Promise<void> {
    this.server = serve({ fetch: this.app.fetch, port: this.config.port });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  isPaused(): boolean {
    return this.paused;
  }
}
