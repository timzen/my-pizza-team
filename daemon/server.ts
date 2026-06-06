/**
 * daemon/server.ts — HTTP API server for the team lead (Deno port).
 *
 * Serves the REST API for teammates and the lead. Built with Hono on Deno.serve().
 * Ported from pi-pizza-team/src/lead/server.ts, minus the web UI assets
 * (those will be added separately).
 *
 * Key behaviors:
 * - Enforces workflow permissions on status updates (403 if unauthorized)
 * - Task distribution can be paused/resumed via /api/control/* endpoints
 * - Transition instructions are returned on status changes
 */

import { Hono } from "hono";
import { Store } from "./store.ts";
import { getDoneState, getInitialState, slugify, type TeamConfig, type WorkflowConfig } from "../shared/types.ts";
import { createAuthMiddleware, resolveToken } from "./auth.ts";
import type {
  StatusResponse, StoriesResponse, NextTaskResponse, ClaimRequest, ClaimResponse,
  StatusUpdateRequest, StatusUpdateResponse, PostCommentRequest, PostCommentResponse,
  CommentsResponse, JoinRequest, JoinResponse, HeartbeatRequest, TeamResponse,
  CreateStoryRequest, CreateStoryResponse, CreateTaskRequest, CreateTaskResponse,
  UpdateTaskRequest, UpdateTaskResponse, UpdateStoryRequest, UpdateStoryResponse,
  DeleteTaskResponse, MoveTaskRequest, MoveTaskResponse, TokenUsageRequest,
  TokenUsageResponse, DeleteStoryResponse, ArchiveStoryResponse, ArchivedStoriesResponse,
} from "../shared/protocol.ts";
import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";
import { resolveDistDir, staticMiddleware } from "./static.ts";

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
  let costs = MODEL_COSTS[model];
  if (!costs) {
    const key = Object.keys(MODEL_COSTS).find(k => model.startsWith(k) || model.includes(k));
    costs = key ? MODEL_COSTS[key] : { input: 3.0, output: 15.0 };
  }
  const c = costs ?? { input: 3.0, output: 15.0 };
  return (inputTokens * c.input + outputTokens * c.output) / 1_000_000;
}

/** Validate that an ID is safe for use in filesystem paths */
function isSafeId(id: string): boolean {
  if (!id || id.length > 100) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  if (id.startsWith(".") || id.startsWith("-")) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
}

