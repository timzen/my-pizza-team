/**
 * lib/run-count.ts — Execution-count rules for the WorkDef lists: the Tasks
 * page's **Never run** filter and its sort orders, plus the row label.
 *
 * `executionCount` comes from the API (derived from the WorkItem table,
 * CANCELED items excluded — docs/DESIGN.md "Execution Count: Derived, not
 * Counted"). Kept pure (no React) so it is unit-tested in tests/run-count.test.ts.
 * A def missing the field (an older daemon) is treated as never run.
 */

/** Which WorkDefs the run filter keeps: all of them, or only the never-run ones (count 0). */
export type RunFilter = "all" | "never";

/** How the Tasks list is ordered. `default` is the API's order. */
export type RunSort = "default" | "runs-asc" | "runs-desc";

/** The sort choices in display order, with their labels. */
export const RUN_SORTS: ReadonlyArray<{ value: RunSort; label: string }> = [
  { value: "default", label: "Default order" },
  { value: "runs-asc", label: "Fewest runs" },
  { value: "runs-desc", label: "Most runs" },
];

interface Counted { executionCount?: number }

const countOf = (d: Counted) => d.executionCount ?? 0;

/** Keep the WorkDefs `filter` asks for, in their original order. */
export function filterByRuns<T extends Counted>(defs: readonly T[], filter: RunFilter): T[] {
  return filter === "never" ? defs.filter((d) => countOf(d) === 0) : [...defs];
}

/** How many of `defs` have never run (the filter button's count). */
export function countNeverRun(defs: readonly Counted[]): number {
  return defs.filter((d) => countOf(d) === 0).length;
}

/**
 * Order `defs` by run count. The sort is stable, so ties keep the API's order —
 * the list doesn't reshuffle between polls when counts are equal.
 */
export function sortByRuns<T extends Counted>(defs: readonly T[], sort: RunSort): T[] {
  const out = [...defs];
  if (sort === "runs-asc") out.sort((a, b) => countOf(a) - countOf(b));
  else if (sort === "runs-desc") out.sort((a, b) => countOf(b) - countOf(a));
  return out;
}

/** The row label: "never run", "1 run", "3 runs". */
export function runCountLabel(count: number | undefined): string {
  const n = count ?? 0;
  if (n === 0) return "never run";
  return n === 1 ? "1 run" : `${n} runs`;
}
