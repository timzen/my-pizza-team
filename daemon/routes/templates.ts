/**
 * daemon/routes/templates.ts — Task Template CRUD (`/api/templates`).
 *
 * A Template is a reusable mold for a Solitary task (see docs/ARCHITECTURE.md
 * "Templates"). It has the same authored fields as a WorkDef but never enqueues
 * a WorkItem — it exists only to pre-fill a new Solitary task. It is stored
 * separately from work, so it never enters the WorkItem queue or the
 * /api/work-defs listing.
 */

import type { RouteContext } from "./types.ts";
import type { Template } from "../../shared/types.ts";
import type {
  TemplatesResponse, TemplateResponse, SaveTemplateRequest, UpdateTemplateRequest, SaveTemplateResponse,
} from "../../shared/protocol.ts";

function view(t: Template) {
  return {
    id: t.id, title: t.title, goal: t.goal, acceptanceCriteria: t.acceptanceCriteria,
    additionalContext: t.additionalContext, contextRefs: t.contextRefs, directory: t.directory,
  };
}

export function registerTemplateRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/templates", (c) => {
    return c.json({ templates: store.getTemplates().map(view) } satisfies TemplatesResponse);
  });

  app.get("/api/templates/:id", (c) => {
    const tpl = store.getTemplate(c.req.param("id"));
    if (!tpl) return c.json({ success: false, error: "Template not found" } satisfies TemplateResponse, 404);
    return c.json({ template: view(tpl) } satisfies TemplateResponse);
  });

  app.post("/api/templates", async (c) => {
    const body = (await c.req.json()) as SaveTemplateRequest;
    if (!body.title) return c.json({ success: false, error: "Field 'title' is required" } satisfies SaveTemplateResponse, 400);
    const tpl = store.createTemplate({
      title: body.title, goal: body.goal || "", acceptanceCriteria: body.acceptanceCriteria || "",
      additionalContext: body.additionalContext, contextRefs: body.contextRefs, directory: body.directory,
    });
    return c.json({ success: true, template: view(tpl) } satisfies SaveTemplateResponse, 201);
  });

  app.put("/api/templates/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as UpdateTemplateRequest;
    if (!store.getTemplate(id)) return c.json({ success: false, error: "Template not found" } satisfies SaveTemplateResponse, 404);
    const tpl = store.updateTemplateDetails(id, {
      title: body.title, goal: body.goal, acceptanceCriteria: body.acceptanceCriteria,
      additionalContext: body.additionalContext, contextRefs: body.contextRefs, directory: body.directory,
    });
    if (!tpl) return c.json({ success: false, error: "Update failed" } satisfies SaveTemplateResponse, 400);
    return c.json({ success: true, template: view(tpl) } satisfies SaveTemplateResponse);
  });

  app.delete("/api/templates/:id", (c) => {
    const ok = store.deleteTemplate(c.req.param("id"));
    if (!ok) return c.json({ success: false, error: "Template not found" }, 404);
    return c.json({ success: true });
  });
}
