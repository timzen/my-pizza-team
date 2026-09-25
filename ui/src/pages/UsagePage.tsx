/**
 * UsagePage — The token-usage dashboard (`/usage`, the chart icon in the nav).
 *
 *  - **Tiles**: today, last 7 days, last 30 days, past year — cost first,
 *    tokens beneath — and the peak day.
 *  - **Contribution grid**: 53 weeks × 7 days, shaded by tokens (or cost —
 *    toggle), GitHub-style quartile shades. **Hover** a day for its tokens
 *    (input / output / cache read / cache write), cost, runs, and the split by
 *    kind; **click** it to list that day's runs below.
 *  - **By kind**: the past year's cost split into teammate work, assistant
 *    chat, pairing, and other.
 *
 * Reads `/api/usage/daily` and `/api/usage/day` (daemon/routes/usage.ts), both
 * bucketed by the browser's timezone. Grid math is lib/usage (tested).
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { SegmentedTabs } from "@/components/RouteTabs";
import {
  KIND_LABEL, buildGrid, formatDay, formatTokens, formatUsd, levelOf, levelThresholds, monthLabels,
  type GridCell, type UsageDay, type UsageKind, type UsageMetric, type UsageRun, type UsageTotals,
} from "@/lib/usage";

interface DailyResponse {
  today: string;
  days: UsageDay[];
  totals: { today: UsageTotals; last7: UsageTotals; last30: UsageTotals; range: UsageTotals };
  peak: { date: string; costUsd: number; tokens: number } | null;
}

/** Static shade classes per level (never build class names dynamically — Tailwind's scanner). */
const LEVEL_CLASS = [
  "bg-muted",
  "bg-emerald-200 dark:bg-emerald-900",
  "bg-emerald-400 dark:bg-emerald-700",
  "bg-emerald-500 dark:bg-emerald-500",
  "bg-emerald-700 dark:bg-emerald-300",
] as const;

const KIND_BAR: Record<UsageKind, string> = {
  work: "bg-emerald-500",
  chat: "bg-sky-500",
  pairing: "bg-violet-500",
  other: "bg-muted-foreground/50",
};

const CELL = 12; // px, incl. gap
const TZ = new Date().getTimezoneOffset();

