/**
 * daemon/routes/assistant.ts — Assistant chat + persona routes.
 *
 * The assistant is an append-only chat (user/assistant messages). Sending a
 * user message just appends it; replies are produced by a response "turn" the
 * assistant agent polls, claims (marking the coalesced user messages read),
 * streams bubbles into via `.../say`, then completes. A persona (a
 * context-library entry body) is injected as the system prompt, always behind
 * the shared ASSISTANT_CHAT_FRAMING.
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

/**
 * Chat framing injected ahead of EVERY persona (custom or default). This is the
 * single source of truth for the assistant's chat behavior, so no persona ever
 * has to restate it. It teaches the assistant to reply as a series of short
 * messages via the `send_message` tool — iMessage/WhatsApp style. See DESIGN.md
 * ("Assistant chat model").
 */
export const ASSISTANT_CHAT_FRAMING = [
  "# You are in a live chat",
  "",
  "You are talking with the user in a real-time chat interface, like iMessage or",
  "WhatsApp. Reply the way a thoughtful person texts \u2014 as a few short messages,",
  "not one long wall of text.",
  "",
  "## How to send messages",
  "- Use the `send_message` tool for EVERYTHING the user should see. Call it once",
  "  per chat bubble; call it several times to send several bubbles in a row.",
  "- Do NOT put your answer in your final response text \u2014 only `send_message`",
  "  content is shown to the user.",
  "",
  "## How to batch",
  "- Lead with a one-line headline bubble, then send each distinct point as its",
  "  own bubble.",
  "- Keep each bubble short (a few lines at most). Prefer more small bubbles over",
  "  one dense one.",
  "- Put any question to the user in its own final bubble.",
  "",
  "## Turns",
  "- The user's messages arrive together as one turn, and the user cannot send",
  "  more until you finish \u2014 so address everything they raised before you stop.",
].join("\n");

/** Compose the effective system prompt: chat framing first, then the persona (or default). */
function composeSystemPrompt(personaBody: string | null): string {
  return `${ASSISTANT_CHAT_FRAMING}\n\n${personaBody ?? DEFAULT_ASSISTANT_PERSONA}`;
}

export function registerAssistantRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  // ─── Conversation ──────────────────────────────────────────────────
  //
  // The assistant is a chat. GET returns the full conversation; POST appends a
  // user message and creates the pending assistant turn. The agent-facing
  // next/claim/complete endpoints drive that turn to completion.

  app.get("/api/assistant/messages", (c) => c.json({ messages: store.getAssistantMessages(), activeTurn: store.getActiveTurn() }));

  app.post("/api/assistant/messages", async (c) => {
    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    // A turn owns replies now; sending just appends the user message (append-only chat).
    const userMessage = store.appendUserMessage(body.content);
    return c.json({ success: true, userMessage }, 201);
  });

  // Typing presence: the UI pings this while the user is composing so the
  // pre-claim debounce holds the turn until the user goes quiet (see DESIGN.md).
  app.post("/api/assistant/typing", (c) => {
    store.recordAssistantTyping();
    return c.json({ success: true });
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
      systemPrompt: composeSystemPrompt(entry ? entry.content : null),
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
      systemPrompt: composeSystemPrompt(entry ? entry.content : null),
    });
  });

  // ─── Agent-facing (work the response turn) ──────────────────────────

  app.get("/api/assistant/next", (c) => c.json({ item: store.getNextAssistantItem() }));

  app.post("/api/assistant/messages/:id/claim", (c) => {
    const success = store.claimAssistantItem(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Turn not available" }, 409);
    return c.json({ success: true });
  });

  // Append one assistant chat bubble to the active turn (the `send_message`
  // tool). Lets a single turn stream many bubbles, iMessage-style.
  app.post("/api/assistant/messages/:id/say", async (c) => {
    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    const message = store.appendAssistantMessage(c.req.param("id"), body.content);
    if (!message) return c.json({ success: false, error: "Turn not in processing state" }, 400);
    return c.json({ success: true, message });
  });

  app.post("/api/assistant/messages/:id/complete", async (c) => {
    const body = await c.req.json();
    const success = store.completeAssistantItem(c.req.param("id"), body.result, body.status === "failed");
    if (!success) return c.json({ success: false, error: "Turn not in processing state" }, 400);
    return c.json({ success: true });
  });
}
