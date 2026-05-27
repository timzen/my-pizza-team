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
import { BOARD_HTML } from "./board.js";
import { ARCHIVED_HTML } from "./archived-page.js";
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
  private paused = false;

  constructor(store: Store, config: TeamConfig) {
    this.store = store;
    this.config = config;
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Landing page
    this.app.get("/", (c) => {
      return c.html(`<!DOCTYPE html>
<html><head><title>🍕 pi-pizza-team</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; background: #1a1a2e; color: #e0e0e0; }
  h1 { font-size: 2em; }
  a { color: #7c83ff; }
  .status { background: #16213e; padding: 16px; border-radius: 8px; margin: 20px 0; }
  code { background: #0f3460; padding: 2px 6px; border-radius: 4px; }
</style></head><body>
<h1>🍕 pi-pizza-team</h1>
<p>The team lead API is running.</p>
<div class="status" id="status">Loading...</div>
<h3>API Endpoints</h3>
<ul>
  <li><a href="/api/status">/api/status</a> — Server status</li>
  <li><a href="/api/stories">/api/stories</a> — All stories</li>
  <li><a href="/api/team">/api/team</a> — Team members</li>
  <li><a href="/board">/board</a> — Kanban board</li>
  <li><a href="/archived">/archived</a> — Archived stories</li>
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
        workflow: this.config.workflow,
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
        body.dir
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
        const { exitInstructions, enterInstructions } = this.store.getTransitionInstructions(fromStatus, "in_progress");
        const parts: string[] = [];
        if (exitInstructions) parts.push(exitInstructions);
        if (enterInstructions) parts.push(enterInstructions);
        const instructions = parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;

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
      const { exitInstructions, enterInstructions } = this.store.getTransitionInstructions(fromStatus, body.status);
      const parts: string[] = [];
      if (exitInstructions) parts.push(exitInstructions);
      if (enterInstructions) parts.push(enterInstructions);
      const instructions = parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;

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
      const slug = body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

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
      const { exitInstructions, enterInstructions } = this.store.getTransitionInstructions(fromStatus, body.status);
      const parts: string[] = [];
      if (exitInstructions) parts.push(exitInstructions);
      if (enterInstructions) parts.push(enterInstructions);
      const instructions = parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;

      return c.json({ success: true, instructions } satisfies MoveTaskResponse);
    });

    // POST /api/team/join
    this.app.post("/api/team/join", async (c) => {
      const body = (await c.req.json()) as JoinRequest;
      this.store.registerMember(body.id, body.name, body.cwd, body.tmuxWindow);

      const response: JoinResponse = {
        success: true,
        config: { workflow: this.config.workflow },
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

      // Generate enriched synopsis with full detail
      const lines: string[] = [
        `# ${story.title}`,
        "",
        `**Archived**: ${date}`,
        `**ID**: ${story.id}`,
        `**Tasks**: ${tasks.length} completed`,
        "",
        "## Description",
        "",
        story.description,
        "",
        "## Tasks Completed",
        "",
      ];

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        lines.push(`### ${i + 1}. ${task.title}`);
        lines.push("");
        lines.push(task.description);
        lines.push("");
        if (task.result) {
          lines.push(`**Result**: ${task.result}`);
          lines.push("");
        }

        // Include message highlights
        const taskMessages = messages[task.id];
        if (taskMessages && taskMessages.length > 0) {
          lines.push(`<details><summary>💬 ${taskMessages.length} message${taskMessages.length === 1 ? "" : "s"}</summary>`);
          lines.push("");
          for (const msg of taskMessages) {
            const time = msg.at ? msg.at.split("T")[0] : "";
            const sender = msg.from === "lead" ? "Lead" : msg.from;
            lines.push(`> **${sender}** (${time}): ${msg.body}`);
            lines.push("");
          }
          lines.push(`</details>`);
          lines.push("");
        }
      }

      lines.push("## Summary");
      lines.push("");
      lines.push(`${tasks.length} task${tasks.length === 1 ? "" : "s"} completed for this story.`);
      const totalMessages = Object.values(messages).reduce((sum, msgs) => sum + msgs.length, 0);
      if (totalMessages > 0) {
        lines.push(`${totalMessages} message${totalMessages === 1 ? "" : "s"} exchanged during execution.`);
      }
      lines.push("");

      const enrichedContent = lines.join("\n");
      this.store.writeArchivedSynopsis(storyId, enrichedContent);

      return c.json({ success: true, synopsis: enrichedContent });
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
