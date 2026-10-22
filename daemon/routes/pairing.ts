/**
 * daemon/routes/pairing.ts — Pair with a teammate from the web UI.
 *
 * The HTTP face of `store/pairing.ts` (docs/DESIGN.md "Watching and Pairing with a Teammate"):
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
 *
 * One exception, for the assistant's terminal mode (`assistant.chatMode:
 * "terminal"`, docs/DESIGN.md "Assistant Chat Model"): the dock renders the same
 * transcript and `PairComposer` as a teammate's page, pointed at the leader, so
 * `POST /api/agents/<leader>/messages` is accepted too. There is no pair/release
 * step for the leader — those exist to pause a work loop and settle a held work
 * item, and the leader has neither — so its messages are always accepted and go
 * into the assistant inbox (with the chosen `mode`), the way the leader already
 * receives every chat message. Pair and release stay teammate-only.
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
    // Experimental ACP teammates (`mpt agent`) don't poll for pairing yet: accepting
    // would pause nothing and leave the UI waiting on a teammate that never answers.
    if (member.harness && member.harness !== "pi") return { status: 400, error: `Pairing isn't supported for ${member.harness} teammates yet` };
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

  /**
   * Is `id` the leader? By its member name when connected, else by the id
   * itself (the leader registers as "leader") — so, like the chat composer, a
   * message to an offline leader waits in the inbox instead of failing.
   */
  const isLeaderId = (id: string): boolean => !isPoolTeammate(store.getMember(id)?.name ?? id);

  app.post("/api/agents/:id/messages", async (c) => {
    const id = c.req.param("id");
    const leader = isLeaderId(id);
    const bad = leader ? null : checkTeammate(id);
    if (bad) return c.json({ success: false, error: bad.error }, bad.status);
    const body = await c.req.json().catch(() => ({})) as { text?: unknown; mode?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ success: false, error: "Field 'text' is required" }, 400);
    if (text.length > MAX_MESSAGE_CHARS) return c.json({ success: false, error: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` }, 400);
    const mode: SendMode = body.mode === "steer" ? "steer" : "queue";
    if (leader) {
      // Terminal mode: the leader's inbox is the assistant chat (see the header).
      const message = store.appendUserMessage(text, { origin: "web", mode });
      return c.json({ success: true, message }, 201);
    }
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
