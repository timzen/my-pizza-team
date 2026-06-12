/**
 * daemon/routes/assistant.ts — Assistant queue and knowledge base routes.
 *
 * The assistant queue allows the lead to enqueue prompts for async
 * processing. The knowledge base stores categorized markdown notes
 * with BM25 search support.
 */

import type { RouteContext } from "./types.ts";

export function registerAssistantRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  // ─── Queue ─────────────────────────────────────────────────────────

  app.get("/api/assistant/queue", (c) => {
    const items = store.getAssistantQueue();
    return c.json({ items: items.map(item => ({ id: item.id, prompt: item.prompt, status: item.status, result: item.result || undefined, createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(), startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : undefined, completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : undefined })) });
  });

  app.post("/api/assistant/queue", async (c) => {
    const body = await c.req.json();
    if (!body.prompt || typeof body.prompt !== "string") return c.json({ success: false, error: "Field 'prompt' is required" }, 400);
    const item = store.enqueueAssistantItem(body.prompt);
    return c.json({ success: true, item }, 201);
  });

  app.get("/api/assistant/next", (c) => c.json({ item: store.getNextAssistantItem() }));

  app.post("/api/assistant/queue/:id/claim", (c) => {
    const success = store.claimAssistantItem(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Item not available" }, 409);
    return c.json({ success: true });
  });

  app.post("/api/assistant/queue/:id/complete", async (c) => {
    const body = await c.req.json();
    const success = store.completeAssistantItem(c.req.param("id"), body.result, body.status === "failed");
    if (!success) return c.json({ success: false, error: "Item not in processing state" }, 400);
    return c.json({ success: true });
  });

  app.delete("/api/assistant/queue/:id", (c) => {
    const success = store.deleteAssistantItem(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Item not found" }, 404);
    return c.json({ success: true });
  });

  // ─── Knowledge Base Notes ──────────────────────────────────────────

  app.get("/api/assistant/notes", (c) => c.json({ notes: store.getAssistantNotes() }));

  app.post("/api/assistant/notes", async (c) => {
    const body = await c.req.json();
    if (!body.title || typeof body.title !== "string") return c.json({ success: false, error: "Field 'title' is required" }, 400);
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    const note = store.saveAssistantNote(body.title, body.content, Array.isArray(body.categories) ? body.categories : []);
    return c.json({ success: true, note }, 201);
  });

  app.delete("/api/assistant/notes/:id", (c) => {
    const success = store.deleteAssistantNote(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Note not found" }, 404);
    return c.json({ success: true });
  });
}
