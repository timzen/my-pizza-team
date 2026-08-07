/**
 * daemon/routes/thoughts.ts — Thoughts board CRUD, batch positions, and groups.
 *
 * Backs the Thoughts tab: a lighter infinite canvas of markdown sticky notes
 * (a personal workspace/outbox). Two-state lifecycle (active⇄archived), direct
 * delete, pinning as a flag. Files are the source of truth (thoughts/<id>.md +
 * groups.json); this is a thin shell over the store. See docs/ARCHITECTURE.md.
 */

import type { RouteContext } from "./types.ts";
import type { ThoughtStatus } from "../../shared/types.ts";

const COORD_LIMIT = 1e7;

/** A finite coordinate within ±COORD_LIMIT (rejects Infinity / absurd values). */
function validCoord(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT;
}

export function registerThoughtRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  // ─── List / Get ────────────────────────────────────────────────────

  // GET /api/thoughts?status=active|archived — no filter → all. Groups ride
  // along so the canvas renders plates from the same fetch.
  app.get("/api/thoughts", (c) => {
    const status = c.req.query("status");
    return c.json({ thoughts: store.getThoughts(status), groups: store.getThoughtGroups() });
  });

  app.get("/api/thoughts/:id", (c) => {
    const thought = store.getThought(c.req.param("id"));
    if (!thought) return c.json({ success: false, error: "Thought not found" }, 404);
    return c.json({ success: true, thought });
  });

  // ─── Create ────────────────────────────────────────────────────────

  // POST /api/thoughts — content optional (defaults ''); x/y optional as a
  // PAIR (both present → placed there; both absent → auto-placed; one → 400).
  // Unknown groupId → 400.
  app.post("/api/thoughts", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      content?: string; color?: string; x?: number; y?: number; w?: number | null; h?: number | null;
      zIndex?: number; pinned?: boolean; createdBy?: string; groupId?: string;
    };
    const hasX = body.x !== undefined, hasY = body.y !== undefined;
    if (hasX !== hasY) {
      return c.json({ success: false, error: "Fields 'x' and 'y' must be provided together (or both omitted for auto-placement)" }, 400);
    }
    if (hasX && (!validCoord(body.x) || !validCoord(body.y))) {
      return c.json({ success: false, error: `Fields 'x' and 'y' must be finite numbers within ±${COORD_LIMIT}` }, 400);
    }
    if (body.groupId !== undefined && !store.getThoughtGroup(body.groupId)) {
      return c.json({ success: false, error: "Field 'groupId': group not found" }, 400);
    }
    const thought = store.createThought(body);
    return c.json({ success: true, thought }, 201);
  });

  // ─── Batch positions ───────────────────────────────────────────────
  // Registered before the parameterized routes so "positions" is never taken
  // as an :id. One drag gesture → one call; missing ids are skipped.
  app.post("/api/thoughts/positions", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      moves?: Array<{ id: string; x: number; y: number; w?: number | null; h?: number | null; zIndex?: number }>;
    };
    if (!Array.isArray(body.moves)) {
      return c.json({ success: false, updated: [], error: "Field 'moves' (array) is required" }, 400);
    }
    for (const m of body.moves) {
      if (!m || typeof m.id !== "string" || !validCoord(m.x) || !validCoord(m.y)) {
        return c.json({ success: false, updated: [], error: "Each move needs {id, x, y}" }, 400);
      }
      if ((m.w != null && typeof m.w !== "number") || (m.h != null && typeof m.h !== "number")) {
        return c.json({ success: false, updated: [], error: "Move 'w'/'h' must be a number or null" }, 400);
      }
    }
    return c.json({ success: true, updated: store.updateThoughtPositions(body.moves) });
  });

  // ─── Update (partial) ──────────────────────────────────────────────

  app.patch("/api/thoughts/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as {
      content?: string; color?: string; status?: ThoughtStatus; pinned?: boolean;
      groupId?: string | null; x?: number; y?: number; w?: number | null; h?: number | null; zIndex?: number;
    };
    if (!store.getThought(id)) return c.json({ success: false, error: "Thought not found" }, 404);
    if (body.status !== undefined && body.status !== "active" && body.status !== "archived") {
      return c.json({ success: false, error: "Field 'status' must be active|archived" }, 400);
    }
    if ((body.x === undefined) !== (body.y === undefined)) {
      return c.json({ success: false, error: "Fields 'x' and 'y' must be provided together" }, 400);
    }
    if (body.groupId !== undefined && body.groupId !== null && !store.getThoughtGroup(body.groupId)) {
      return c.json({ success: false, error: "Group not found" }, 400);
    }
    const updated = store.updateThought(id, body);
    return c.json({ success: true, thought: updated });
  });

  // ─── Archive / Restore ─────────────────────────────────────────────

  app.post("/api/thoughts/:id/archive", (c) => {
    const updated = store.archiveThought(c.req.param("id"));
    if (!updated) return c.json({ success: false, error: "Thought not found" }, 404);
    return c.json({ success: true, thought: updated });
  });

  app.post("/api/thoughts/:id/restore", (c) => {
    const updated = store.restoreThought(c.req.param("id"));
    if (!updated) return c.json({ success: false, error: "Thought not found" }, 404);
    return c.json({ success: true, thought: updated });
  });

  // ─── Delete (direct — no archive-first guard) ──────────────────────

  app.delete("/api/thoughts/:id", (c) => {
    if (!store.deleteThought(c.req.param("id"))) {
      return c.json({ success: false, error: "Thought not found" }, 404);
    }
    return c.json({ success: true });
  });

  // ─── Groups ────────────────────────────────────────────────────────

  // POST /api/thought-groups — create a group. memberIds optional (omitted =
  // empty group as a drop target); x/y/w/h optional (client places the plate).
  app.post("/api/thought-groups", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { title?: string; memberIds?: string[]; x?: number; y?: number; w?: number; h?: number };
    if (body.memberIds !== undefined &&
      (!Array.isArray(body.memberIds) || body.memberIds.some((m) => typeof m !== "string"))) {
      return c.json({ success: false, error: "Field 'memberIds' must be a string array when present" }, 400);
    }
    for (const k of ["x", "y", "w", "h"] as const) {
      if (body[k] !== undefined && (typeof body[k] !== "number" || !Number.isFinite(body[k]))) {
        return c.json({ success: false, error: `Field '${k}' must be a finite number` }, 400);
      }
    }
    const group = store.createThoughtGroup(body);
    return c.json({ success: true, group }, 201);
  });

  app.patch("/api/thought-groups/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { title?: string; x?: number; y?: number; w?: number; h?: number };
    if (body.title !== undefined && typeof body.title !== "string") {
      return c.json({ success: false, error: "Field 'title' must be a string" }, 400);
    }
    for (const k of ["x", "y", "w", "h"] as const) {
      if (body[k] !== undefined && (typeof body[k] !== "number" || !Number.isFinite(body[k]))) {
        return c.json({ success: false, error: `Field '${k}' must be a finite number` }, 400);
      }
    }
    const group = store.updateThoughtGroup(c.req.param("id"), body);
    if (!group) return c.json({ success: false, error: "Group not found" }, 404);
    return c.json({ success: true, group });
  });

  // DELETE /api/thought-groups/:id — ungroup: clears members' groupId, notes stay.
  app.delete("/api/thought-groups/:id", (c) => {
    if (!store.deleteThoughtGroup(c.req.param("id"))) {
      return c.json({ success: false, error: "Group not found" }, 404);
    }
    return c.json({ success: true });
  });
}
