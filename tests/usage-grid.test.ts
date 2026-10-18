/**
 * tests/usage-grid.test.ts — The Usage dashboard's grid math
 * (ui/src/lib/usage.ts): 53 Sunday-first weeks ending this week, future days
 * out of range, quartile shade levels, token counting with/without cache
 * reads, the "Include cached" preference, and compact formatting.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import {
  buildGrid, formatTokens, formatUsd, INCLUDE_CACHED_KEY, levelOf, levelThresholds, metricOf, monthLabels, peakDay,
  readIncludeCached, tokensOf, writeIncludeCached, type UsageDay,
} from "../ui/src/lib/usage.ts";

const day = (date: string, tokens: number, costUsd = 0): UsageDay => ({
  date, tokens, costUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runs: 1, byKind: {},
});

test("buildGrid: 53 weeks × 7 days, Sunday-first, ending in today's week", () => {
  // 2026-09-24 is a Thursday.
  const cols = buildGrid([day("2026-09-24", 5)], "2026-09-24");
  assertEquals(cols.length, 53);
  assertEquals(cols.every((c) => c.length === 7), true);
  const last = cols[52]!;
  assertEquals(last[0]!.date, "2026-09-20"); // Sunday
  assertEquals(last[4]!.date, "2026-09-24"); // today (Thursday)
  assertEquals(last[4]!.day?.tokens, 5);
  assertEquals(last[5]!.inRange, false); // Friday is in the future
  assertEquals(cols[0]![0]!.date, "2025-09-21"); // 52 weeks before that Sunday
});

test("levels: quartiles of non-zero values; zero is level 0", () => {
  const t = levelThresholds([0, 10, 20, 30, 40, 1000]);
  assertEquals(levelOf(0, t), 0);
  assertEquals(levelOf(10, t), 1);
  assertEquals(levelOf(1000, t), 4);
  // One outlier doesn't flatten the rest into level 1.
  assertEquals(levelOf(30, t) >= 2, true);
  assertEquals(levelThresholds([0, 0]), [0, 0, 0]);
});

test("monthLabels: a label only where a column starts a new month", () => {
  const labels = monthLabels(buildGrid([], "2026-09-24"));
  assertEquals(labels.filter(Boolean).length >= 11, true);
  assertEquals(labels[1], null);
  // No two labels closer than 3 columns (a partial first month is dropped).
  const at = labels.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  assertEquals(at.every((i, k) => k === 0 || i - at[k - 1]! >= 3), true);
});

test("formatting: compact tokens, sub-cent dollars", () => {
  assertEquals(formatTokens(999), "999");
  assertEquals(formatTokens(1234), "1.2k");
  assertEquals(formatTokens(2_000_000), "2M");
  assertEquals(formatTokens(123_456_789), "123M");
  assertEquals(formatUsd(0.004), "<$0.01");
  assertEquals(formatUsd(0), "$0.00");
  assertEquals(formatUsd(3.456), "$3.46");
});

/** A day with explicit token parts; `tokens` is the API's all-four sum. */
const parts = (date: string, inp: number, out: number, cr: number, cw: number, costUsd = 0): UsageDay => ({
  date, inputTokens: inp, outputTokens: out, cacheReadTokens: cr, cacheWriteTokens: cw,
  tokens: inp + out + cr + cw, costUsd, runs: 1, byKind: {},
});

test("tokensOf: cache reads excluded by default, cache writes always counted", () => {
  const d = parts("2026-09-24", 100, 20, 5000, 30);
  assertEquals(tokensOf(d, false), 150);
  // Including cached restores the API's all-four total.
  assertEquals(tokensOf(d, true), 5150);
  assertEquals(tokensOf(d, true), d.tokens);
  // Works on runs too (no `tokens` field).
  assertEquals(tokensOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 8 }, false), 11);
});

test("metricOf: cost ignores the toggle", () => {
  const d = parts("2026-09-24", 100, 20, 5000, 30, 1.25);
  assertEquals(metricOf(d, "costUsd", false), 1.25);
  assertEquals(metricOf(d, "costUsd", true), 1.25);
  assertEquals(metricOf(d, "tokens", false), 150);
  assertEquals(metricOf(d, "tokens", true), 5150);
});

test("shade thresholds follow the toggle", () => {
  // Day b is the biggest only because of cache reads.
  const days = [parts("a", 400, 0, 0, 0), parts("b", 10, 0, 10_000, 0), parts("c", 200, 0, 0, 0), parts("d", 100, 0, 0, 0), parts("e", 300, 0, 0, 0)];
  const off = levelThresholds(days.map((d) => metricOf(d, "tokens", false)));
  const on = levelThresholds(days.map((d) => metricOf(d, "tokens", true)));
  assertEquals(levelOf(metricOf(days[1]!, "tokens", false), off), 1);
  assertEquals(levelOf(metricOf(days[1]!, "tokens", true), on), 4);
});

test("peakDay: by the selected metric and toggle", () => {
  const days = [parts("a", 400, 0, 0, 0, 5), parts("b", 10, 0, 10_000, 0, 1)];
  assertEquals(peakDay(days, "tokens", false)?.date, "a");
  assertEquals(peakDay(days, "tokens", true)?.date, "b");
  assertEquals(peakDay(days, "costUsd", true)?.date, "a");
  assertEquals(peakDay([], "tokens", false), null);
});

test("Include cached pref: off by default, remembered, tolerant of blocked storage", () => {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assertEquals(readIncludeCached(storage), false);
  assertEquals(readIncludeCached(undefined), false);
  writeIncludeCached(storage, true);
  assertEquals(m.get(INCLUDE_CACHED_KEY), "on");
  assertEquals(readIncludeCached(storage), true);
  writeIncludeCached(storage, false);
  assertEquals(readIncludeCached(storage), false);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assertEquals(readIncludeCached(blocked), false);
  writeIncludeCached(blocked, true); // no throw
});
