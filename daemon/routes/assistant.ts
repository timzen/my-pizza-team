/**
 * daemon/routes/assistant.ts — Assistant chat and knowledge base routes.
 *
 * The assistant is a conversation (user/assistant messages). The lead sends
 * messages; each creates a pending assistant turn that the assistant agent
 * polls, claims, and completes. The knowledge base stores categorized
 * markdown notes with BM25 search support.
 */

import type { RouteContext } from "./types.ts";

export function registerAssistantRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  // ─── Conversation ──────────────────────────────────────────────────
  //
  // The assistant is a chat. GET returns the full conversation; POST appends a
  // user message and creates the pending assistant turn. The agent-facing
  // next/claim/complete endpoints drive that turn to completion.

  app.get("/api/assistant/messages", (c) => c.json({ messages: store.getAssistantMessages() }));

  app.post("/api/assistant/messages", async (c) => {
    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    const { userMessage, assistantMessage } = store.sendAssistantMessage(body.content);
    return c.json({ success: true, userMessage, assistantMessage }, 201);
  });

  app.delete("/api/assistant/messages/:id", (c) => {
    const success = store.deleteAssistantMessage(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Message not found" }, 404);
    return c.json({ success: true });
  });

  app.delete("/api/assistant/messages", (c) => {
    store.clearAssistantMessages();
    // Ask any online assistant to start a fresh session so its in-agent
    // conversation context is dropped too (intent only — the leader realizes it).
    for (const m of store.getMembers()) {
      if (m.id === "assistant" || m.name.includes("assistant")) {
        store.createLeaderDirectiveForMember(m.id, "reset-session");
      }
    }
    return c.json({ success: true });
  });

  // ─── Agent-facing (poll the pending turn) ──────────────────────────

  app.get("/api/assistant/next", (c) => c.json({ item: store.getNextAssistantItem() }));

  app.post("/api/assistant/messages/:id/claim", (c) => {
    const success = store.claimAssistantItem(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Turn not available" }, 409);
    return c.json({ success: true });
  });

  app.post("/api/assistant/messages/:id/complete", async (c) => {
    const body = await c.req.json();
    const success = store.completeAssistantItem(c.req.param("id"), body.result, body.status === "failed");
    if (!success) return c.json({ success: false, error: "Turn not in processing state" }, 400);
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
