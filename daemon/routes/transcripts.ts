/**
 * daemon/routes/transcripts.ts — Live teammate transcripts (watch-only).
 *
 * The HTTP face of `store/transcripts.ts` (docs/TEAMMATE_CHAT.md §3):
 *
 * - UI-facing: `GET /api/agents/:id/transcript/stream` (SSE). Subscribing *is*
 *   watching — the connection registers a viewer, and the `hello` frame carries
 *   the buffered transcript so the view renders immediately.
 * - Agent-facing: `GET .../transcript/watch` (am I watched? polled by the
 *   extension) and `POST .../transcript` (a batch of entries; the response also
 *   carries `watched`, so a mirror stops promptly when the last viewer's grace
 *   runs out).
 * - `GET .../transcript` returns the buffer as JSON (debugging, tests).
 */

import type { RouteContext } from "./types.ts";

export function registerTranscriptRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const transcripts = store.transcripts;

  app.get("/api/agents/:id/transcript", (c) => {
    const id = c.req.param("id");
    return c.json({ entries: transcripts.getEntries(id), watched: transcripts.isWatched(id) });
  });

  app.get("/api/agents/:id/transcript/watch", (c) => {
    return c.json({ watched: transcripts.isWatched(c.req.param("id")) });
  });

  app.post("/api/agents/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as { entries?: unknown };
    if (!Array.isArray(body.entries)) {
      return c.json({ success: false, error: "Field 'entries' must be an array" }, 400);
    }
    const recorded = transcripts.record(id, body.entries);
    return c.json({ success: true, recorded, watched: transcripts.isWatched(id) });
  });

  // Same SSE shape as /api/assistant/stream (see routes/assistant.ts).
  app.get("/api/agents/:id/transcript/stream", (c) => {
    const id = c.req.param("id");
    const encoder = new TextEncoder();
    let unwatch: (() => void) | null = null;
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
        // Watch first (it may drop the `watch` marker), then prime with the buffer.
        unwatch = transcripts.watch(id, send);
        send({ type: "hello", entries: transcripts.getEntries(id) });
        keepAlive = setInterval(() => {
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* ignore */ }
        }, 15_000);
      },
      cancel() {
        unwatch?.();
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
}
