/**
 * daemon/routes/schedules.ts — Schedule (cron parent) CRUD.
 *
 * A Schedule fires a WorkItem for each WorkDef whose `parent` points at it. It
 * owns only the cron + lastEnqueuedAt (see docs/WORKDEF_UNIFICATION.md). Its
 * child WorkDefs are managed via the /api/work-defs routes.
 */

import type { RouteContext } from "./types.ts";
import type { Schedule } from "../../shared/types.ts";
import type { SchedulesResponse } from "../../shared/protocol.ts";
import { isValidCron } from "../cron.ts";

function view(s: Schedule) {
  return { id: s.id, title: s.title, cron: s.cron, lastEnqueuedAt: s.lastEnqueuedAt };
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
    const body = (await c.req.json()) as { title?: string | null; cron?: string };
    if (body.cron !== undefined && !isValidCron(body.cron)) return c.json({ success: false, error: "Invalid 'cron' expression" }, 400);
    const sched = store.updateScheduleDetails(id, body);
    if (!sched) return c.json({ success: false, error: "Schedule not found" }, 404);
    return c.json({ success: true, schedule: view(sched) });
  });

  app.delete("/api/schedules/:id", (c) => {
    const ok = store.deleteSchedule(c.req.param("id"));
    if (!ok) return c.json({ success: false, error: "Schedule not found" }, 404);
    return c.json({ success: true });
  });
}