/** Build the Hono app with all API routes wired to the store */
export function buildApp(store: Store, config: TeamConfig, teamDir: string): Hono {
  const app = new Hono();
  let paused = false;
  const startedAt = Date.now();

  // Apply auth middleware if a token is configured
  const token = resolveToken(config.apiToken);
  const authMiddleware = createAuthMiddleware(token);
  if (authMiddleware) {
    app.use("*", authMiddleware);
  }

  // Serve static UI files if dist directory exists
  const distDir = resolveDistDir();
  if (distDir) {
    app.use("*", staticMiddleware(distDir));
  }

  /** Assemble transition instructions into markdown */
  function getInstructionsMarkdown(fromStatus: string, toStatus: string, taskId?: string): string | undefined {
    let workflowName: string | undefined;
    if (taskId) {
      const task = store.getTask(taskId);
      if (task) {
        const story = store.getStory(task.storyId);
        workflowName = story?.workflow || config.defaultWorkflow;
      }
    }
    const { exitInstructions, enterInstructions } = store.getTransitionInstructions(fromStatus, toStatus, workflowName);
    const parts: string[] = [];
    if (exitInstructions) parts.push(`## Transition: leaving "${fromStatus}"\n\n${exitInstructions}`);
    if (enterInstructions) parts.push(`## Transition: entering "${toStatus}"\n\n${enterInstructions}`);
    return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
  }

  /**
   * GET /health — Enhanced health check.
   * Returns daemon status with operational metrics:
   * - uptime: seconds since daemon started
   * - agents: count of connected (online) agents
   * - queueDepth: number of pending tasks in the assistant queue
   * - memory: heap/rss usage from Deno.memoryUsage()
   * - lastCommitTime: ISO timestamp of last git commit in teamDir (or null)
   * Called by: CLI `mpt status`, monitoring tools, desktop tray icon.
   */
  app.get("/health", async (c) => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

    // Count online agents
    const members = store.getMembers();
    const onlineAgents = members.filter(m => m.status === "working" || m.status === "idle").length;

    // Queue depth: pending items in assistant queue
    const queue = store.getAssistantQueue();
    const queueDepth = queue.filter(item => item.status === "pending").length;

    // Memory usage
    const mem = Deno.memoryUsage();

    // Last git commit time in teamDir
    let lastCommitTime: string | null = null;
    try {
      const cmd = new Deno.Command("git", {
        args: ["log", "-1", "--format=%aI"],
        cwd: teamDir,
        stdout: "piped",
        stderr: "null",
      });
      const result = await cmd.output();
      if (result.code === 0) {
        const output = new TextDecoder().decode(result.stdout).trim();
        if (output) lastCommitTime = output;
      }
    } catch {
      // git not available or not a repo — leave null
    }

    return c.json({
      status: "ok",
      service: "my-pizza-team",
      uptime: uptimeSeconds,
      agents: onlineAgents,
      queueDepth,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      lastCommitTime,
    });
  });

  /**
   * GET /api/status — Dashboard summary.
   * Returns aggregate counts of stories, tasks (by status), team members,
   * and inbox items. Used by the UI dashboard and CLI to show a quick overview.
   */
  app.get("/api/status", (c) => {
    const stories = store.getStories();
    const allTasks: Record<string, number> = {};
    let totalTasks = 0;
    for (const story of stories) {
      for (const task of store.getTasksForStory(story.id)) {
        allTasks[task.status] = (allTasks[task.status] || 0) + 1;
        totalTasks++;
      }
    }
    const members = store.getMembers();
    const inbox = store.getInboxTasks();
    const response: StatusResponse = {
      running: true,
      stories: { total: stories.length, open: stories.filter(s => s.status === "open").length, done: stories.filter(s => s.status === "done").length },
      tasks: { total: totalTasks, byStatus: allTasks },
      members: { total: members.length, working: members.filter(m => m.status === "working").length, idle: members.filter(m => m.status === "idle").length },
      inbox: inbox.length,
      defaultWorkflow: config.defaultWorkflow,
      workflows: store.getWorkflows(),
      workflow: store.getWorkflows()[config.defaultWorkflow],
    };
    return c.json(response);
  });

  /**
   * GET /api/stories — List all active stories with their tasks.
   * Returns the full board state: each story with its tasks, assignees,
   * unread comment flags, and token usage. Used by the UI board view
   * and CLI to display current work.
   */
  app.get("/api/stories", (c) => {
    const stories = store.getStories();
    const response: StoriesResponse = {
      stories: stories.map(story => {
        const tasks = store.getTasksForStory(story.id);
        return {
          id: story.id, title: story.title, description: story.description,
          status: story.status, dependsOn: story.dependsOn,
          ready: store.isStoryReady(story.id), dir: story.dir,
          workflow: story.workflow, categories: story.categories,
          tasks: tasks.map(task => {
            const assignment = store.getAssignment(task.id);
            const tokenSummary = store.getTokenUsageSummary(task.id);
            return { id: task.id, seq: task.seq, title: task.title, status: task.status, description: task.description, assignee: assignment?.memberId || null, hasComments: store.hasUnreadComments(task.id), tokenUsage: tokenSummary || undefined };
          }),
        };
      }),
    };
    return c.json(response);
  });

  /**
   * POST /api/stories — Create a new story (with optional tasks).
   * The lead uses this to define new work. Creates the story directory on disk,
   * writes story.json, and optionally creates task subdirectories. Tasks start
   * in the workflow's initial state.
   */
  app.post("/api/stories", async (c) => {
    const body = (await c.req.json()) as CreateStoryRequest;
    if (!body.id || typeof body.id !== "string") return c.json({ success: false, error: "Field 'id' is required" } satisfies CreateStoryResponse, 400);
    if (!isSafeId(body.id)) return c.json({ success: false, error: "Invalid story ID" } satisfies CreateStoryResponse, 400);
    if (!body.title || typeof body.title !== "string") return c.json({ success: false, error: "Field 'title' is required" } satisfies CreateStoryResponse, 400);
    if (!body.description || typeof body.description !== "string") return c.json({ success: false, error: "Field 'description' is required" } satisfies CreateStoryResponse, 400);
    if (store.hasStory(body.id)) return c.json({ success: false, error: `Story '${body.id}' already exists` } satisfies CreateStoryResponse, 409);

    const { story, tasks } = store.createStory(body.id, body.title, body.description, body.status || "open", body.dependsOn || [], body.tasks, body.dir, body.workflow, body.categories);
    return c.json({ success: true, story: { id: story.id, title: story.title, description: story.description, status: story.status, dependsOn: story.dependsOn, ready: store.isStoryReady(story.id), dir: story.dir, workflow: story.workflow, categories: story.categories, tasks: tasks.map(t => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, assignee: null, hasComments: false })) } } satisfies CreateStoryResponse, 201);
  });

  /**
   * PUT /api/stories/:id — Update story metadata.
   * Allows the lead to change title, description, status, dependencies,
   * working directory, workflow, or categories. Writes changes to disk.
   */
  app.put("/api/stories/:id", async (c) => {
    const storyId = c.req.param("id");
    const body = (await c.req.json()) as UpdateStoryRequest;
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies UpdateStoryResponse, 404);
    store.updateStoryDetails(storyId, { title: body.title, description: body.description, status: body.status, dependsOn: body.dependsOn, dir: body.dir, workflow: body.workflow, categories: body.categories });
    return c.json({ success: true } satisfies UpdateStoryResponse);
  });

  /**
   * DELETE /api/stories/:id — Delete a story and all its tasks.
   * Removes from SQLite and disk. Fails if any tasks are in_progress
   * (prevents data loss from active work).
   */
  app.delete("/api/stories/:id", (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies DeleteStoryResponse, 404);
    try { store.deleteStory(storyId); return c.json({ success: true } satisfies DeleteStoryResponse); }
    catch (e) { return c.json({ success: false, error: (e as Error).message } satisfies DeleteStoryResponse, 400); }
  });

  /**
   * GET /api/next-task?memberId=X — Get the next available task for a teammate.
   * Finds the first unclaimed task in a ready story (dependencies met) whose
   * working directory matches the member's cwd. Returns task details plus
   * context from previously completed tasks in the same story. Used by the
   * teammate skill to poll for work.
   */
  app.get("/api/next-task", (c) => {
    const memberId = c.req.query("memberId");
    if (!memberId || paused) return c.json({ task: null } satisfies NextTaskResponse);

    const member = store.getMember(memberId);
    const task = store.getNextAvailableTask(member?.cwd);
    if (!task) return c.json({ task: null } satisfies NextTaskResponse);

    const storyTasks = store.getTasksForStory(task.storyId);
    const previousResults = storyTasks.filter(t => t.seq < task.seq && t.result).map(t => `[${t.title}]: ${t.result}`).join("\n\n");
    const wf = store.getWorkflowForStory(task.storyId);
    return c.json({ task: { id: task.id, storyId: task.storyId, title: task.title, description: task.description, context: previousResults || undefined, workflow: wf } } satisfies NextTaskResponse);
  });

  /**
   * POST /api/tasks/:taskId/claim — Claim a task (teammate takes ownership).
   * Assigns the task to the member, transitions it to in_progress, and marks
   * the member as working. Returns transition instructions if configured.
   * Used by teammates after receiving a task from next-task.
   */
  app.post("/api/tasks/:taskId/claim", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as ClaimRequest;
    const task = store.getTask(taskId);
    const success = store.claimTask(taskId, body.memberId);
    if (success) {
      const fromStatus = task?.status || "todo";
      store.updateTaskStatus(taskId, "in_progress");
      store.updateMemberStatus(body.memberId, "working");
      return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, "in_progress", taskId) } satisfies ClaimResponse);
    }
    return c.json({ success: false, error: "Task already claimed" } satisfies ClaimResponse);
  });

  /**
   * POST /api/tasks/:taskId/status — Update task status (workflow-enforced).
   * Validates the transition against the workflow's permission rules (lead vs
   * teammate). On success, updates status and optionally stores a result summary.
   * If the task reaches the done state, releases the assignment. Returns
   * transition instructions for the new state.
   */
  app.post("/api/tasks/:taskId/status", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as StatusUpdateRequest;
    const task = store.getTask(taskId);
    const fromStatus = task?.status || "";
    const check = store.canTransition(taskId, body.status, body.actor);
    if (!check.ok) return c.json({ success: false, error: check.error } satisfies StatusUpdateResponse, 403);

    store.updateTaskStatus(taskId, body.status, body.result);
    const wf = task ? store.getWorkflowForTask(taskId) : null;
    const doneState = wf ? getDoneState(wf) : "done";
    if (body.status === doneState && body.memberId) {
      store.releaseTask(taskId);
      store.updateMemberStatus(body.memberId, "idle");
    }
    return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, body.status, taskId) } satisfies StatusUpdateResponse);
  });

  /**
   * POST /api/tasks/:taskId/comment — Post a comment on a task.
   * Appends a comment to the task's JSONL log. Used for lead↔teammate
   * communication: asking questions, giving feedback in review,
   * or providing additional context.
   */
  app.post("/api/tasks/:taskId/comment", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as PostCommentRequest;
    store.addComment(taskId, body.from, body.body, body.attachments);
    return c.json({ success: true } satisfies PostCommentResponse);
  });

  /**
   * GET /api/tasks/:taskId/comments — Get all comments for a task.
   * Returns the full conversation history from the JSONL file.
   * Used by UI and teammates to read feedback or instructions.
   */
  app.get("/api/tasks/:taskId/comments", (c) => {
    const taskId = c.req.param("taskId");
    return c.json({ comments: store.getComments(taskId) } satisfies CommentsResponse);
  });

  /**
   * POST /api/tasks/:taskId/attachments — Upload a file attachment to a task.
   * Saves the file to the task's attachments/ directory. Used by teammates
   * to share diffs, screenshots, or other artifacts for lead review.
   */
  app.post("/api/tasks/:taskId/attachments", async (c) => {
    const taskId = c.req.param("taskId");
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    const body = await c.req.json() as { name: string; content: string; encoding?: string };
    if (!body.name || !body.content) {
      return c.json({ success: false, error: "Fields 'name' and 'content' are required" }, 400);
    }

    // Support base64 encoding for binary files (images, etc.)
    let data: string | Uint8Array = body.content;
    if (body.encoding === "base64") {
      const binaryString = atob(body.content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      data = bytes;
    }

    const storedName = store.saveAttachment(taskId, body.name, data);
    if (!storedName) {
      return c.json({ success: false, error: "Failed to save attachment" }, 500);
    }

    // Determine file type from extension
    const ext = body.name.split(".").pop()?.toLowerCase() || "";
    const typeMap: Record<string, string> = { diff: "diff", patch: "diff", md: "markdown", txt: "text", json: "json", png: "image", jpg: "image", jpeg: "image" };
    const type = typeMap[ext] || "other";

    return c.json({ success: true, storedName, type, size: body.content.length });
  });

  /**
   * GET /api/tasks/:taskId/attachments — List attachments for a task.
   */
  app.get("/api/tasks/:taskId/attachments", (c) => {
    const taskId = c.req.param("taskId");
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);
    return c.json({ attachments: store.getAttachments(taskId) });
  });

  /**
   * GET /api/tasks/:taskId/attachments/:filename — Download an attachment.
   */
  app.get("/api/tasks/:taskId/attachments/:filename", (c) => {
    const taskId = c.req.param("taskId");
    const filename = c.req.param("filename");
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "Task not found", taskId }, 404);
    const filePath = store.getAttachmentPath(taskId, filename);
    if (!filePath) return c.json({ error: "Attachment not found", taskId, filename, taskDir: task.dirPath }, 404);

    const content = Deno.readFileSync(filePath);
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const mimeTypes: Record<string, string> = {
      diff: "text/x-diff", patch: "text/x-diff", md: "text/markdown",
      txt: "text/plain", json: "application/json",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    };
    return new Response(content, {
      headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
    });
  });

  /**
   * POST /api/tasks/:taskId/token-usage — Record token usage for a task.
   * Teammates report LLM token consumption after each API call. The daemon
   * estimates USD cost from a model pricing table. Used for cost tracking
   * and budget monitoring.
   */
  app.post("/api/tasks/:taskId/token-usage", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as TokenUsageRequest;
    if (typeof body.inputTokens !== "number" || typeof body.outputTokens !== "number" || !body.model) {
      return c.json({ success: false, error: "Fields inputTokens, outputTokens, model required" } satisfies TokenUsageResponse, 400);
    }
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies TokenUsageResponse, 404);
    const costUsd = estimateTokenCost(body.model, body.inputTokens, body.outputTokens);
    store.addTokenUsage(taskId, body.inputTokens, body.outputTokens, body.model, costUsd);
    return c.json({ success: true, costUsd } satisfies TokenUsageResponse);
  });

  /**
   * POST /api/tasks/:taskId/mark-read — Mark comments as read.
   * Updates the read timestamp so hasUnreadComments() returns false.
   * Called by the lead UI when viewing a task's comments.
   */
  app.post("/api/tasks/:taskId/mark-read", (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);
    store.markCommentsRead(taskId);
    return c.json({ success: true });
  });

  /**
   * POST /api/stories/:storyId/tasks — Add a new task to an existing story.
   * Creates the task directory, writes task.json, and reloads from disk.
   * The task gets the next sequential number and starts in the workflow's
   * initial state. Used by the lead to break down work further.
   */
  app.post("/api/stories/:storyId/tasks", async (c) => {
    const storyId = c.req.param("storyId");
    const body = (await c.req.json()) as CreateTaskRequest;
    if (!body.title) return c.json({ success: false, error: "Field 'title' is required" } satisfies CreateTaskResponse, 400);
    if (!body.description) return c.json({ success: false, error: "Field 'description' is required" } satisfies CreateTaskResponse, 400);
    const story = store.getStory(storyId);
    if (!story) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies CreateTaskResponse, 404);

    const existingTasks = store.getTasksForStory(storyId);
    const nextSeq = existingTasks.length > 0 ? Math.max(...existingTasks.map(t => t.seq)) + 1 : 1;
    const slug = slugify(body.title);
    const taskDirPath = path.join(story.dirPath, "tasks", `${String(nextSeq).padStart(2, "0")}-${slug}`);
    Deno.mkdirSync(taskDirPath, { recursive: true });

    const taskId = `${storyId}-${nextSeq}`;
    const wf = store.getWorkflowForStory(storyId);
    const initialStatus = getInitialState(wf);
    const taskData = { id: taskId, title: body.title, description: body.description, status: initialStatus, result: null };
    Deno.writeTextFileSync(path.join(taskDirPath, "task.json"), JSON.stringify(taskData, null, 2) + "\n");
    store.loadFromDisk();

    return c.json({ success: true, task: { id: taskId, seq: nextSeq, title: body.title, description: body.description, status: initialStatus } } satisfies CreateTaskResponse, 201);
  });

  /**
   * PUT /api/tasks/:taskId — Update task title or description.
   * Allows the lead to refine task details before or during work.
   * Marks the task dirty for the next flush-to-disk cycle.
   */
  app.put("/api/tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as UpdateTaskRequest;
    if (!body.title && !body.description) return c.json({ success: false, error: "At least one field required" } satisfies UpdateTaskResponse, 400);
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies UpdateTaskResponse, 404);
    store.updateTaskDetails(taskId, { title: body.title, description: body.description });
    return c.json({ success: true } satisfies UpdateTaskResponse);
  });

  /**
   * DELETE /api/tasks/:taskId — Delete a task.
   * Removes the task from SQLite and deletes its directory from disk.
   * Used by the lead to remove unnecessary or duplicate tasks.
   */
  app.delete("/api/tasks/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies DeleteTaskResponse, 404);
    store.deleteTask(taskId);
    return c.json({ success: true } satisfies DeleteTaskResponse);
  });

  /**
   * POST /api/tasks/:taskId/move — Lead moves a task to a new status.
   * Similar to /status but always uses "lead" as the actor. Useful for
   * the lead to approve reviews (review→done) or send tasks back
   * (needs_input→in_progress). Returns transition instructions.
   */
  app.post("/api/tasks/:taskId/move", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as MoveTaskRequest;
    if (!body.status) return c.json({ success: false, error: "Field 'status' is required" } satisfies MoveTaskResponse, 400);
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies MoveTaskResponse, 404);
    const check = store.canTransition(taskId, body.status, "lead");
    if (!check.ok) return c.json({ success: false, error: check.error } satisfies MoveTaskResponse, 403);
    const fromStatus = task.status;
    store.updateTaskStatus(taskId, body.status);
    return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, body.status, taskId) } satisfies MoveTaskResponse);
  });

  /**
   * POST /api/team/join — Register a new teammate.
   * Called when a teammate agent starts up. Registers it in the members
   * table and returns the workflow configuration so the teammate knows
   * what states and transitions are available.
   */
  app.post("/api/team/join", async (c) => {
    const body = (await c.req.json()) as JoinRequest;
    store.registerMember(body.id, body.name, body.cwd, body.tmuxWindow, body.hostId);
    return c.json({ success: true, config: { defaultWorkflow: config.defaultWorkflow, workflows: store.getWorkflows(), workflow: store.getWorkflows()[config.defaultWorkflow] } } satisfies JoinResponse);
  });

  /**
   * POST /api/team/heartbeat — Teammate heartbeat.
   * Called periodically by teammates to confirm they're still alive.
   * Updates status and last_heartbeat timestamp. Used to detect
   * crashed teammates (stale heartbeats → offline status).
   */
  app.post("/api/team/heartbeat", async (c) => {
    const body = (await c.req.json()) as HeartbeatRequest;
    store.heartbeat(body.id, body.status);
    return c.json({ ok: true });
  });

  /**
   * GET /api/team — List all registered team members.
   * Returns each member's status, current task assignment, and heartbeat.
   * Used by the UI team panel and lead to monitor agent health.
   */
  app.get("/api/team", (c) => {
    const members = store.getMembers();
    const response: TeamResponse = { members: members.map(m => { const a = store.getAssignmentForMember(m.id); return { id: m.id, name: m.name, status: m.status, currentTask: a?.taskId || null, tmuxWindow: m.tmuxWindow, lastHeartbeat: m.lastHeartbeat }; }) };
    return c.json(response);
  });

  /**
   * POST /api/stories/:id/archive — Archive a completed story.
   * Moves the story directory from stories/ to archived/, generates a
   * SYNOPSIS.md summary, and removes from SQLite. Only works when all
   * tasks are in their done state. Keeps completed work for reference.
   */
  app.post("/api/stories/:id/archive", (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies ArchiveStoryResponse, 404);
    if (!store.isStoryArchivable(storyId)) return c.json({ success: false, error: "Not all tasks are done" } satisfies ArchiveStoryResponse, 400);
    try { store.archiveStory(storyId); const archived = store.getArchivedStories().find(s => s.id === storyId); return c.json({ success: true, synopsis: archived?.synopsis || "" } satisfies ArchiveStoryResponse); }
    catch (e) { return c.json({ success: false, error: (e as Error).message } satisfies ArchiveStoryResponse, 400); }
  });

  /**
   * GET /api/archived — List archived stories.
   * Returns ID, title, archived date, and synopsis for each archived story.
   * Used by the UI archive view to browse past work.
   */
  app.get("/api/archived", (c) => {
    const stories = store.getArchivedStories();
    const response: ArchivedStoriesResponse = { stories: stories.map(s => { const ctx = store.getArchivedStoryContext(s.id); return { id: s.id, title: s.title, archivedAt: (ctx?.story?.archivedAt as string) || "", synopsis: s.synopsis }; }) };
    return c.json(response);
  });

  // --- Assistant Queue ---
  // The assistant queue allows the lead to enqueue prompts for a human or
  // AI assistant to process asynchronously (research, complex decisions, etc.)

  /**
   * GET /api/assistant/queue — List all assistant queue items.
   * Returns the full queue with status (pending/processing/done/failed).
   */
  app.get("/api/assistant/queue", (c) => {
    const items = store.getAssistantQueue();
    return c.json({ items: items.map(item => ({ id: item.id, prompt: item.prompt, status: item.status, result: item.result || undefined, createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(), startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : undefined, completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : undefined })) });
  });

  /**
   * POST /api/assistant/queue — Enqueue a new assistant item.
   * The lead posts a prompt (question/research request) for async processing.
   */
  app.post("/api/assistant/queue", async (c) => {
    const body = await c.req.json();
    if (!body.prompt || typeof body.prompt !== "string") return c.json({ success: false, error: "Field 'prompt' is required" }, 400);
    const item = store.enqueueAssistantItem(body.prompt);
    return c.json({ success: true, item }, 201);
  });

  /**
   * GET /api/assistant/next — Get the next pending item to process.
   * An assistant worker polls this to find work. Returns null if empty.
   */
  app.get("/api/assistant/next", (c) => c.json({ item: store.getNextAssistantItem() }));

  /**
   * POST /api/assistant/queue/:id/claim — Claim an item for processing.
   * Transitions from pending→processing. Returns 409 if already claimed.
   */
  app.post("/api/assistant/queue/:id/claim", (c) => {
    const success = store.claimAssistantItem(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Item not available" }, 409);
    return c.json({ success: true });
  });

  /**
   * POST /api/assistant/queue/:id/complete — Mark an item as done/failed.
   * Stores the result and marks completion time. Must be in processing state.
   */
  app.post("/api/assistant/queue/:id/complete", async (c) => {
    const body = await c.req.json();
    const success = store.completeAssistantItem(c.req.param("id"), body.result, body.status === "failed");
    if (!success) return c.json({ success: false, error: "Item not in processing state" }, 400);
    return c.json({ success: true });
  });

  /**
   * DELETE /api/assistant/queue/:id — Delete a queue item.
   * Removes it regardless of status. Used to clean up stale items.
   */
  app.delete("/api/assistant/queue/:id", (c) => {
    const success = store.deleteAssistantItem(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Item not found" }, 404);
    return c.json({ success: true });
  });

  // --- Assistant Notes ---
  // Knowledge base for the team: categorized markdown notes stored on disk.
  // Supports BM25 search (via shared/search.ts) for retrieving relevant context.

  /**
   * GET /api/assistant/notes — List all knowledge base notes.
   * Returns notes with title, content, categories, and timestamps.
   * Used by the UI knowledge panel and search.
   */
  app.get("/api/assistant/notes", (c) => c.json({ notes: store.getAssistantNotes() }));

  /**
   * POST /api/assistant/notes — Save a new knowledge base note.
   * Creates a markdown file with YAML frontmatter for categories.
   * Used to persist research findings, coding patterns, or decisions.
   */
  app.post("/api/assistant/notes", async (c) => {
    const body = await c.req.json();
    if (!body.title || typeof body.title !== "string") return c.json({ success: false, error: "Field 'title' is required" }, 400);
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    const note = store.saveAssistantNote(body.title, body.content, Array.isArray(body.categories) ? body.categories : []);
    return c.json({ success: true, note }, 201);
  });

  /**
   * DELETE /api/assistant/notes/:id — Delete a knowledge base note.
   * Removes the markdown file from disk.
   */
  app.delete("/api/assistant/notes/:id", (c) => {
    const success = store.deleteAssistantNote(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Note not found" }, 404);
    return c.json({ success: true });
  });

  // --- Backlog ---
  // Stories can be moved to backlog when they're not ready to work on.
  // Backlogged stories are moved out of the active stories/ directory.

  /**
   * GET /api/backlog — List backlogged stories.
   * Returns stories that were deferred, with their backlog timestamps.
   */
  app.get("/api/backlog", (c) => c.json({ stories: store.getBacklogStories() }));

  /**
   * POST /api/stories/:id/backlog — Move a story to the backlog.
   * Moves the story (and any stories that depend on it) from stories/
   * to backlog/. Fails if any tasks are in_progress.
   */
  app.post("/api/stories/:id/backlog", (c) => {
    const storyId = c.req.param("id");
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` }, 404);
    try { const moved = store.moveToBacklog(storyId); return c.json({ success: true, moved }); }
    catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
  });

  /**
   * POST /api/backlog/:id/restore — Restore a story from the backlog.
   * Moves it back to stories/ and reloads from disk. Used when the
   * team is ready to work on previously deferred items.
   */
  app.post("/api/backlog/:id/restore", (c) => {
    try { store.moveFromBacklog(c.req.param("id")); return c.json({ success: true }); }
    catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
  });

  // --- Control ---
  // Pause/resume controls task distribution without stopping the daemon.

  /**
   * POST /api/control/pause — Pause task distribution.
   * When paused, /api/next-task and /api/agents/next-work return null.
   * Existing in-progress work continues. Used for maintenance or when
   * the lead needs to reorganize stories without agents claiming tasks.
   */
  app.post("/api/control/pause", (c) => { paused = true; return c.json({ paused: true }); });

  /**
   * POST /api/control/resume — Resume task distribution.
   * Re-enables task assignment after a pause.
   */
  app.post("/api/control/resume", (c) => { paused = false; return c.json({ paused: false }); });

  /**
   * GET /api/config — Get the current team configuration.
   * Returns the full config including loaded workflows. Used by UI
   * settings panels and agents that need workflow details.
   */
  app.get("/api/config", (c) => c.json({ ...config, workflows: store.getWorkflows() }));

  /**
   * PUT /api/config — Update and persist configuration.
   * Validates required fields, updates in-memory config, writes workflows
   * to their directories, and saves config.json to disk.
   */
  app.put("/api/config", async (c) => {
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
      config.port = body.port || config.port;
      config.tmuxSession = body.tmuxSession || config.tmuxSession;
      config.maxTeammates = body.maxTeammates || config.maxTeammates;
      config.defaultWorkflow = body.defaultWorkflow;

      // Save workflows to their directories
      for (const [name, wf] of Object.entries(body.workflows)) {
        store.saveWorkflow(name, wf as WorkflowConfig);
      }
      store.reloadWorkflows();

      if (body.autosave) {
        config.autosave = {
          flushIntervalMinutes: body.autosave.flushIntervalMinutes || 30,
          commitIntervalHours: body.autosave.commitIntervalHours || 24,
          commitMessage: config.autosave.commitMessage,
          autoCommit: body.autosave.autoCommit !== false,
        };
      }
      if (body.teammates !== undefined) {
        config.teammates = body.teammates;
      }
      if (body.categories !== undefined) {
        config.categories = body.categories;
      }

      // Write to disk
      const configFile = path.join(teamDir, "config.json");
      const toWrite: Record<string, unknown> = {
        port: config.port,
        tmuxSession: config.tmuxSession,
        defaultWorkflow: config.defaultWorkflow,
        autosave: config.autosave,
        leaderUrl: config.leaderUrl,
        maxTeammates: config.maxTeammates,
      };
      if (config.teammates && Object.keys(config.teammates).length > 0) {
        toWrite.teammates = config.teammates;
      }
      if (config.categories && config.categories.length > 0) {
        toWrite.categories = config.categories;
      }
      Deno.writeTextFileSync(configFile, JSON.stringify(toWrite, null, 2) + "\n");

      return c.json({ success: true });
    } catch (e: unknown) {
      return c.json({ success: false, error: (e as Error).message }, 400);
    }
  });

  /**
   * GET /api/hosts/:hostId — Get configuration for a specific host.
   * Returns the host's favoriteDirectories and tmuxSession, falling back
   * to global defaults if the host has no specific config. Used by host
   * processes to know which directories to offer for agent spawning.
   */
  app.get("/api/hosts/:hostId", (c) => {
    const hostId = c.req.param("hostId");
    const hostConfig = config.hosts?.[hostId];
    return c.json({
      hostId,
      tmuxSession: hostConfig?.tmuxSession || config.tmuxSession,
      favoriteDirectories: hostConfig?.favoriteDirectories || config.teammates?.favoriteDirectories || [],
    });
  });

  // --- Agents API ---
  // A streamlined agent-facing interface designed for autonomous coding agents.
  // Agents own tasks across multiple state transitions. They claim a task,
  // drive it through every teammate-allowed transition, and release when
  // blocked by a lead-only transition. Comments are loaded once when work
  // begins, not polled continuously.

  /**
   * POST /api/agents/register — Register a new agent.
   * Called once when an agent starts. The agent provides its ID, display name,
   * working directory, and optionally its hostId (for multi-host setups).
   * Returns workflow config and host-specific settings (favoriteDirectories, tmuxSession).
   */
  app.post("/api/agents/register", async (c) => {
    const body = await c.req.json() as { id?: string; name?: string; cwd?: string; hostId?: string; capabilities?: string[] };
    if (!body.id || !body.name || !body.cwd) {
      return c.json({ success: false, error: "Fields 'id', 'name', and 'cwd' are required" }, 400);
    }
    store.registerMember(body.id, body.name, body.cwd, body.id, body.hostId);

    // Resolve host-specific config
    const hostConfig = body.hostId ? config.hosts?.[body.hostId] : undefined;
    const tmuxSession = hostConfig?.tmuxSession || config.tmuxSession;
    const favoriteDirectories = hostConfig?.favoriteDirectories || config.teammates?.favoriteDirectories || [];

    return c.json({
      success: true,
      config: {
        defaultWorkflow: config.defaultWorkflow,
        workflows: store.getWorkflows(),
        tmuxSession,
        favoriteDirectories,
      },
    });
  });

  /**
   * POST /api/agents/heartbeat — Agent heartbeat.
   * Called periodically (e.g. every 30s) to confirm the agent is alive.
   * If heartbeats stop, the daemon considers the agent offline and may
   * release its assigned tasks.
   */
  app.post("/api/agents/heartbeat", async (c) => {
    const body = await c.req.json() as { id?: string; status?: string };
    if (!body.id || !body.status) {
      return c.json({ success: false, error: "Fields 'id' and 'status' are required" }, 400);
    }
    store.heartbeat(body.id, body.status);
    return c.json({ success: true });
  });

  /**
   * GET /api/agents/next-work?agentId=X — Poll for available work.
   * Returns the next unclaimed task that has a teammate-allowed transition
   * from its current state. This covers both fresh tasks (in initial state)
   * and tasks that have been returned by the lead (e.g., moved from B back
   * to A with comments). Includes task comments so the agent can see any
   * lead feedback before starting work.
   *
   * Returns {task: null} if no work is available or distribution is paused.
   */
  app.get("/api/agents/next-work", (c) => {
    const agentId = c.req.query("agentId");
    if (!agentId) return c.json({ task: null });
    if (paused) return c.json({ task: null });

    const member = store.getMember(agentId);
    const result = store.getNextWorkableTask(member?.cwd);
    if (!result) return c.json({ task: null });

    const { availableTransitions, ...task } = result;
    const storyTasks = store.getTasksForStory(task.storyId);
    const previousResults = storyTasks
      .filter(t => t.seq < task.seq && t.result)
      .map(t => `[${t.title}]: ${t.result}`)
      .join("\n\n");
    const wf = store.getWorkflowForStory(task.storyId);
    const comments = store.getComments(task.id);

    return c.json({
      task: {
        id: task.id,
        storyId: task.storyId,
        title: task.title,
        description: task.description,
        status: task.status,
        context: previousResults || undefined,
        comments: comments.length > 0 ? comments : undefined,
        workflow: wf,
        availableTransitions,
      },
    });
  });

  /**
   * POST /api/agents/claim/:taskId — Agent claims a task (ownership only).
   * Assigns the task to the agent without changing its state. The agent
   * should then call /transition to advance the task. This separation
   * allows the agent to read instructions and comments before deciding
   * which transition to make.
   */
  app.post("/api/agents/claim/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);

    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    const success = store.claimTask(taskId, body.agentId);
    if (!success) return c.json({ success: false, error: "Task already claimed" }, 409);

    store.updateMemberStatus(body.agentId, "working");

    // Return current state info so the agent knows where it's starting
    const wf = store.getWorkflowForTask(taskId);
    const transitions = wf.transitions[task.status] || {};
    const available = Object.entries(transitions)
      .filter(([_, perm]) => perm === "teammate" || perm === "any")
      .map(([state, perm]) => ({ state, permission: perm as string }));

    return c.json({
      success: true,
      task: {
        id: task.id,
        storyId: task.storyId,
        title: task.title,
        description: task.description,
        status: task.status,
      },
      availableTransitions: available,
    });
  });

  /**
   * POST /api/agents/transition/:taskId — Agent advances task to a new state.
   * The agent calls this after completing work for the current state.
   * Validates the transition against workflow permissions. On success:
   * - Updates task status (and optionally stores a result summary)
   * - If the new state is the done state, auto-releases the assignment
   * - Returns the next available transitions so the agent knows if it
   *   can keep going or needs to release
   * - Returns transition instructions for the new state
   */
  app.post("/api/agents/transition/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string; status: string; result?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);
    if (!body.status) return c.json({ success: false, error: "Field 'status' is required" }, 400);

    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    // Verify the agent owns this task
    const assignment = store.getAssignment(taskId);
    if (!assignment || assignment.memberId !== body.agentId) {
      return c.json({ success: false, error: "Task not claimed by this agent" }, 403);
    }

    const check = store.canTransition(taskId, body.status, "teammate");
    if (!check.ok) return c.json({ success: false, error: check.error }, 403);

    const fromStatus = task.status;
    store.updateTaskStatus(taskId, body.status, body.result);

    // Check if task reached done state — auto-release
    const wf = store.getWorkflowForTask(taskId);
    const doneState = getDoneState(wf);
    let released = false;
    if (body.status === doneState) {
      store.releaseTask(taskId);
      store.updateMemberStatus(body.agentId, "idle");
      released = true;
    }

    // Compute next available transitions from the new state
    const nextTransitions = wf.transitions[body.status] || {};
    const available = Object.entries(nextTransitions)
      .filter(([_, perm]) => perm === "teammate" || perm === "any")
      .map(([state, perm]) => ({ state, permission: perm as string }));

    const instructions = getInstructionsMarkdown(fromStatus, body.status, taskId);
    return c.json({
      success: true,
      released,
      instructions,
      availableTransitions: available,
    });
  });

  /**
   * POST /api/agents/release/:taskId — Agent releases a task.
   * Called when the agent hits a state where only the lead can make the
   * next transition. Releases the assignment so the lead (or another
   * process) can claim it. Marks the agent as idle.
   */
  app.post("/api/agents/release/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string };
    if (!body.agentId) return c.json({ success: false, error: "Field 'agentId' is required" }, 400);

    const assignment = store.getAssignment(taskId);
    if (!assignment || assignment.memberId !== body.agentId) {
      return c.json({ success: false, error: "Task not claimed by this agent" }, 403);
    }

    store.releaseTask(taskId);
    store.updateMemberStatus(body.agentId, "idle");
    return c.json({ success: true });
  });

  /**
   * GET /api/agents/comments/:taskId — Get comments for a task.
   * Returns the full conversation history. Agents load this when they
   * start working on a task to see lead feedback, review comments, or
   * rework instructions. Comments are task-level, not a real-time
   * communication channel.
   */
  app.get("/api/agents/comments/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    const task = store.getTask(taskId);
    if (!task) return c.json({ comments: [] });
    return c.json({ comments: store.getComments(taskId) });
  });

  /**
   * POST /api/agents/comments/:taskId — Agent posts a comment on a task.
   * Used for status updates, summaries of work done, or questions.
   * These are task-level comments visible to the lead and any future
   * agent that picks up the task.
   */
  app.post("/api/agents/comments/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = await c.req.json() as { agentId?: string; body?: string; attachments?: Array<{ name: string; size: number; type: string }> };
    if (!body.agentId || !body.body) return c.json({ success: false, error: "Fields 'agentId' and 'body' are required" }, 400);

    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    store.addComment(taskId, body.agentId, body.body, body.attachments);
    return c.json({ success: true });
  });

  /**
   * GET /api/agents — List all registered agents.
   * Returns each agent's status, current task, and last heartbeat.
   * Used by the lead to monitor the team of agents.
   */
  app.get("/api/agents", (c) => {
    const members = store.getMembers();
    return c.json({
      agents: members.map(m => {
        const assignment = store.getAssignmentForMember(m.id);
        return { id: m.id, name: m.name, cwd: m.cwd, hostId: m.hostId, status: m.status, currentTask: assignment?.taskId || null, lastHeartbeat: m.lastHeartbeat };
      }),
    });
  });

  /**
   * DELETE /api/agents/:id — Unregister an agent.
   * Removes the agent and releases any task assignments. Called when
   * an agent shuts down cleanly or the lead removes a stuck agent.
   */
  app.delete("/api/agents/:id", (c) => {
    const agentId = c.req.param("id");
    const member = store.getMember(agentId);
    if (!member) return c.json({ success: false, error: `Agent "${agentId}" not found` }, 404);
    store.removeMember(agentId);
    return c.json({ success: true });
  });

  // --- Spawn Requests ---
  // Allows the daemon to request that host machines spawn new agent processes.
  // The host polls for pending requests and acknowledges them once spawned.

  /**
   * POST /api/spawn-requests — Create a spawn request.
   * The lead (or daemon auto-scaler) requests that a host machine start
   * a new agent process. Specifies target cwd, optional story, and reason.
   */
  app.post("/api/spawn-requests", async (c) => {
    const body = await c.req.json() as { hostId?: string; cwd?: string; storyId?: string; reason?: string };
    if (!body.hostId || typeof body.hostId !== "string") {
      return c.json({ success: false, error: "Field 'hostId' is required" }, 400);
    }
    const request = store.createSpawnRequest(body.hostId, body.cwd, body.storyId, body.reason);
    return c.json({ success: true, request }, 201);
  });

  /**
   * GET /api/spawn-requests?hostId=X — Poll pending spawn requests.
   * Host machines poll this to discover new agent spawn requests.
   * Returns only pending (un-acknowledged) requests for the given host.
   */
  app.get("/api/spawn-requests", (c) => {
    const hostId = c.req.query("hostId");
    if (!hostId) return c.json({ requests: [] });
    const requests = store.getSpawnRequests(hostId);
    return c.json({ requests });
  });

  /**
   * POST /api/spawn-requests/:id/ack — Acknowledge a spawn request.
   * The host calls this after successfully spawning the requested agent.
   * Marks the request as acknowledged so it won't appear in future polls.
   */
  app.post("/api/spawn-requests/:id/ack", (c) => {
    const id = c.req.param("id");
    const success = store.ackSpawnRequest(id);
    if (!success) return c.json({ success: false, error: "Request not found or already acknowledged" }, 404);
    return c.json({ success: true });
  });

  return app;
}
