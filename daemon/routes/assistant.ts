/**
 * daemon/routes/assistant.ts — Assistant chat + persona routes.
 *
 * The assistant is a conversation (user/assistant messages). The lead sends
 * messages; each creates a pending assistant turn that the assistant agent
 * polls, claims, and completes. The assistant can also adopt a "persona" — a
 * context-library entry whose body is injected as its system prompt.
 */

import type { RouteContext } from "./types.ts";

/**
 * The default assistant persona. When no context-library persona is selected,
 * the daemon supplies this as the assistant's system prompt so it always has
 * role framing (the harness no longer hardcodes any). Picking a persona in the
 * UI replaces this entirely.
 */
export const DEFAULT_ASSISTANT_PERSONA = [
  "You are the team assistant for a \"pizza team\" \u2014 a small group of AI teammates",
  "coordinated by the my-pizza-team daemon.",
  "",
  "Help the user run the team and its work. Using your available tools you can",
  "create and edit stories, add tasks, queue requests for the team, curate the",
  "shared context library, and report team status.",
  "",
  "Keep replies concise. When you take actions, briefly summarize what you did.",
].join("\n");

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
    store.resetAssistantSessions();
    return c.json({ success: true });
  });

  // ─── Persona ─────────────────────────────────────────────────
  //
  // The active persona is a context-library entry id. GET resolves it to the
  // entry (null if unset or the entry was deleted). PUT swaps it: setting a
  // persona starts a fresh chat as that persona (clears the transcript and
  // resets the assistant session).

  app.get("/api/assistant/persona", (c) => {
    const personaId = store.getAssistantPersonaId();
    const entry = personaId ? store.getContextEntry(personaId) : null;
    // If the stored persona points at a deleted entry, report no persona.
    // `systemPrompt` is the effective text to inject: the entry body when a
    // persona is set, otherwise the daemon's default assistant persona.
    return c.json({
      personaId: entry ? personaId : null,
      entry,
      systemPrompt: entry ? entry.content : DEFAULT_ASSISTANT_PERSONA,
    });
  });

  app.put("/api/assistant/persona", async (c) => {
    const body = await c.req.json();
    const personaId: string | null = typeof body.personaId === "string" ? body.personaId : null;
    if (personaId) {
      const entry = store.getContextEntry(personaId);
      if (!entry) return c.json({ success: false, error: "Context entry not found" }, 404);
    }
    store.setAssistantPersonaId(personaId);
    // Swapping personas starts a fresh conversation in the new persona.
    store.clearAssistantMessages();
    store.resetAssistantSessions();
    const entry = personaId ? store.getContextEntry(personaId) : null;
    return c.json({
      success: true,
      personaId,
      entry,
      systemPrompt: entry ? entry.content : DEFAULT_ASSISTANT_PERSONA,
    });
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
}
