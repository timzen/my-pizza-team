/**
 * daemon/routes/work-defs.ts — WorkDef CRUD + enqueue.
 *
 * WorkDefs are standalone work definitions (Solitary one-shots and Scheduled
 * cron work), stored as markdown on disk. Creating one enqueues a WorkItem by
 * default; "save without enqueueing" passes `enqueue: false`. See the plan.
 */

import type { RouteContext } from "./types.ts";
import type { WorkDef } from "../../shared/types.ts";
import type { WorkDefsResponse, WorkDefResponse, SaveWorkDefRequest, UpdateWorkDefRequest, SaveWorkDefResponse } from "../../shared/protocol.ts";
import { isValidCron } from "../cron.ts";

function view(d: WorkDef) {
  return {
    id: d.id, title: d.title, type: d.type, goal: d.goal, acceptanceCriteria: d.acceptanceCriteria,
    additionalContext: d.additionalContext, contextRefs: d.contextRefs, directory: d.directory,
    cron: d.cron, lastEnqueuedAt: d.lastEnqueuedAt,
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
    const type = body.type === "Scheduled" ? "Scheduled" : "Solitary";
    if (type === "Scheduled") {
      if (!body.cron || !isValidCron(body.cron)) return c.json({ success: false, error: "Scheduled work needs a valid 5-field 'cron'" } satisfies SaveWorkDefResponse, 400);
    }
    const def = store.createWorkDef({
      title: body.title, type, goal: body.goal, acceptanceCriteria: body.acceptanceCriteria || "",
      additionalContext: body.additionalContext, contextRefs: body.contextRefs,
      directory: body.directory, cron: type === "Scheduled" ? body.cron : undefined,
    }, body.enqueue !== false && type === "Solitary");
    return c.json({ success: true, workDef: view(def) } satisfies SaveWorkDefResponse, 201);
  });

  app.put("/api/work-defs/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as UpdateWorkDefRequest;
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" } satisfies SaveWorkDefResponse, 404);
    if (body.cron && !isValidCron(body.cron)) return c.json({ success: false, error: "Invalid 'cron' expression" } satisfies SaveWorkDefResponse, 400);
    const def = store.updateWorkDefDetails(id, body);
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
    return c.json({ comments: store.getCommentsForRef({ kind: "workdef", workDefId: id }) });
  });

  app.post("/api/work-defs/:id/comment", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { from?: string; body?: string };
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    if (!body.from || !body.body) return c.json({ success: false, error: "Fields 'from' and 'body' are required" }, 400);
    store.addCommentForRef({ kind: "workdef", workDefId: id }, body.from, body.body);
    return c.json({ success: true });
  });
}
