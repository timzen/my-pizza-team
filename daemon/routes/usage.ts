/**
 * daemon/routes/usage.ts — Token usage: the agent-facing report for any run,
 * and the Usage dashboard's reads.
 *
 * - `POST /api/agents/:id/usage` — the harness reports one run's usage:
 *   `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, model,
 *   costUsd?, kind, workItemId? }`. With a `workItemId` it's recorded on that
 *   item's WorkDef ref (so per-task cost rollups include it); without one it's
 *   a ref-less run (the leader's chat, a teammate between items).
 * - `GET /api/usage/daily?days=&tzOffset=` — per local day (the grid) plus
 *   range totals. `tzOffset` is the browser's `getTimezoneOffset()`.
 * - `GET /api/usage/day?date=YYYY-MM-DD&tzOffset=` — that day's runs.
 *
 * The ledger itself (never deleted, kinds, title snapshots) is store/usage.ts.
 */

import type { RouteContext } from "./types.ts";
import { estimateTokenCost } from "../token-cost.ts";
import { sumDays, USAGE_KINDS, type UsageDay, type UsageKind } from "../store/usage.ts";

/** Longest range the grid asks for: a year plus a partial week. */
const MAX_DAYS = 371;
const DAY_MS = 86_400_000;

/** Parse the offset param; clamp to real-world offsets (±14h). */
function tzOffsetOf(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(-840, Math.min(840, Math.round(n))) : 0;
}

/** Non-negative integer token count, or 0. */
function tokens(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function registerUsageRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.post("/api/agents/:id/usage", async (c) => {
    const memberId = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.model !== "string" || !body.model) {
      return c.json({ success: false, error: "Field 'model' is required" }, 400);
    }
    const kind = (USAGE_KINDS as readonly string[]).includes(String(body.kind)) ? (body.kind as UsageKind) : "other";
    const inputTokens = tokens(body.inputTokens), outputTokens = tokens(body.outputTokens);
    const cacheReadTokens = tokens(body.cacheReadTokens), cacheWriteTokens = tokens(body.cacheWriteTokens);
    // Prefer the harness-reported cost (accurate + cache-aware); estimate only
    // as a fallback.
    const costUsd = typeof body.costUsd === "number" && Number.isFinite(body.costUsd)
      ? body.costUsd
      : estimateTokenCost(body.model, inputTokens, outputTokens);
    const extra = { cacheReadTokens, cacheWriteTokens, kind, memberId };

    const item = typeof body.workItemId === "string" ? store.getWorkItem(body.workItemId) : null;
    if (item) {
      store.addTokenUsageForRef(item.ref, inputTokens, outputTokens, body.model, costUsd, extra);
    } else {
      store.recordRunUsage({ ...extra, inputTokens, outputTokens, model: body.model, costUsd, title: kind === "chat" ? "Assistant chat" : null });
    }
    return c.json({ success: true, costUsd });
  });

  app.get("/api/usage/daily", (c) => {
    const days = Math.max(1, Math.min(MAX_DAYS, Number(c.req.query("days")) || MAX_DAYS));
    const tzOffsetMin = tzOffsetOf(c.req.query("tzOffset"));
    // A little slack before the window so the first local day is complete.
    const sinceMs = Date.now() - days * DAY_MS - DAY_MS;
    const rows = store.getDailyUsage({ sinceMs, tzOffsetMin });

    // Range tiles are computed against the client's "today".
    const todayLocal = new Date(Date.now() - tzOffsetMin * 60_000).toISOString().slice(0, 10);
    const within = (n: number) => {
      const cutoff = new Date(Date.parse(todayLocal) - (n - 1) * DAY_MS).toISOString().slice(0, 10);
      return rows.filter((d) => d.date >= cutoff && d.date <= todayLocal);
    };
    const peak = rows.reduce<UsageDay | null>((best, d) => (!best || d.costUsd > best.costUsd ? d : best), null);

    return c.json({
      today: todayLocal,
      days: rows,
      totals: {
        today: sumDays(within(1)),
        last7: sumDays(within(7)),
        last30: sumDays(within(30)),
        range: sumDays(rows),
      },
      peak: peak ? { date: peak.date, costUsd: peak.costUsd, tokens: peak.tokens } : null,
    });
  });

  app.get("/api/usage/day", (c) => {
    const date = c.req.query("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ success: false, error: "Query 'date' must be YYYY-MM-DD" }, 400);
    return c.json({ date, runs: store.getUsageRunsOnDay({ date, tzOffsetMin: tzOffsetOf(c.req.query("tzOffset")) }) });
  });
}
