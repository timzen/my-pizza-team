/**
 * daemon/routes/tasks.ts — Task CRUD, move, comments, attachments, and token usage routes.
 *
 * Used by the web UI for task management (edit, delete, move status),
 * and by teammates/agents for posting comments and uploading attachments.
 */

import type { RouteContext } from "./types.ts";
import { getInitialState, slugify } from "../../shared/types.ts";
import { canTransition } from "../workflow-engine.ts";
import type {
  CreateTaskRequest, CreateTaskResponse, UpdateTaskRequest, UpdateTaskResponse,
  DeleteTaskResponse, MoveTaskRequest, MoveTaskResponse, PostCommentRequest,
  PostCommentResponse, CommentsResponse, TokenUsageRequest, TokenUsageResponse,
} from "../../shared/protocol.ts";
import * as path from "jsr:@std/path@^1";

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

export function registerTaskRoutes(ctx: RouteContext): void {
  const { app, store, getInstructionsMarkdown } = ctx;

  // ─── Task CRUD ─────────────────────────────────────────────────────

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

  app.put("/api/tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as UpdateTaskRequest;
    if (!body.title && !body.description) return c.json({ success: false, error: "At least one field required" } satisfies UpdateTaskResponse, 400);
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies UpdateTaskResponse, 404);
    store.updateTaskDetails(taskId, { title: body.title, description: body.description });
    return c.json({ success: true } satisfies UpdateTaskResponse);
  });

  app.delete("/api/tasks/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies DeleteTaskResponse, 404);
    store.deleteTask(taskId);
    return c.json({ success: true } satisfies DeleteTaskResponse);
  });

  // ─── Task Move (lead) ──────────────────────────────────────────────

  app.post("/api/tasks/:taskId/move", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as MoveTaskRequest;
    if (!body.status) return c.json({ success: false, error: "Field 'status' is required" } satisfies MoveTaskResponse, 400);
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies MoveTaskResponse, 404);
    const workflow = store.getWorkflowForTask(taskId);
    const check = canTransition(workflow, task.status, body.status, "lead");
    if (!check.ok) {
      return c.json({ success: false, error: check.error } satisfies MoveTaskResponse, 403);
    }
    const fromStatus = task.status;
    store.updateTaskStatus(taskId, body.status);
    return c.json({ success: true, instructions: getInstructionsMarkdown(fromStatus, body.status, taskId) } satisfies MoveTaskResponse);
  });

  // ─── Comments ──────────────────────────────────────────────────────

  app.post("/api/tasks/:taskId/comment", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as PostCommentRequest;
    store.addComment(taskId, body.from, body.body, body.attachments);
    return c.json({ success: true } satisfies PostCommentResponse);
  });

  app.get("/api/tasks/:taskId/comments", (c) => {
    const taskId = c.req.param("taskId");
    return c.json({ comments: store.getComments(taskId) } satisfies CommentsResponse);
  });

  // ─── Attachments ───────────────────────────────────────────────────

  app.post("/api/tasks/:taskId/attachments", async (c) => {
    const taskId = c.req.param("taskId");
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);

    const body = await c.req.json() as { name: string; content: string; encoding?: string };
    if (!body.name || !body.content) return c.json({ success: false, error: "Fields 'name' and 'content' are required" }, 400);

    let data: string | Uint8Array = body.content;
    if (body.encoding === "base64") {
      const binaryString = atob(body.content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      data = bytes;
    }

    const storedName = store.saveAttachment(taskId, body.name, data);
    if (!storedName) return c.json({ success: false, error: "Failed to save attachment" }, 500);

    const ext = body.name.split(".").pop()?.toLowerCase() || "";
    const typeMap: Record<string, string> = { diff: "diff", patch: "diff", md: "markdown", txt: "text", json: "json", png: "image", jpg: "image", jpeg: "image" };
    return c.json({ success: true, storedName, type: typeMap[ext] || "other", size: body.content.length });
  });

  app.get("/api/tasks/:taskId/attachments", (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` }, 404);
    return c.json({ attachments: store.getAttachments(taskId) });
  });

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
    return new Response(content, { headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" } });
  });

  app.delete("/api/tasks/:taskId/attachments/:filename", (c) => {
    const taskId = c.req.param("taskId");
    const filename = c.req.param("filename");
    const deleted = store.deleteAttachment(taskId, filename);
    if (!deleted) return c.json({ success: false, error: "Attachment not found" }, 404);
    return c.json({ success: true });
  });

  // ─── Token Usage ───────────────────────────────────────────────────

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
}