export function UsagePage() {
  const { data } = useApi<DailyResponse>(`/api/usage/daily?days=371&tzOffset=${TZ}`, [], { pollInterval: 60_000 });
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [hover, setHover] = useState<{ cell: GridCell; x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const cols = useMemo(() => (data ? buildGrid(data.days, data.today) : []), [data]);
  const thresholds = useMemo(() => levelThresholds((data?.days ?? []).map((d) => d[metric])), [data, metric]);
  const months = useMemo(() => monthLabels(cols), [cols]);

  if (!data) return <div className="container mx-auto p-6 text-sm text-muted-foreground">Loading usage…</div>;
  const { totals } = data;
  const empty = data.days.length === 0;

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Usage</h1>
        <p className="text-sm text-muted-foreground">Tokens and cost across the team — teammate work, the assistant chat, and pairing.</p>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Today" t={totals.today} />
        <Tile label="Last 7 days" t={totals.last7} />
        <Tile label="Last 30 days" t={totals.last30} />
        <Tile label="Past year" t={totals.range} />
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Peak day</p>
          {data.peak ? (
            <button type="button" className="text-left" onClick={() => setPicked(data.peak!.date)}>
              <p className="text-xl font-semibold">{formatUsd(data.peak.costUsd)}</p>
              <p className="text-xs text-muted-foreground hover:underline">{formatDay(data.peak.date)}</p>
            </button>
          ) : <p className="text-xl font-semibold">—</p>}
        </div>
      </div>

      {/* Grid */}
      <section className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            {formatTokens(totals.range.tokens)} tokens · {formatUsd(totals.range.costUsd)} in the past year
          </h2>
          <SegmentedTabs
            tabs={[{ key: "tokens", label: "Tokens", title: "Shade days by tokens" }, { key: "costUsd", label: "Cost", title: "Shade days by cost" }]}
            active={metric}
            onSelect={(k) => { if (k) setMetric(k as UsageMetric); }}
          />
        </div>

        <div className="relative overflow-x-auto pb-1" onMouseLeave={() => setHover(null)}>
          <div className="inline-flex gap-1">
            {/* Weekday labels */}
            <div className="flex flex-col gap-[2px] pt-4 pr-1 text-[9px] leading-[10px] text-muted-foreground">
              {["", "Mon", "", "Wed", "", "Fri", ""].map((l, i) => <span key={i} className="h-[10px]">{l}</span>)}
            </div>
            <div>
              {/* Month labels */}
              <div className="relative h-4 text-[9px] text-muted-foreground">
                {months.map((m, i) => m && <span key={i} className="absolute" style={{ left: i * CELL }}>{m}</span>)}
              </div>
              <div className="flex gap-[2px]">
                {cols.map((col, ci) => (
                  <div key={ci} className="flex flex-col gap-[2px]">
                    {col.map((cell) => {
                      const v = cell.day ? cell.day[metric] : 0;
                      const level = levelOf(v, thresholds);
                      return (
                        <button
                          key={cell.date}
                          type="button"
                          disabled={!cell.inRange}
                          onClick={() => setPicked(cell.date)}
                          onMouseEnter={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setHover({ cell, x: r.left + r.width / 2, y: r.top });
                          }}
                          className={`h-[10px] w-[10px] rounded-[2px] ${cell.inRange ? LEVEL_CLASS[level] : "bg-transparent"} ${picked === cell.date ? "ring-2 ring-foreground/60" : ""} ${cell.inRange ? "hover:ring-1 hover:ring-foreground/40" : ""}`}
                          aria-label={`${cell.date}: ${cell.day ? `${formatTokens(cell.day.tokens)} tokens, ${formatUsd(cell.day.costUsd)}` : "no usage"}`}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{empty ? "No usage recorded yet — it's counted from every agent run from now on." : "Hover a day for details · click to list its runs"}</span>
          <span className="flex items-center gap-1">
            Less {LEVEL_CLASS.map((c, i) => <span key={i} className={`h-[10px] w-[10px] rounded-[2px] ${c}`} />)} More
          </span>
        </div>
      </section>

      {hover && hover.cell.inRange && <DayTooltip cell={hover.cell} x={hover.x} y={hover.y} />}

      <KindSplit t={data.days} />

      {picked && <DayRuns date={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

function Tile({ label, t }: { label: string; t: UsageTotals }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold">{formatUsd(t.costUsd)}</p>
      <p className="text-xs text-muted-foreground">{formatTokens(t.tokens)} tokens · {t.runs} run{t.runs === 1 ? "" : "s"}</p>
    </div>
  );
}

/** The hover card: fixed-position above the hovered cell. */
function DayTooltip({ cell, x, y }: { cell: GridCell; x: number; y: number }) {
  const d = cell.day;
  return (
    <div
      className="pointer-events-none fixed z-50 w-64 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg"
      style={{ left: x, top: y - 6 }}
    >
      <p className="font-medium">{formatDay(cell.date)}</p>
      {!d ? (
        <p className="mt-0.5 text-muted-foreground">No usage</p>
      ) : (
        <>
          <p className="mt-0.5">
            <span className="font-semibold">{formatTokens(d.tokens)}</span> tokens · <span className="font-semibold">{formatUsd(d.costUsd)}</span> · {d.runs} run{d.runs === 1 ? "" : "s"}
          </p>
          <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-3 text-muted-foreground">
            <dt>Input</dt><dd className="text-right">{formatTokens(d.inputTokens)}</dd>
            <dt>Output</dt><dd className="text-right">{formatTokens(d.outputTokens)}</dd>
            <dt>Cache read</dt><dd className="text-right">{formatTokens(d.cacheReadTokens)}</dd>
            <dt>Cache write</dt><dd className="text-right">{formatTokens(d.cacheWriteTokens)}</dd>
          </dl>
          <div className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
            {(Object.keys(KIND_LABEL) as UsageKind[]).filter((k) => d.byKind[k]).map((k) => (
              <div key={k} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${KIND_BAR[k]}`} />
                <span className="flex-1">{KIND_LABEL[k]}</span>
                <span>{formatUsd(d.byKind[k]!.costUsd)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The past year's cost split by kind, as one stacked bar + legend. */
function KindSplit({ t }: { t: UsageDay[] }) {
  const byKind = new Map<UsageKind, number>();
  for (const d of t) for (const [k, v] of Object.entries(d.byKind) as Array<[UsageKind, UsageTotals]>) byKind.set(k, (byKind.get(k) ?? 0) + v.costUsd);
  const total = [...byKind.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const kinds = (Object.keys(KIND_LABEL) as UsageKind[]).filter((k) => (byKind.get(k) ?? 0) > 0);
  return (
    <section className="rounded-lg border border-border p-4">
      <h2 className="mb-2 text-sm font-semibold">Where it went</h2>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        {kinds.map((k) => <div key={k} className={KIND_BAR[k]} style={{ width: `${(byKind.get(k)! / total) * 100}%` }} title={KIND_LABEL[k]} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {kinds.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${KIND_BAR[k]}`} />{KIND_LABEL[k]}
            <span className="text-muted-foreground">{formatUsd(byKind.get(k)!)} · {Math.round((byKind.get(k)! / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </section>
  );
}

/** One day's runs (click a cell), most expensive first. */
function DayRuns({ date, onClose }: { date: string; onClose: () => void }) {
  const { data } = useApi<{ runs: UsageRun[] }>(`/api/usage/day?date=${date}&tzOffset=${TZ}`, [date]);
  const runs = data?.runs ?? [];
  return (
    <section className="rounded-lg border border-border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{formatDay(date)} — {runs.length} run{runs.length === 1 ? "" : "s"}</h2>
        <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">Close</button>
      </div>
      {data && runs.length === 0 && <p className="text-sm text-muted-foreground">No usage this day.</p>}
      <div className="divide-y divide-border">
        {runs.map((r, i) => (
          <div key={i} className="flex items-center gap-3 py-1.5 text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-full ${KIND_BAR[r.kind]}`} title={KIND_LABEL[r.kind]} />
            <span className="min-w-0 flex-1 truncate">
              {r.refId ? <Link to={`/work-defs/${encodeURIComponent(r.refId)}`} className="hover:underline">{r.title ?? r.refId}</Link> : (r.title ?? KIND_LABEL[r.kind])}
              {r.memberId && <span className="ml-2 text-xs text-muted-foreground">{r.memberId}</span>}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{formatTokens(r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens)}</span>
            <span className="w-16 shrink-0 text-right font-medium">{formatUsd(r.costUsd)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
