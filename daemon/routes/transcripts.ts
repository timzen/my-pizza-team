/**
 * daemon/routes/transcripts.ts — Live teammate transcripts (watch-only).
 *
 * The HTTP face of `store/transcripts.ts` (docs/DESIGN.md "Watching and Pairing with a Teammate"):
 *
 * - UI-facing: `GET /api/agents/:id/transcript/stream` (SSE). Subscribing *is*
 *   watching — the connection registers a viewer, and the `hello` frame carries
 *   the buffered transcript so the view renders immediately.
 * - Agent-facing: `GET .../transcript/watch` (am I watched? polled by the
 *   extension; `backfill: true` says this daemon accepts a backfill) and
 *   `POST .../transcript` (a batch of entries; the response also carries
 *   `watched`, so a mirror stops promptly when the last viewer's grace runs
 *   out). A batch with `backfill: { omitted }` is the agent's session so far and
 *   replaces the buffer; viewers get it as a fresh `hello`.
 * - `GET .../transcript` returns the buffer as JSON (debugging, tests).
 */

import type { RouteContext } from "./types.ts";
import { readBody, fail } from "./http.ts";
import type { TranscriptBackfill, TranscriptWatchResponse } from "../../shared/protocol.ts";

export function registerTranscriptRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const transcripts = store.transcripts;

  app.get("/api/agents/:id/transcript", (c) => {
    const id = c.req.param("id");
    return c.json({ entries: transcripts.getEntries(id), watched: transcripts.isWatched(id) });
  });

  app.get("/api/agents/:id/transcript/watch", (c) => {
    return c.json({ watched: transcripts.isWatched(c.req.param("id")), backfill: true } satisfies TranscriptWatchResponse);
  });

  app.post("/api/agents/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const body = await readBody(c) as { entries?: unknown; backfill?: Partial<TranscriptBackfill> };
    if (!Array.isArray(body.entries)) {
      return fail(c, 400, "Field 'entries' must be an array");
    }
    const backfill = body.backfill && typeof body.backfill === "object" ? body.backfill : null;
    const recorded = backfill
      ? transcripts.backfill(id, body.entries, typeof backfill.omitted === "number" ? backfill.omitted : 0)
      : transcripts.record(id, body.entries);
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
