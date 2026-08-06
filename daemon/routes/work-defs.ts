/**
 * daemon/routes/work-defs.ts — WorkDef CRUD + enqueue.
 *
 * WorkDefs are standalone work definitions (Solitary one-shots and Scheduled
 * cron work), stored as markdown on disk. Creating one enqueues a WorkItem by
 * default; "save without enqueueing" passes `enqueue: false`. See the plan.
 */

import type { RouteContext } from "./types.ts";
import { workDefType, type WorkDef } from "../../shared/types.ts";
import type { WorkDefsResponse, WorkDefResponse, SaveWorkDefRequest, UpdateWorkDefRequest, SaveWorkDefResponse } from "../../shared/protocol.ts";
import { isValidCron } from "../cron.ts";
import { estimateTokenCost } from "../token-cost.ts";

function view(d: WorkDef) {
  return {
    id: d.id, title: d.title, type: workDefType(d.parent), parent: d.parent,
    goal: d.goal, acceptanceCriteria: d.acceptanceCriteria,
    additionalContext: d.additionalContext, contextRefs: d.contextRefs, directory: d.directory,
  };
}

export function registerWorkDefRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/work-defs", (c) => {
    return c.json({ workDefs: store.getWorkDefs().map(view) } satisfies WorkDefsResponse);
  });

  app.get("/api/work-defs/:id", (c) => {
    const def = store.getWorkDef(c.req.param("id"));
    if (!def) return c.json({ success: false, error: "WorkDef not found" } satisfies WorkDefResponse, 404);
    return c.json({ workDef: view(def) } satisfies WorkDefResponse);
  });

  app.post("/api/work-defs", async (c) => {
    const body = (await c.req.json()) as SaveWorkDefRequest;
    if (!body.title) return c.json({ success: false, error: "Field 'title' is required" } satisfies SaveWorkDefResponse, 400);
    if (!body.goal) return c.json({ success: false, error: "Field 'goal' is required" } satisfies SaveWorkDefResponse, 400);
    const scheduled = body.type === "Scheduled";
    let parent;
    if (scheduled) {
      if (!body.cron || !isValidCron(body.cron)) return c.json({ success: false, error: "Scheduled work needs a valid 5-field 'cron'" } satisfies SaveWorkDefResponse, 400);
      // Scheduled work: create a cron Schedule parent, then point the WorkDef at it.
      const sched = store.createSchedule({ title: body.title, cron: body.cron });
      parent = { kind: "schedule" as const, id: sched.id };
    }
    const def = store.createWorkDef({
      title: body.title, parent, goal: body.goal, acceptanceCriteria: body.acceptanceCriteria || "",
      additionalContext: body.additionalContext, contextRefs: body.contextRefs, directory: body.directory,
    }, body.enqueue !== false && !scheduled);
    return c.json({ success: true, workDef: view(def) } satisfies SaveWorkDefResponse, 201);
  });

  app.put("/api/work-defs/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as UpdateWorkDefRequest;
    const existing = store.getWorkDef(id);
    if (!existing) return c.json({ success: false, error: "WorkDef not found" } satisfies SaveWorkDefResponse, 404);
    if (body.cron !== undefined && body.cron !== null && !isValidCron(body.cron)) return c.json({ success: false, error: "Invalid 'cron' expression" } satisfies SaveWorkDefResponse, 400);
    // A cron edit updates the WorkDef's parent Schedule, not the WorkDef itself.
    if (body.cron && existing.parent?.kind === "schedule") {
      store.updateScheduleDetails(existing.parent.id, { cron: body.cron });
    }
    const def = store.updateWorkDefDetails(id, {
      title: body.title, goal: body.goal, acceptanceCriteria: body.acceptanceCriteria,
      additionalContext: body.additionalContext, contextRefs: body.contextRefs, directory: body.directory,
    });
    if (!def) return c.json({ success: false, error: "Update failed" } satisfies SaveWorkDefResponse, 400);
    return c.json({ success: true, workDef: view(def) } satisfies SaveWorkDefResponse);
  });

  app.delete("/api/work-defs/:id", (c) => {
    const ok = store.deleteWorkDef(c.req.param("id"));
    if (!ok) return c.json({ success: false, error: "WorkDef not found" }, 404);
    return c.json({ success: true });
  });

  // Enqueue a READY WorkItem for this def (manual trigger / "save then enqueue").
  app.post("/api/work-defs/:id/enqueue", (c) => {
    const item = store.enqueueWorkDef(c.req.param("id"));
    if (!item) return c.json({ success: false, error: "Unknown WorkDef, or one is already in flight" }, 400);
    return c.json({ success: true, workItemId: item.id });
  });

  // Comments live on the WorkDef (per-def run thread).
  app.get("/api/work-defs/:id/comments", (c) => {
    const id = c.req.param("id");
    if (!store.getWorkDef(id)) return c.json({ comments: [] });
    return c.json({ comments: store.getCommentsForRef({ workDefId: id }) });
  });

  app.post("/api/work-defs/:id/comment", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { from?: string; body?: string; attachments?: Array<{ name: string; size: number; type: string }> };
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    if (!body.from || !body.body) return c.json({ success: false, error: "Fields 'from' and 'body' are required" }, 400);
    store.addCommentForRef({ workDefId: id }, body.from, body.body, body.attachments);
    return c.json({ success: true });
  });

  // ── Attachments (on the ref) ─────────────────────────────────────────
  // These work for ANY WorkDef (board / Solitary / Scheduled), unlike the
  // board-only /api/tasks/:taskId/attachments routes. The web UI uses these;
  // the mpt-mcp-server still uses the task-scoped ones (kept for compat).

  const MIME_TYPES: Record<string, string> = {
    diff: "text/x-diff", patch: "text/x-diff", md: "text/markdown",
    txt: "text/plain", json: "application/json",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  };

  app.post("/api/work-defs/:id/attachments", async (c) => {
    const id = c.req.param("id");
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    const body = await c.req.json() as { name?: string; content?: string; encoding?: string };
    if (!body.name || !body.content) return c.json({ success: false, error: "Fields 'name' and 'content' are required" }, 400);

    let data: string | Uint8Array = body.content;
    if (body.encoding === "base64") {
      const bin = atob(body.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      data = bytes;
    }
    const storedName = store.saveAttachmentForRef({ workDefId: id }, body.name, data);
    if (!storedName) return c.json({ success: false, error: "Failed to save attachment" }, 500);
    const ext = body.name.split(".").pop()?.toLowerCase() || "";
    const typeMap: Record<string, string> = { diff: "diff", patch: "diff", md: "markdown", txt: "text", json: "json", png: "image", jpg: "image", jpeg: "image" };
    return c.json({ success: true, storedName, type: typeMap[ext] || "other", size: body.content.length });
  });

  app.get("/api/work-defs/:id/attachments", (c) => {
    const id = c.req.param("id");
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    return c.json({ attachments: store.getAttachmentsForRef({ workDefId: id }) });
  });

  app.get("/api/work-defs/:id/attachments/:filename", (c) => {
    const id = c.req.param("id");
    const filename = c.req.param("filename");
    if (!store.getWorkDef(id)) return c.json({ error: "WorkDef not found", id }, 404);
    const filePath = store.getAttachmentPathForRef({ workDefId: id }, filename);
    if (!filePath) return c.json({ error: "Attachment not found", id, filename }, 404);
    const content = Deno.readFileSync(filePath);
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    return new Response(content, { headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" } });
  });

  app.delete("/api/work-defs/:id/attachments/:filename", (c) => {
    const id = c.req.param("id");
    const deleted = store.deleteAttachmentForRef({ workDefId: id }, c.req.param("filename"));
    if (!deleted) return c.json({ success: false, error: "Attachment not found" }, 404);
    return c.json({ success: true });
  });

  // ── Token usage (on the ref) ─────────────────────────────────────────
  app.post("/api/work-defs/:id/token-usage", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { inputTokens?: number; outputTokens?: number; model?: string };
    if (typeof body.inputTokens !== "number" || typeof body.outputTokens !== "number" || !body.model) {
      return c.json({ success: false, error: "Fields inputTokens, outputTokens, model required" }, 400);
    }
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    const costUsd = estimateTokenCost(body.model, body.inputTokens, body.outputTokens);
    store.addTokenUsageForRef({ workDefId: id }, body.inputTokens, body.outputTokens, body.model, costUsd);
    return c.json({ success: true, costUsd });
  });
}
