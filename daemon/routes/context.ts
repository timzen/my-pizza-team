/**
 * daemon/routes/context.ts — Context library routes.
 *
 * The context library is a collection of reusable prompt/context entries that
 * can be injected into teammates or the assistant. Each entry is a markdown
 * file with frontmatter metadata (title, description, tags). This is a plain
 * CRUD surface; filtering/search is done client-side since the collection is
 * expected to stay small.
 */

import type { RouteContext } from "./types.ts";

export function registerContextRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/context", (c) => c.json({ entries: store.getContextEntries() }));

  app.get("/api/context/:id", (c) => {
    const entry = store.getContextEntry(c.req.param("id"));
    if (!entry) return c.json({ success: false, error: "Context entry not found" }, 404);
    return c.json({ entry });
  });

  app.post("/api/context", async (c) => {
    const body = await c.req.json();
    if (!body.title || typeof body.title !== "string") return c.json({ success: false, error: "Field 'title' is required" }, 400);
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    const entry = store.saveContextEntry({
      title: body.title,
      description: typeof body.description === "string" ? body.description : "",
      tags: Array.isArray(body.tags) ? body.tags : [],
      content: body.content,
    });
    return c.json({ success: true, entry }, 201);
  });

  app.put("/api/context/:id", async (c) => {
    const body = await c.req.json();
    const entry = store.updateContextEntry(c.req.param("id"), {
      title: typeof body.title === "string" ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      content: typeof body.content === "string" ? body.content : undefined,
    });
    if (!entry) return c.json({ success: false, error: "Context entry not found" }, 404);
    return c.json({ success: true, entry });
  });

  app.delete("/api/context/:id", (c) => {
    const success = store.deleteContextEntry(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Context entry not found" }, 404);
    return c.json({ success: true });
  });
}
