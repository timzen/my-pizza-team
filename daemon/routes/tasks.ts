/**
 * daemon/routes/tasks.ts — Task CRUD, move, and reorder routes.
 *
 * Used by the web UI for task management (edit, delete, move status, reorder).
 * Attachments, comments, and token usage are ref-scoped and live on the WorkDef —
 * see `routes/work-defs.ts` and the note at the bottom of this file.
 */

import type { RouteContext } from "./types.ts";
import { readBody, fail } from "./http.ts";
import { TODO_STATE } from "../../shared/types.ts";
import { requestsPending } from "./work-defs.ts";
import { contextFieldRefusal } from "./personas.ts";
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
    const body = (await readBody(c)) as CreateTaskRequest;
    if (!body.title) return fail(c, 400, "Field 'title' is required");
    if (!body.description) return fail(c, 400, "Field 'description' is required");
    const story = store.getStory(storyId);
    if (!story) return fail(c, 404, `Story "${storyId}" not found`);

    const refused = contextFieldRefusal(body);
    if (refused) return fail(c, 400, refused);

    const pending = requestsPending(body);
    const task = store.addTask(storyId, { title: body.title, description: body.description, pending });
    if (!task) return fail(c, 400, "Failed to add task");

    return c.json({ success: true, task: { id: task.id, seq: task.seq, title: task.title, description: task.description, status: task.status, pending } } satisfies CreateTaskResponse, 201);
  });

  app.delete("/api/tasks/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    if (!store.getTask(taskId)) return fail(c, 404, `Task "${taskId}" not found`);
    store.deleteTask(taskId);
    return c.json({ success: true } satisfies DeleteTaskResponse);
  });

  // Reorder a story's tasks (lead). Body: { order: [taskId, ...] } — a
  // permutation of the story's current task IDs. Persists the new sequence.
  app.post("/api/stories/:storyId/tasks/reorder", async (c) => {
    const storyId = c.req.param("storyId");
    const body = (await readBody(c)) as ReorderTasksRequest;
    if (!Array.isArray(body.order)) return fail(c, 400, "Field 'order' (array of task IDs) is required");
    if (!store.getStory(storyId)) return fail(c, 404, `Story "${storyId}" not found`);
    const ok = store.reorderTasks(storyId, body.order);
    if (!ok) return fail(c, 400, "Invalid order: must be a permutation of the story's task IDs");
    return c.json({ success: true } satisfies ReorderTasksResponse);
  });

  // ─── Task Move (lead) ──────────────────────────────────────────────

  app.post("/api/tasks/:taskId/move", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await readBody(c)) as MoveTaskRequest;
    if (!body.status) return fail(c, 400, "Field 'status' is required");
    const task = store.getTask(taskId);
    if (!task) return fail(c, 404, `Task "${taskId}" not found`);
    // Judgment moves are unrestricted: a human (or the leader agent) may put a
    // task anywhere in its workflow. Entering an agent state resets substatus
    // to `ready` and clears the lease (rework path; see docs/DESIGN.md "The Work Model").
    const moved = store.moveTask(taskId, body.status);
    if (!moved.ok) return fail(c, 400, moved.error);
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
