/**
 * daemon/routes/assistant.ts — Assistant chat, sessions, and persona routes.
 *
 * Chat v2 (see docs/ASSISTANT_CHAT_V2.md): the assistant chat is a mirror of the
 * agent's Pi session, not a request/response queue. There are no response turns
 * — posting a message always succeeds, delivery receipts advance as the agent
 * picks it up, and the agent's own prose is mirrored back as bubbles (including
 * anything typed in its terminal, `origin: "tui"`).
 *
 * Route groups:
 * - Conversation: read a session's messages, post a message, delete a message
 * - Stream: SSE push for messages, receipts, thinking, session changes
 * - Agent-facing: inbox/ack (deliver to Pi), bubbles (mirror out), thoughts, session report
 * - Sessions: list, new chat, resume, markdown snapshot
 * - Persona: read/swap (a swap ends the session and starts a new one)
 */

import type { RouteContext } from "./types.ts";
import type { AssistantDelivery } from "../store/assistant-chat.ts";

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
 * Chat framing injected ahead of EVERY persona (custom or default). Chat v2
 * shrank this dramatically: the assistant now just *talks*, and the extension
 * mirrors its prose into bubbles by splitting on blank lines. There is no
 * `send_message` tool to teach and no turn-taking rule to explain, because the
 * user really can interrupt at any time. See DESIGN.md ("Assistant chat model").
 */
export const ASSISTANT_CHAT_FRAMING = [
  "# You are in a live chat",
  "",
  "You are talking with the user in a real-time chat interface, like iMessage.",
  "Reply the way a thoughtful person texts: short, direct, a few sentences at a",
  "time. Your reply is shown as chat bubbles \u2014 one per paragraph.",
  "",
  "- Separate distinct points with a blank line; each becomes its own bubble.",
  "- Keep each paragraph short. Prefer a few small bubbles over one dense wall.",
  "- Put any question to the user in its own final paragraph.",
  "- The user can message you at any time, including while you are working. If a",
  "  new message arrives mid-task, acknowledge it before carrying on.",
].join("\n");

/** Compose the effective system prompt: chat framing first, then the persona (or default). */
function composeSystemPrompt(personaBody: string | null): string {
  return `${ASSISTANT_CHAT_FRAMING}\n\n${personaBody ?? DEFAULT_ASSISTANT_PERSONA}`;
}

