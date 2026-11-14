/**
 * daemon/routes/stalls.ts — Stalled teammates, the user's side (docs/DESIGN.md
 * "Stalled Teammates"):
 *
 *   - `POST /api/agents/:id/interrupt` `{ reason? }` — the teammate page's
 *     **Interrupt**: an `interrupt` self-directive the agent realizes at once
 *     (runtime/interrupt.ts — abort the run in flight, keep the item, nudge the
 *     agent to find out why it hung). 201 with the directive (a pending one is
 *     returned, not doubled); 404 unknown; 409 `unsupported: true` for a
 *     harness that didn't declare `interrupt` — the UI then suggests Pair.
 *   - `GET /api/stalls/notes[?read=false]` and `POST /api/stalls/notes/:id/read[?read=false]`
 *     — the Inbox's one note per stall episode (daemon/stall-notes.ts), read
 *     and marked like the failover notes.
 *
 * Detection itself is on read (Store.getMemberStall) and in the Store's
 * 30-second `checkStalls`; nothing here decides who is stalled.
 */

import type { RouteContext } from "./types.ts";
import { readBody, fail } from "./http.ts";
import type { InterruptResponse, StallNotesResponse } from "../../shared/protocol.ts";

/** The 409 reply's wording for a harness that can't interrupt a run. */
export const INTERRUPT_UNSUPPORTED = "This teammate's harness can't interrupt a run. Pair with it instead, and stop the command from its terminal.";

export function registerStallRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.post("/api/agents/:id/interrupt", async (c) => {
    const id = c.req.param("id");
    const body = await readBody(c) as { reason?: unknown };
    if (body.reason !== undefined && typeof body.reason !== "string") return fail(c, 400, "Field 'reason' must be a string");
    const res = store.requestInterrupt(id, typeof body.reason === "string" ? { reason: body.reason } : {});
    if ("error" in res) {
      return res.error === "unknown"
        ? fail(c, 404, `Agent "${id}" not found`)
        : fail(c, 409, INTERRUPT_UNSUPPORTED, { unsupported: true });
    }
    return c.json({ success: true, directive: res.directive } satisfies InterruptResponse, 201);
  });

  // The Inbox's stall notes, newest first (`?read=false`: only the unread).
  app.get("/api/stalls/notes", (c) => {
    const unreadOnly = c.req.query("read") === "false";
    return c.json({ notes: store.stallNotes.list(unreadOnly) } satisfies StallNotesResponse);
  });

  // Mark a note read (or, with `?read=false`, unread), as the Inbox does a WorkItem.
  app.post("/api/stalls/notes/:id/read", (c) => {
    if (!store.stallNotes.markRead(c.req.param("id"), c.req.query("read") !== "false")) return fail(c, 404, "Note not found");
    return c.json({ success: true });
  });
}
