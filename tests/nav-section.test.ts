/**
 * tests/nav-section.test.ts — Route → top-nav section rules and the WorkDef Back
 * fallback (ui/src/lib/nav-section.ts).
 *
 * Guards the two regressions behind "navigation highlights and goes back
 * strangely": prefix matching that let Board's `/task` claim `/tasks`, and
 * `/work-defs/*` highlighting nothing (its section depends on the WorkDef's
 * type, not the URL). Also pins the "can go back in-app" check the BackButton
 * uses instead of `location.key`. Board/Tasks/Schedule are now sub-tabs of one
 * Work Items section, so the lists, story/task pages, and standalone WorkDefs
 * all light "work-items".
 */

import { assertEquals } from "@std/assert";
import {
  canGoBackInApp,
  navSectionForPath,
  sectionForWorkDefType,
  workDefHomePath,
} from "../ui/src/lib/nav-section.ts";

Deno.test("navSectionForPath: list pages map to their own section only", () => {
  for (const p of ["/work-items", "/work-items/board", "/work-items/tasks", "/work-items/schedule", "/work-items/pending", "/work-items/archived"]) {
    assertEquals(navSectionForPath(p), "work-items", p);
  }
  assertEquals(navSectionForPath("/thoughts"), "thoughts");
  assertEquals(navSectionForPath("/thoughts/t1/triage"), "thoughts");
});

Deno.test("navSectionForPath: story/task detail pages and legacy list routes light Work Items", () => {
  for (const p of ["/story/s1", "/stories/new", "/story/s1/tasks/new", "/task/s1/t1", "/board", "/tasks", "/schedule", "/pending", "/backlog", "/archived", "/templates", "/templates/atlas"]) {
    assertEquals(navSectionForPath(p), "work-items", p);
  }
});

Deno.test("navSectionForPath: /work-defs/:id follows the WorkDef type", () => {
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: "Solitary" }), "work-items");
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: "Scheduled" }), "work-items");
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: "Board" }), "work-items");
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: "Triage" }), "thoughts");
  // Not loaded yet: highlight nothing rather than guess.
  assertEquals(navSectionForPath("/work-defs/w1"), null);
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: null }), null);
});

Deno.test("navSectionForPath: /work-defs/new follows ?type (default Solitary)", () => {
  assertEquals(navSectionForPath("/work-defs/new", { search: "?type=Scheduled" }), "work-items");
  assertEquals(navSectionForPath("/work-defs/new", { search: "?type=Solitary" }), "work-items");
  assertEquals(navSectionForPath("/work-defs/new"), "work-items");
});

Deno.test("navSectionForPath: non-section routes light nothing", () => {
  for (const p of ["/", "/queue", "/help", "/config", "/config/theme", "/config/workflows", "/config/workflows/coding", "/config/context", "/usage", "/teammates/a1"]) {
    assertEquals(navSectionForPath(p), null, p);
  }
});

Deno.test("sectionForWorkDefType: unknown types have no section", () => {
  assertEquals(sectionForWorkDefType("Template"), "work-items");
  assertEquals(sectionForWorkDefType("Nope"), null);
  assertEquals(sectionForWorkDefType(undefined), null);
});

Deno.test("workDefHomePath: Back fallback is the WorkDef's Work Items sub-tab", () => {
  assertEquals(workDefHomePath("Solitary"), "/work-items/tasks");
  assertEquals(workDefHomePath("Scheduled"), "/work-items/schedule");
  // Templates are hidden from the UI; their Back lands on Tasks.
  assertEquals(workDefHomePath("Template"), "/work-items/tasks");
  assertEquals(workDefHomePath("Board"), "/work-items/board");
  assertEquals(workDefHomePath("Triage"), "/thoughts");
  assertEquals(workDefHomePath(undefined), "/work-items/tasks");
  // The fallback's section is the same one the NavBar highlights for that type.
  for (const t of ["Solitary", "Scheduled", "Template", "Board", "Triage"]) {
    assertEquals(navSectionForPath(workDefHomePath(t)), sectionForWorkDefType(t), t);
  }
});

Deno.test("canGoBackInApp: only when the router has an earlier in-app entry", () => {
  assertEquals(canGoBackInApp({ idx: 0 }), false);
  assertEquals(canGoBackInApp({ idx: 3, key: "abc" }), true);
  assertEquals(canGoBackInApp(null), false);
  assertEquals(canGoBackInApp(undefined), false);
  assertEquals(canGoBackInApp({}), false);
  assertEquals(canGoBackInApp({ idx: "1" }), false);
});
