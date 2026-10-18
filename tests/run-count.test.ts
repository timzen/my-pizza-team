/**
 * tests/run-count.test.ts — The Tasks page's run-count rules
 * (ui/src/lib/run-count.ts): the Never run filter, the run-count sorts, and
 * the row label. A def missing `executionCount` counts as never run.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { countNeverRun, filterByRuns, runCountLabel, sortByRuns } from "../ui/src/lib/run-count.ts";

const defs = [
  { id: "a", executionCount: 2 },
  { id: "b", executionCount: 0 },
  { id: "c" },
  { id: "d", executionCount: 5 },
  { id: "e", executionCount: 2 },
];

test("filterByRuns: all keeps everything; never keeps count 0 (absent = 0)", () => {
  assertEquals(filterByRuns(defs, "all").map((d) => d.id), ["a", "b", "c", "d", "e"]);
  assertEquals(filterByRuns(defs, "never").map((d) => d.id), ["b", "c"]);
});

test("countNeverRun counts zero-run defs", () => {
  assertEquals(countNeverRun(defs), 2);
  assertEquals(countNeverRun([]), 0);
});

test("sortByRuns: stable ascending/descending; default keeps order; input untouched", () => {
  assertEquals(sortByRuns(defs, "runs-asc").map((d) => d.id), ["b", "c", "a", "e", "d"]);
  assertEquals(sortByRuns(defs, "runs-desc").map((d) => d.id), ["d", "a", "e", "b", "c"]);
  assertEquals(sortByRuns(defs, "default").map((d) => d.id), ["a", "b", "c", "d", "e"]);
  assertEquals(defs.map((d) => d.id), ["a", "b", "c", "d", "e"]);
});

test("runCountLabel: never run / 1 run / n runs", () => {
  assertEquals(runCountLabel(0), "never run");
  assertEquals(runCountLabel(undefined), "never run");
  assertEquals(runCountLabel(1), "1 run");
  assertEquals(runCountLabel(7), "7 runs");
});
