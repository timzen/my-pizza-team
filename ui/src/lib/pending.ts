/**
 * lib/pending.ts — The pending/active split for WorkDef lists (docs/DESIGN.md
 * "Pending: Write, Review, Activate"): Work → Tasks lists the active
 * ones, Work → Pending the pending ones.
 *
 * Kept pure (no React) so the rule is unit-tested (tests/pending-ui.test.ts). A
 * WorkDef without a `pending` flag is active — that's every WorkDef written
 * before pending existed.
 */

/** Which WorkDefs a list shows: everything, only pending, or only active ones. */
export type PendingFilter = "all" | "pending" | "active";

/** The filter choices in display order, with their button labels. */
export const PENDING_FILTERS: ReadonlyArray<{ value: PendingFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "active", label: "Active" },
];

/** Keep the WorkDefs `filter` asks for, in their original order. */
export function filterByPending<T extends { pending?: boolean }>(defs: readonly T[], filter: PendingFilter): T[] {
  if (filter === "pending") return defs.filter((d) => d.pending === true);
  if (filter === "active") return defs.filter((d) => d.pending !== true);
  return [...defs];
}

/** How many of `defs` are pending (the filter button's count). */
export function countPending(defs: readonly { pending?: boolean }[]): number {
  return defs.filter((d) => d.pending === true).length;
}
