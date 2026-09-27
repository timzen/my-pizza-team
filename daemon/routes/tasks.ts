/**
 * daemon/routes/tasks.ts — Task CRUD, move, and reorder routes.
 *
 * Used by the web UI for task management (edit, delete, move status, reorder).
 * Attachments, comments, and token usage are ref-scoped and live on the WorkDef —
 * see `routes/work-defs.ts` and the note at the bottom of this file.
 */

import type { RouteContext } from "./types.ts";
import { TODO_STATE } from "../../shared/types.ts";
import type {
  CreateTaskRequest, CreateTaskResponse,
  DeleteTaskResponse, MoveTaskRequest, MoveTaskResponse,
  ReorderTasksRequest, ReorderTasksResponse,
} from "../../shared/protocol.ts";

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
    // to `ready` and clears the lease (rework path; see docs/DESIGN.md "The Work Model").
    const moved = store.moveTask(taskId, body.status);
    if (!moved.ok) return c.json({ success: false, error: moved.error } satisfies MoveTaskResponse, 400);
    return c.json({ success: true } satisfies MoveTaskResponse);
  });

  // ─── Comments, attachments, token usage ───────────────────────────
  //
  // All three are ref-scoped and live on the WorkDef, so the canonical routes are
  // `/api/work-defs/:id/*` (used by the web UI) and `/api/agents/*` (used by
  // harnesses). The `/api/tasks/:taskId/*` duplicates resolved to the same files
  // on the same ref. The comment pair went first; attachments and token-usage
  // outlived them only because mpt-mcp-server still called them, and that harness
  // is retired (docs/DESIGN.md "Harness Tiers, and Why Not MCP", task P1a-5).
  // See docs/DESIGN.md "WorkDefs & Parents".

}
