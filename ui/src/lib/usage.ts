/**
 * lib/usage — Pure helpers for the Usage dashboard: laying out the
 * contribution-style grid (53 weeks × 7 days, Sunday-first columns ending in
 * the current week), bucketing days into shade levels, counting tokens with or
 * without cache reads, and formatting tokens / dollars. No DOM, so it's
 * unit-tested (tests/usage-grid.test.ts).
 *
 * **Token counting.** The API's `tokens` field sums all four parts (input,
 * output, cache read, cache write). Cache reads are cheap and pile up fast on
 * long sessions — they swamp the rest — so the dashboard counts
 * input + output + cache write by default and adds cache reads back only when
 * "Include cached" is on (`tokensOf`). The math is done here from the separate
 * fields; the stored data and costs are untouched.
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

/** The four token fields every usage record carries (day, kind bucket, run). */
export type TokenParts = Pick<UsageTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">;

/**
 * Tokens as the dashboard counts them: input + output + cache write, plus
 * cache read only when `includeCached` is on (see the header comment).
 */
export function tokensOf(t: TokenParts, includeCached: boolean): number {
  return t.inputTokens + t.outputTokens + t.cacheWriteTokens + (includeCached ? t.cacheReadTokens : 0);
}

/** A record's value for the shading metric: tokens (per the toggle) or cost, which never changes with it. */
export function metricOf(t: TokenParts & { costUsd: number }, metric: UsageMetric, includeCached: boolean): number {
  return metric === "costUsd" ? t.costUsd : tokensOf(t, includeCached);
}

/** The day with the highest value for `metric` (first wins a tie), or null with no usage. */
export function peakDay(days: UsageDay[], metric: UsageMetric, includeCached: boolean): UsageDay | null {
  let best: UsageDay | null = null;
  for (const d of days) {
    if (!best || metricOf(d, metric, includeCached) > metricOf(best, metric, includeCached)) best = d;
  }
  return best;
}

/** localStorage key for the "Include cached" toggle. */
export const INCLUDE_CACHED_KEY = "mpt.usage.includeCached";

/** The minimal slice of `Storage` the pref helpers use (passed in, so they're testable). */
export type PrefStorage = Pick<Storage, "getItem" | "setItem">;

/** Is "Include cached" on? **Off by default** — only an explicit "on" turns it on. */
export function readIncludeCached(storage: PrefStorage | undefined): boolean {
  try {
    return storage?.getItem(INCLUDE_CACHED_KEY) === "on";
  } catch {
    return false; // storage blocked (private mode, sandboxed iframe)
  }
}

/** Remember the toggle. Failures are ignored: it's a preference, not data. */
export function writeIncludeCached(storage: PrefStorage | undefined, on: boolean): void {
  try {
    storage?.setItem(INCLUDE_CACHED_KEY, on ? "on" : "off");
  } catch { /* ignore */ }
}

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
