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
import { readBody, fail } from "./http.ts";
import { contextFieldRefusal } from "./personas.ts";
import type { Template } from "../../shared/types.ts";
import type {
  TemplatesResponse, TemplateResponse, SaveTemplateRequest, UpdateTemplateRequest, SaveTemplateResponse,
} from "../../shared/protocol.ts";

function view(t: Template) {
  return {
    id: t.id, title: t.title, goal: t.goal, acceptanceCriteria: t.acceptanceCriteria,
    additionalContext: t.additionalContext, directory: t.directory,
  };
}

export function registerTemplateRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/templates", (c) => {
    return c.json({ templates: store.getTemplates().map(view) } satisfies TemplatesResponse);
  });

  app.get("/api/templates/:id", (c) => {
    const tpl = store.getTemplate(c.req.param("id"));
    if (!tpl) return fail(c, 404, "Template not found");
    return c.json({ template: view(tpl) } satisfies TemplateResponse);
  });

  app.post("/api/templates", async (c) => {
    const body = (await readBody(c)) as SaveTemplateRequest;
    if (!body.title) return fail(c, 400, "Field 'title' is required");
    const refused = contextFieldRefusal(body);
    if (refused) return fail(c, 400, refused);
    const tpl = store.createTemplate({
      title: body.title, goal: body.goal || "", acceptanceCriteria: body.acceptanceCriteria || "",
      additionalContext: body.additionalContext, directory: body.directory,
    });
    return c.json({ success: true, template: view(tpl) } satisfies SaveTemplateResponse, 201);
  });

  app.put("/api/templates/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await readBody(c)) as UpdateTemplateRequest;
    if (!store.getTemplate(id)) return fail(c, 404, "Template not found");
    const refused = contextFieldRefusal(body);
    if (refused) return fail(c, 400, refused);
    const tpl = store.updateTemplateDetails(id, {
      title: body.title, goal: body.goal, acceptanceCriteria: body.acceptanceCriteria,
      additionalContext: body.additionalContext, directory: body.directory,
    });
    if (!tpl) return fail(c, 400, "Update failed");
    return c.json({ success: true, template: view(tpl) } satisfies SaveTemplateResponse);
  });

  app.delete("/api/templates/:id", (c) => {
    const ok = store.deleteTemplate(c.req.param("id"));
    if (!ok) return fail(c, 404, "Template not found");
    return c.json({ success: true });
  });
}
