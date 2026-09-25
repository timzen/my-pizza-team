/**
 * tests/usage-grid.test.ts — The Usage dashboard's grid math
 * (ui/src/lib/usage.ts): 53 Sunday-first weeks ending this week, future days
 * out of range, quartile shade levels, and compact formatting.
 */

import { assertEquals } from "@std/assert";
import { buildGrid, formatTokens, formatUsd, levelOf, levelThresholds, monthLabels, type UsageDay } from "../ui/src/lib/usage.ts";

const day = (date: string, tokens: number, costUsd = 0): UsageDay => ({
  date, tokens, costUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runs: 1, byKind: {},
});

Deno.test("buildGrid: 53 weeks × 7 days, Sunday-first, ending in today's week", () => {
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

Deno.test("levels: quartiles of non-zero values; zero is level 0", () => {
  const t = levelThresholds([0, 10, 20, 30, 40, 1000]);
  assertEquals(levelOf(0, t), 0);
  assertEquals(levelOf(10, t), 1);
  assertEquals(levelOf(1000, t), 4);
  // One outlier doesn't flatten the rest into level 1.
  assertEquals(levelOf(30, t) >= 2, true);
  assertEquals(levelThresholds([0, 0]), [0, 0, 0]);
});

Deno.test("monthLabels: a label only where a column starts a new month", () => {
  const labels = monthLabels(buildGrid([], "2026-09-24"));
  assertEquals(labels.filter(Boolean).length >= 11, true);
  assertEquals(labels[1], null);
  // No two labels closer than 3 columns (a partial first month is dropped).
  const at = labels.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  assertEquals(at.every((i, k) => k === 0 || i - at[k - 1]! >= 3), true);
});

Deno.test("formatting: compact tokens, sub-cent dollars", () => {
  assertEquals(formatTokens(999), "999");
  assertEquals(formatTokens(1234), "1.2k");
  assertEquals(formatTokens(2_000_000), "2M");
  assertEquals(formatTokens(123_456_789), "123M");
  assertEquals(formatUsd(0.004), "<$0.01");
  assertEquals(formatUsd(0), "$0.00");
  assertEquals(formatUsd(3.456), "$3.46");
});
