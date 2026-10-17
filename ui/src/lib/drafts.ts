/**
 * lib/drafts.ts — The Tasks page's draft filter (docs/DESIGN.md "Drafts: Write,
 * Review, Publish").
 *
 * Kept pure (no React) so the rule is unit-tested (tests/drafts-ui.test.ts). A
 * WorkDef without a `draft` flag is published — that's every WorkDef written
 * before drafts existed.
 */

/** Which WorkDefs a list shows: everything, only drafts, or only published ones. */
export type DraftFilter = "all" | "drafts" | "published";

/** The filter choices in display order, with their button labels. */
export const DRAFT_FILTERS: ReadonlyArray<{ value: DraftFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "drafts", label: "Drafts" },
  { value: "published", label: "Published" },
];

/** Keep the WorkDefs `filter` asks for, in their original order. */
export function filterByDraft<T extends { draft?: boolean }>(defs: readonly T[], filter: DraftFilter): T[] {
  if (filter === "drafts") return defs.filter((d) => d.draft === true);
  if (filter === "published") return defs.filter((d) => d.draft !== true);
  return [...defs];
}

/** How many of `defs` are drafts (the filter button's count). */
export function countDrafts(defs: readonly { draft?: boolean }[]): number {
  return defs.filter((d) => d.draft === true).length;
}
