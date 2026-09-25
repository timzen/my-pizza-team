/**
 * lib/usage — Pure helpers for the Usage dashboard: laying out the
 * contribution-style grid (53 weeks × 7 days, Sunday-first columns ending in
 * the current week), bucketing days into shade levels, and formatting tokens /
 * dollars. No DOM, so it's unit-tested (tests/usage-grid.test.ts).
 */

export type UsageKind = "work" | "pairing" | "chat" | "other";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokens: number;
  costUsd: number;
  runs: number;
}

export interface UsageDay extends UsageTotals {
  date: string;
  byKind: Partial<Record<UsageKind, UsageTotals>>;
}

export interface UsageRun {
  at: string;
  kind: UsageKind;
  refId: string | null;
  title: string | null;
  memberId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** What the grid shades by. */
export type UsageMetric = "tokens" | "costUsd";

export const KIND_LABEL: Record<UsageKind, string> = {
  work: "Teammate work",
  chat: "Assistant chat",
  pairing: "Pairing",
  other: "Other",
};

/** One grid cell: a calendar day (possibly in the future → `inRange: false`). */
export interface GridCell {
  date: string;
  day: UsageDay | null;
  inRange: boolean;
}

/** YYYY-MM-DD for a UTC-noon Date (grid math is done in "calendar" space). */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parse(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

/**
 * The grid's columns (weeks, oldest first), each 7 cells Sunday→Saturday. The
 * last column is the week containing `today`; days after `today` are
 * `inRange: false` (drawn empty, like GitHub's).
 */
export function buildGrid(days: UsageDay[], today: string, weeks = 53): GridCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const end = parse(today);
  // Sunday of the current week, then back (weeks - 1) weeks.
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - end.getUTCDay() - (weeks - 1) * 7);
  const cols: GridCell[][] = [];
  const cur = new Date(start);
  for (let w = 0; w < weeks; w++) {
    const col: GridCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = iso(cur);
      col.push({ date, day: byDate.get(date) ?? null, inRange: date <= today });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    cols.push(col);
  }
  return cols;
}

/**
 * Shade thresholds from the non-zero values (quartiles), GitHub-style: level 0
 * is "none", 1–4 climb through the quartiles, so a single huge day doesn't wash
 * every other day out to the lightest shade.
 */
export function levelThresholds(values: number[]): [number, number, number] {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return [0, 0, 0];
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]!;
  return [q(0.25), q(0.5), q(0.75)];
}

/** 0 (nothing) … 4 (top quartile). */
export function levelOf(value: number, t: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= t[0]) return 1;
  if (value <= t[1]) return 2;
  if (value <= t[2]) return 3;
  return 4;
}

/** 1.2k / 3.4M / 5.6B — compact token counts. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [v, s] of units) {
    if (n >= v) {
      const x = n / v;
      return `${x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, "")}${s}`;
    }
  }
  return String(n);
}

/** $0.00 dollars; sub-cent spend shows as "<$0.01" rather than a misleading $0.00. */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Tue, Sep 23, 2026" for a YYYY-MM-DD (rendered in calendar space, not shifted by TZ). */
export function formatDay(date: string): string {
  return parse(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Month label for a column: the month name when this column starts a new
 * month — dropped when the next label is under 3 columns away (a partial first
 * month), so labels never collide.
 */
export function monthLabels(cols: GridCell[][]): Array<string | null> {
  let last = "";
  const labels = cols.map((col) => {
    const m = col[0]!.date.slice(0, 7);
    if (m === last) return null;
    last = m;
    return parse(col[0]!.date).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
  });
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const next = labels.findIndex((l, j) => j > i && l !== null);
    if (next !== -1 && next - i < 3) labels[i] = null;
  }
  return labels;
}
