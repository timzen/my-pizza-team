/**
 * tests/pending-ui.test.ts — The Tasks page's pending filter (ui/src/lib/pending.ts).
 *
 * A WorkDef with no `pending` flag is active, so old WorkDefs never show up
 * under "Pending".
 */

import { assertEquals } from "@std/assert";
import { countPending, filterByPending } from "../ui/src/lib/pending.ts";

const defs = [
  { id: "a", pending: true },
  { id: "b", pending: false },
  { id: "c" },
  { id: "d", pending: true },
];

Deno.test("filterByPending: all keeps everything in order", () => {
  assertEquals(filterByPending(defs, "all").map((d) => d.id), ["a", "b", "c", "d"]);
});

Deno.test("filterByPending: pending / active split on the flag; absent = active", () => {
  assertEquals(filterByPending(defs, "pending").map((d) => d.id), ["a", "d"]);
  assertEquals(filterByPending(defs, "active").map((d) => d.id), ["b", "c"]);
});

Deno.test("countPending counts only flagged pending defs", () => {
  assertEquals(countPending(defs), 2);
  assertEquals(countPending([]), 0);
});
