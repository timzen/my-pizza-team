/**
 * daemon/routes/scratchpad.ts — Personal scratch pad routes.
 *
 * A simple todo list (`TODO.jsonl`) + notes doc (`NOTES.md`) kept as plain
 * files under the team directory (see store/scratchpad.ts). Todos are addressed
 * by their line index. Used by the web UI, and readable by the assistant when
 * the user asks it to look at their scratch pad.
 */

import type { RouteContext } from "./types.ts";

export function registerScratchpadRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/scratchpad", (c) => c.json(store.getScratchpad()));

  // ─── Todos ─────────────────────────────────────────────────────────

  app.post("/api/scratchpad/todos", async (c) => {
    const body = await c.req.json();
    if (!body.item || typeof body.item !== "string") return c.json({ success: false, error: "Field 'item' is required" }, 400);
    const todos = store.addScratchpadTodo(body.item.trim());
    return c.json({ success: true, todos }, 201);
  });

  app.put("/api/scratchpad/todos/:index", async (c) => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index)) return c.json({ success: false, error: "Invalid index" }, 400);
    const body = await c.req.json();
    const updates: { status?: "open" | "done"; item?: string } = {};
    if (body.status === "open" || body.status === "done") updates.status = body.status;
    if (typeof body.item === "string") updates.item = body.item;
    const todos = store.updateScratchpadTodo(index, updates);
    if (!todos) return c.json({ success: false, error: "Todo not found" }, 404);
    return c.json({ success: true, todos });
  });

  app.delete("/api/scratchpad/todos/:index", (c) => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index)) return c.json({ success: false, error: "Invalid index" }, 400);
    const todos = store.deleteScratchpadTodo(index);
    if (!todos) return c.json({ success: false, error: "Todo not found" }, 404);
    return c.json({ success: true, todos });
  });

  // ─── Notes ─────────────────────────────────────────────────────────

  app.put("/api/scratchpad/notes", async (c) => {
    const body = await c.req.json();
    if (typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    store.setScratchpadNotes(body.content);
    return c.json({ success: true });
  });
}
