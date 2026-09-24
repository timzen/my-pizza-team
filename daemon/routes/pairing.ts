/**
 * daemon/routes/pairing.ts — Pair with a teammate from the web UI.
 *
 * The HTTP face of `store/pairing.ts` (docs/TEAMMATE_CHAT.md §4):
 *
 * - UI-facing: `POST .../pair` (pause its autonomous work, open the channel),
 *   `POST .../messages` (`{ text, mode: "queue" | "steer" }`, paired only),
 *   `POST .../release` (`{ action: "resume" | "complete" | "fail" }`), and
 *   `GET .../pairing/state`.
 * - Agent-facing: `GET .../pairing` — the teammate's poll. **Drains** queued
 *   messages and a pending release, so each is realized exactly once.
 *
 * Only teammates can be paired: the leader is the chat agent, and you talk to it
 * in the left dock.
 */

import type { RouteContext } from "./types.ts";
import { isPoolTeammate } from "../store.ts";
import { RELEASE_ACTIONS, type ReleaseAction, type SendMode } from "../store/pairing.ts";

/** Longest message accepted from the composer. */
const MAX_MESSAGE_CHARS = 20_000;

export function registerPairingRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const pairing = store.pairing;

  /** 404/400 for anything that isn't a connected teammate; null when fine. */
  const checkTeammate = (id: string): { status: 400 | 404; error: string } | null => {
    const member = store.getMember(id);
    if (!member) return { status: 404, error: `Agent "${id}" not found` };
    if (!isPoolTeammate(member.name)) return { status: 400, error: "Only teammates can be paired (talk to the leader in the chat dock)" };
    return null;
  };

  app.get("/api/agents/:id/pairing/state", (c) => c.json(pairing.getState(c.req.param("id"))));

  app.get("/api/agents/:id/pairing", (c) => c.json(pairing.poll(c.req.param("id"))));

  app.post("/api/agents/:id/pair", (c) => {
    const id = c.req.param("id");
    const bad = checkTeammate(id);
    if (bad) return c.json({ success: false, error: bad.error }, bad.status);
    pairing.pair(id);
    return c.json({ success: true, ...pairing.getState(id) });
  });

  app.post("/api/agents/:id/messages", async (c) => {
    const id = c.req.param("id");
    const bad = checkTeammate(id);
    if (bad) return c.json({ success: false, error: bad.error }, bad.status);
    const body = await c.req.json().catch(() => ({})) as { text?: unknown; mode?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ success: false, error: "Field 'text' is required" }, 400);
    if (text.length > MAX_MESSAGE_CHARS) return c.json({ success: false, error: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` }, 400);
    const mode: SendMode = body.mode === "steer" ? "steer" : "queue";
    const message = pairing.send(id, text, mode);
    if (!message) return c.json({ success: false, error: "Pair with the teammate before messaging it" }, 409);
    return c.json({ success: true, message }, 201);
  });

  app.post("/api/agents/:id/release", async (c) => {
    const id = c.req.param("id");
    const bad = checkTeammate(id);
    if (bad) return c.json({ success: false, error: bad.error }, bad.status);
    const body = await c.req.json().catch(() => ({})) as { action?: unknown };
    const action = (body.action ?? "resume") as ReleaseAction;
    if (!RELEASE_ACTIONS.includes(action)) {
      return c.json({ success: false, error: `Field 'action' must be one of: ${RELEASE_ACTIONS.join(", ")}` }, 400);
    }
    pairing.release(id, action);
    return c.json({ success: true, ...pairing.getState(id) });
  });
}
