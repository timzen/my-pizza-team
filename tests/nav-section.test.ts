/**
 * tests/nav-section.test.ts — Route → top-nav section rules and the WorkDef Back
 * fallback (ui/src/lib/nav-section.ts).
 *
 * Guards the two regressions behind "navigation highlights and goes back
 * strangely": prefix matching that let Board's `/task` claim `/tasks`, and
 * `/work-defs/*` highlighting nothing (its section depends on the WorkDef's
 * type, not the URL). Also pins the "can go back in-app" check the BackButton
 * uses instead of `location.key`.
 */

import { assertEquals } from "@std/assert";
import {
  canGoBackInApp,
  navSectionForPath,
  sectionForWorkDefType,
  workDefHomePath,
} from "../ui/src/lib/nav-section.ts";

Deno.test("navSectionForPath: list pages map to their own section only", () => {
  assertEquals(navSectionForPath("/tasks"), "tasks");
  assertEquals(navSectionForPath("/templates"), "tasks");
  assertEquals(navSectionForPath("/templates/atlas"), "tasks");
  assertEquals(navSectionForPath("/schedule"), "schedule");
  assertEquals(navSectionForPath("/thoughts"), "thoughts");
  assertEquals(navSectionForPath("/thoughts/t1/triage"), "thoughts");
});

Deno.test("navSectionForPath: board surface and its detail pages", () => {
  for (const p of ["/board", "/backlog", "/archived", "/story/s1", "/stories/new", "/task/s1/t1"]) {
    assertEquals(navSectionForPath(p), "board", p);
  }
});

Deno.test("navSectionForPath: /tasks is not claimed by Board's /task (segment match, not prefix)", () => {
  assertEquals(navSectionForPath("/tasks"), "tasks");
  assertEquals(navSectionForPath("/task/s1/t1"), "board");
});

Deno.test("navSectionForPath: /work-defs/:id follows the WorkDef type", () => {
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: "Solitary" }), "tasks");
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: "Scheduled" }), "schedule");
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: "Board" }), "board");
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: "Triage" }), "thoughts");
  // Not loaded yet: highlight nothing rather than guess.
  assertEquals(navSectionForPath("/work-defs/w1"), null);
  assertEquals(navSectionForPath("/work-defs/w1", { workDefType: null }), null);
});

Deno.test("navSectionForPath: /work-defs/new follows ?type (default Solitary)", () => {
  assertEquals(navSectionForPath("/work-defs/new", { search: "?type=Scheduled" }), "schedule");
  assertEquals(navSectionForPath("/work-defs/new", { search: "?type=Template" }), "tasks");
  assertEquals(navSectionForPath("/work-defs/new", { search: "?type=Solitary&template=x" }), "tasks");
  assertEquals(navSectionForPath("/work-defs/new"), "tasks");
});

Deno.test("navSectionForPath: non-section routes light nothing", () => {
  for (const p of ["/", "/queue", "/help", "/config", "/config/theme", "/config/workflows", "/config/workflows/coding", "/config/context", "/usage", "/teammates/a1"]) {
    assertEquals(navSectionForPath(p), null, p);
  }
});

Deno.test("sectionForWorkDefType: unknown types have no section", () => {
  assertEquals(sectionForWorkDefType("Template"), "tasks");
  assertEquals(sectionForWorkDefType("Nope"), null);
  assertEquals(sectionForWorkDefType(undefined), null);
});

Deno.test("workDefHomePath: Back fallback matches the WorkDef's section", () => {
  assertEquals(workDefHomePath("Solitary"), "/tasks");
  assertEquals(workDefHomePath("Scheduled"), "/schedule");
  assertEquals(workDefHomePath("Template"), "/templates");
  assertEquals(workDefHomePath("Board"), "/board");
  assertEquals(workDefHomePath("Triage"), "/thoughts");
  assertEquals(workDefHomePath(undefined), "/tasks");
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
