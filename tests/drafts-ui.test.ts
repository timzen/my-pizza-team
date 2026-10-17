/**
 * tests/drafts-ui.test.ts — The Tasks page's draft filter (ui/src/lib/drafts.ts).
 *
 * A WorkDef with no `draft` flag is published, so old WorkDefs never show up
 * under "Drafts".
 */

import { assertEquals } from "@std/assert";
import { countDrafts, filterByDraft } from "../ui/src/lib/drafts.ts";

const defs = [
  { id: "a", draft: true },
  { id: "b", draft: false },
  { id: "c" },
  { id: "d", draft: true },
];

Deno.test("filterByDraft: all keeps everything in order", () => {
  assertEquals(filterByDraft(defs, "all").map((d) => d.id), ["a", "b", "c", "d"]);
});

Deno.test("filterByDraft: drafts / published split on the flag; absent = published", () => {
  assertEquals(filterByDraft(defs, "drafts").map((d) => d.id), ["a", "d"]);
  assertEquals(filterByDraft(defs, "published").map((d) => d.id), ["b", "c"]);
});

Deno.test("countDrafts counts only flagged drafts", () => {
  assertEquals(countDrafts(defs), 2);
  assertEquals(countDrafts([]), 0);
});
