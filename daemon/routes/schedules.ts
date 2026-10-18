/**
 * daemon/routes/schedules.ts — Schedule (cron parent) CRUD and pending ⇄ active.
 *
 * A Schedule fires a WorkItem for each WorkDef whose `parent` points at it. It
 * owns only the cron, its runtime cursor, and its reversible `pending` flag (see
 * docs/DESIGN.md "WorkDefs & Parents" and "Pending schedules: reversible, no
 * catch-up"). Its child WorkDefs are managed via the /api/work-defs routes.
 */

import type { RouteContext } from "./types.ts";
import type { Schedule } from "../../shared/types.ts";
import type { ScheduleView, SchedulesResponse, SetSchedulePendingResponse, UpdateScheduleRequest } from "../../shared/protocol.ts";
import { isValidCron } from "../cron.ts";

function view(s: Schedule): ScheduleView {
  return { id: s.id, title: s.title, cron: s.cron, lastEnqueuedAt: s.lastEnqueuedAt, pending: s.pending === true };
}

export function registerScheduleRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/schedules", (c) => {
    return c.json({ schedules: store.getSchedules().map(view) } satisfies SchedulesResponse);
  });

  app.get("/api/schedules/:id", (c) => {
    const sched = store.getSchedule(c.req.param("id"));
    if (!sched) return c.json({ success: false, error: "Schedule not found" }, 404);
    return c.json({ schedule: view(sched) });
  });

  app.put("/api/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as UpdateScheduleRequest;
    if (body.cron !== undefined && !isValidCron(body.cron)) return c.json({ success: false, error: "Invalid 'cron' expression" }, 400);
    if (body.pending !== undefined && typeof body.pending !== "boolean") return c.json({ success: false, error: "'pending' must be a boolean" }, 400);
    const sched = store.updateScheduleDetails(id, body);
    if (!sched) return c.json({ success: false, error: "Schedule not found" }, 404);
    return c.json({ success: true, schedule: view(sched) });
  });

  // ─── Pending ⇄ Active ──────────────────────────────────────────────
  // The same as PUT { pending }, as explicit verbs (mirrors the story routes).
  // Reversible; activating resumes at the next cron occurrence, no catch-up.

  app.post("/api/schedules/:id/pending", (c) => {
    const id = c.req.param("id");
    const sched = store.setSchedulePending(id, true);
    if (!sched) return c.json({ success: false, error: `Schedule "${id}" not found` } satisfies SetSchedulePendingResponse, 404);
    return c.json({ success: true, schedule: view(sched) } satisfies SetSchedulePendingResponse);
  });

  app.post("/api/schedules/:id/activate", (c) => {
    const id = c.req.param("id");
    const sched = store.setSchedulePending(id, false);
    if (!sched) return c.json({ success: false, error: `Schedule "${id}" not found` } satisfies SetSchedulePendingResponse, 404);
    return c.json({ success: true, schedule: view(sched) } satisfies SetSchedulePendingResponse);
  });

  app.delete("/api/schedules/:id", (c) => {
    const ok = store.deleteSchedule(c.req.param("id"));
    if (!ok) return c.json({ success: false, error: "Schedule not found" }, 404);
    return c.json({ success: true });
  });
}