export function registerAssistantRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  // ─── Conversation ──────────────────────────────────────────────────

  /**
   * The conversation. `sessionId` selects an earlier session (read-only in the
   * UI); omitted means the active one. `thinking` drives the `…` bubble.
   */
  app.get("/api/assistant/messages", (c) => {
    const sessionId = c.req.query("sessionId") || undefined;
    const session = sessionId ? store.getAssistantSession(sessionId) : store.getActiveAssistantSession();
    if (sessionId && !session) return c.json({ success: false, error: "Session not found" }, 404);
    const agent = store.getChatAgent();
    return c.json({
      session,
      messages: store.getAssistantMessages(session?.id),
      thinking: store.isAssistantThinking(),
      // Who answers: the designated leader, or null when none is online.
      chatAgent: agent ? { id: agent.id, name: agent.name } : null,
    });
  });

  /**
   * Send a message. Always accepted — no turn, no lock, no debounce. `replyTo`
   * quotes an earlier bubble; `origin: "tui"` is used by the extension to mirror
   * messages typed in the agent's terminal.
   */
  app.post("/api/assistant/messages", async (c) => {
    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    const userMessage = store.appendUserMessage(body.content, {
      replyTo: typeof body.replyTo === "string" ? body.replyTo : null,
      origin: body.origin === "tui" ? "tui" : "web",
    });
    // Nothing to spawn: a leader answers the chat, so either one is connected or
    // the message waits in the queue until one is.
    return c.json({ success: true, userMessage, chatAgent: store.getChatAgent()?.id ?? null }, 201);
  });

  app.delete("/api/assistant/messages/:id", (c) => {
    const success = store.deleteAssistantMessage(c.req.param("id"));
    if (!success) return c.json({ success: false, error: "Message not found" }, 404);
    return c.json({ success: true });
  });

  // ─── Stream (SSE) ──────────────────────────────────────────────────
  //
  // Bubbles, receipts, and reasoning chunks all need sub-second push — polling
  // made the typing indicator and the thought peek useless. The UI keeps a slow
  // reconciliation poll of /api/assistant/messages as a safety net.

  app.get("/api/assistant/stream", (c) => {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const send = (data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Client vanished mid-write; teardown happens in cancel().
          }
        };
        // Prime the connection so the client can render immediately.
        send({ type: "hello", thinking: store.isAssistantThinking(), session: store.getActiveAssistantSession() });
        unsubscribe = store.subscribeAssistantEvents(send);
        // Comment frames keep proxies (and idle sockets) from closing the stream.
        keepAlive = setInterval(() => {
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* ignore */ }
        }, 15_000);
      },
      cancel() {
        unsubscribe?.();
        if (keepAlive) clearInterval(keepAlive);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  // ─── Agent-facing ──────────────────────────────────────────────────
  //
  // The extension pulls queued messages, hands them to Pi, and mirrors the
  // agent's output back. Nothing here decides *what* the agent says.

  /**
   * Queued user messages, oldest first — but only for the designated chat agent.
   * A multi-host team has several leaders; without this gate they would all pull
   * the same message and answer it in parallel. `chat` tells a non-designated
   * agent to stay quiet (it also stops mirroring its own output).
   */
  app.get("/api/assistant/inbox", (c) => {
    const agentId = c.req.query("agentId") || "";
    const isChatAgent = agentId ? store.isChatAgent(agentId) : false;
    return c.json({ chat: isChatAgent, messages: isChatAgent ? store.getAssistantInbox() : [] });
  });

  /** Advance receipts: 'delivered' (handed to Pi) or 'read' (a run sees them). */
  app.post("/api/assistant/inbox/ack", async (c) => {
    const body = await c.req.json();
    const state = body.state === "read" ? "read" : "delivered";
    // No ids + state 'read' = "everything already delivered is now read", which
    // is what the extension sends on agent_start.
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      if (state === "read") return c.json({ success: true, updated: store.markAssistantDeliveredAsRead() });
      return c.json({ success: false, error: "Field 'ids' is required" }, 400);
    }
    const ids = (body.ids as unknown[]).filter((id): id is string => typeof id === "string");
    return c.json({ success: true, updated: store.ackAssistantInbox(ids, state as AssistantDelivery) });
  });

  /** Mirror one bubble of the agent's reply (one paragraph of its prose). */
  app.post("/api/assistant/bubbles", async (c) => {
    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") return c.json({ success: false, error: "Field 'content' is required" }, 400);
    const message = store.appendAssistantMessage(body.content, body.failed === true);
    return c.json({ success: true, message }, 201);
  });

  /**
   * Ephemeral reasoning peek. `{ chunk }` appends, `{ clear: true }` drops the
   * buffer (a new run started), `{ thinking }` toggles the `…` indicator.
   */
  app.post("/api/assistant/thoughts", async (c) => {
    const body = await c.req.json();
    if (body.clear === true) store.clearAssistantThoughts();
    if (typeof body.thinking === "boolean") store.setAssistantThinking(body.thinking);
    if (typeof body.chunk === "string" && body.chunk) store.appendAssistantThought(body.chunk);
    return c.json({ success: true });
  });

  /** What the agent is (or was just) thinking — the payload behind the `…`. */
  app.get("/api/assistant/thoughts", (c) => c.json(store.getAssistantThoughts()));

  /** The extension reports the Pi session file backing the chat (enables resume). */
  app.post("/api/assistant/session", async (c) => {
    const body = await c.req.json();
    if (!body.piSessionPath || typeof body.piSessionPath !== "string") {
      return c.json({ success: false, error: "Field 'piSessionPath' is required" }, 400);
    }
    return c.json({ success: true, session: store.reportAssistantPiSession(body.piSessionPath) });
  });

  // ─── Sessions ──────────────────────────────────────────────────────

  app.get("/api/assistant/sessions", (c) => c.json({ sessions: store.listAssistantSessions() }));

  /** Start a fresh chat. Ends + snapshots the current session; nothing is lost. */
  app.post("/api/assistant/sessions/new", (c) => {
    const session = store.newAssistantSession("New chat");
    return c.json({ success: true, session }, 201);
  });

  /** Resume an earlier session (switches the agent's Pi session to match). */
  app.post("/api/assistant/sessions/:id/resume", (c) => {
    const session = store.resumeAssistantSession(c.req.param("id"));
    if (!session) return c.json({ success: false, error: "Session not found" }, 404);
    // Without a recorded Pi session file the agent can't restore in-agent
    // context; the UI shows the transcript and warns (see §6.2 "degraded resume").
    return c.json({ success: true, session, contextRestored: !!session.piSessionPath });
  });

  app.get("/api/assistant/sessions/:id/snapshot", (c) => {
    const markdown = store.getAssistantSessionSnapshot(c.req.param("id"));
    if (markdown === null) return c.json({ success: false, error: "Session not found" }, 404);
    return c.text(markdown);
  });

  // ─── Persona ───────────────────────────────────────────────────────
  //
  // The active persona is a context-library entry id. GET resolves it to the
  // entry (null if unset or deleted). PUT swaps it: because a persona change is
  // a change of who you're talking to, it ends the current session (snapshotted)
  // and opens a new one — it no longer deletes the transcript.

  app.get("/api/assistant/persona", (c) => {
    const personaId = store.getAssistantPersonaId();
    const entry = personaId ? store.getContextEntry(personaId) : null;
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
    const entry = personaId ? store.getContextEntry(personaId) : null;
    // End the old session and start a fresh one as the new persona.
    const session = store.newAssistantSession(`New chat as ${entry ? entry.title : "the default assistant"}`);
    return c.json({
      success: true,
      personaId,
      entry,
      session,
      systemPrompt: composeSystemPrompt(entry ? entry.content : null),
    });
  });
}
