/**
 * daemon/routes/tasks.ts — Task CRUD, move, comments, attachments, and token usage routes.
 *
 * Used by the web UI for task management (edit, delete, move status),
 * and by teammates/agents for posting comments and uploading attachments.
 */

import type { RouteContext } from "./types.ts";
import { TODO_STATE } from "../../shared/types.ts";
import { estimateTokenCost } from "../token-cost.ts";
import type {
  CreateTaskRequest, CreateTaskResponse, UpdateTaskRequest, UpdateTaskResponse,
  DeleteTaskResponse, MoveTaskRequest, MoveTaskResponse, PostCommentRequest,
  PostCommentResponse, CommentsResponse, TokenUsageRequest, TokenUsageResponse,
  ReorderTasksRequest, ReorderTasksResponse,
} from "../../shared/protocol.ts";
import * as path from "@std/path";

export function registerTaskRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  // ─── Task CRUD ─────────────────────────────────────────────────────

  app.post("/api/stories/:storyId/tasks", async (c) => {
    const storyId = c.req.param("storyId");
    const body = (await c.req.json()) as CreateTaskRequest;
    if (!body.title) return c.json({ success: false, error: "Field 'title' is required" } satisfies CreateTaskResponse, 400);
    if (!body.description) return c.json({ success: false, error: "Field 'description' is required" } satisfies CreateTaskResponse, 400);
    const story = store.getStory(storyId);
    if (!story) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies CreateTaskResponse, 404);

    const task = store.addTask(storyId, { title: body.title, description: body.description, context: Array.isArray(body.context) ? body.context : undefined });
    if (!task) return c.json({ success: false, error: "Failed to add task" } satisfies CreateTaskResponse, 400);

    return c.json({ success: true, task: { id: task.id, seq: task.seq, title: task.title, description: task.description, status: task.status } } satisfies CreateTaskResponse, 201);
  });

  app.put("/api/tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as UpdateTaskRequest;
    if (body.title === undefined && body.description === undefined && body.context === undefined) return c.json({ success: false, error: "At least one field required" } satisfies UpdateTaskResponse, 400);
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies UpdateTaskResponse, 404);
    store.updateTaskDetails(taskId, { title: body.title, description: body.description, context: body.context });
    return c.json({ success: true } satisfies UpdateTaskResponse);
  });

  app.delete("/api/tasks/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies DeleteTaskResponse, 404);
    store.deleteTask(taskId);
    return c.json({ success: true } satisfies DeleteTaskResponse);
  });

  // Reorder a story's tasks (lead). Body: { order: [taskId, ...] } — a
  // permutation of the story's current task IDs. Persists the new sequence.
  app.post("/api/stories/:storyId/tasks/reorder", async (c) => {
    const storyId = c.req.param("storyId");
    const body = (await c.req.json()) as ReorderTasksRequest;
    if (!Array.isArray(body.order)) return c.json({ success: false, error: "Field 'order' (array of task IDs) is required" } satisfies ReorderTasksResponse, 400);
    if (!store.getStory(storyId)) return c.json({ success: false, error: `Story "${storyId}" not found` } satisfies ReorderTasksResponse, 404);
    const ok = store.reorderTasks(storyId, body.order);
    if (!ok) return c.json({ success: false, error: "Invalid order: must be a permutation of the story's task IDs" } satisfies ReorderTasksResponse, 400);
    return c.json({ success: true } satisfies ReorderTasksResponse);
  });

  // ─── Task Move (lead) ──────────────────────────────────────────────

  app.post("/api/tasks/:taskId/move", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json()) as MoveTaskRequest;
    if (!body.status) return c.json({ success: false, error: "Field 'status' is required" } satisfies MoveTaskResponse, 400);
    const task = store.getTask(taskId);
    if (!task) return c.json({ success: false, error: `Task "${taskId}" not found` } satisfies MoveTaskResponse, 404);
    // Judgment moves are unrestricted: a human (or the leader agent) may put a
    // task anywhere in its workflow. Entering an agent state resets substatus
    // to `ready` and clears the lease (rework path; see docs/WORK-MODEL.md).
    const moved = store.moveTask(taskId, body.status);
    if (!moved.ok) return c.json({ success: false, error: moved.error } satisfies MoveTaskResponse, 400);
    return c.json({ success: true } satisfies MoveTaskResponse);
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
