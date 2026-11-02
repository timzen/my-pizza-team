/**
 * tests/page-structure-ui.test.ts — The pure rules behind the web UI's page
 * structure (docs/ACCESSIBILITY.md "Structure", "Focus", "Motion"): each
 * route's document title (ui/src/lib/page-title.ts), when a route change moves
 * focus to the new page's heading (ui/src/lib/route-focus.ts), the
 * reduced-motion preference (ui/src/lib/motion.ts), and the Usage grid's
 * keyboard cursor (ui/src/lib/usage.ts moveGridCursor).
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { APP_TITLE, formatPageTitle, pageTitleForPath } from "../ui/src/lib/page-title.ts";
import { keepFocusState, shouldMoveRouteFocus, wantsKeepFocus } from "../ui/src/lib/route-focus.ts";
import { prefersReducedMotion, scrollBehavior } from "../ui/src/lib/motion.ts";
import { buildGrid, lastGridPos, moveGridCursor } from "../ui/src/lib/usage.ts";

test("formatPageTitle: page parts, then the team, then Pizza Team — empty parts dropped", () => {
  assertEquals(formatPageTitle("Help", "acme"), "Help · acme · Pizza Team");
  assertEquals(formatPageTitle(["Board", "Work"], "acme"), "Board · Work · acme · Pizza Team");
  assertEquals(formatPageTitle(["Board", "Work"], null), "Board · Work · Pizza Team");
  assertEquals(formatPageTitle(["", " Fix login "], ""), "Fix login · Pizza Team");
  assertEquals(formatPageTitle(null), APP_TITLE);
});

test("pageTitleForPath: top-level pages, Work and Config tabs, the phone's tabs", () => {
  assertEquals(pageTitleForPath("/"), ["Inbox"]);
  assertEquals(pageTitleForPath("/queue"), ["Queue"]);
  assertEquals(pageTitleForPath("/thoughts"), ["Thoughts"]);
  assertEquals(pageTitleForPath("/help/"), ["Help"]);
  assertEquals(pageTitleForPath("/usage"), ["Usage"]);
  assertEquals(pageTitleForPath("/work/board"), ["Board", "Work"]);
  assertEquals(pageTitleForPath("/work/archived"), ["Archived", "Work"]);
  assertEquals(pageTitleForPath("/config"), ["General", "Configuration"]);
  assertEquals(pageTitleForPath("/config/theme"), ["Theme", "Configuration"]);
  assertEquals(pageTitleForPath("/config/workflows/default"), ["default", "Workflows", "Configuration"]);
  assertEquals(pageTitleForPath("/config/personas/acme%2Freviewer"), ["acme/reviewer", "Personas", "Configuration"]);
  assertEquals(pageTitleForPath("/config/personas/pkg/reviewer"), ["pkg/reviewer", "Personas", "Configuration"]);
  assertEquals(pageTitleForPath("/stories/new"), ["New story", "Work"]);
  assertEquals(pageTitleForPath("/story/s1/tasks/new"), ["New task", "Work"]);
  assertEquals(pageTitleForPath("/thoughts/n1/triage"), ["Triage", "Thoughts"]);
  assertEquals(pageTitleForPath("/m"), ["Team"]);
  assertEquals(pageTitleForPath("/m/chat"), ["Chat"]);
  assertEquals(pageTitleForPath("/m/inbox"), ["Inbox"]);
});

test("pageTitleForPath: a detail page names itself (null)", () => {
  for (const p of ["/task/s1/t1", "/story/s1", "/work-defs/d1", "/work-defs/new", "/teammates/m1", "/work/source/jira", "/nope"]) {
    assertEquals(pageTitleForPath(p), null, p);
  }
});

test("shouldMoveRouteFocus: only a real page change, never the first render, in-page state, a route tab or the dock", () => {
  const change = { prevPath: "/work/board", nextPath: "/help", state: null, focusInKeepRegion: false };
  assertEquals(shouldMoveRouteFocus(change), true);
  assertEquals(shouldMoveRouteFocus({ ...change, prevPath: null }), false);
  assertEquals(shouldMoveRouteFocus({ ...change, nextPath: "/work/board" }), false); // ?tab= / hash only
  assertEquals(shouldMoveRouteFocus({ ...change, state: keepFocusState() }), false);
  assertEquals(shouldMoveRouteFocus({ ...change, state: { other: 1 } }), true);
  assertEquals(shouldMoveRouteFocus({ ...change, focusInKeepRegion: true }), false);
});

test("wantsKeepFocus: only the mark itself", () => {
  assertEquals(wantsKeepFocus(keepFocusState()), true);
  assertEquals(wantsKeepFocus({ ...keepFocusState(), warnings: [] }), true);
  for (const s of [null, undefined, "x", {}, { mptKeepFocus: "yes" }]) assertEquals(wantsKeepFocus(s), false);
});

test("prefersReducedMotion / scrollBehavior follow the media query", () => {
  const g = globalThis as { matchMedia?: (q: string) => { matches: boolean } };
  const saved = g.matchMedia;
  try {
    delete g.matchMedia;
    assertEquals(prefersReducedMotion(), false);
    assertEquals(scrollBehavior(), "smooth");
    g.matchMedia = (q) => ({ matches: q === "(prefers-reduced-motion: reduce)" });
    assertEquals(prefersReducedMotion(), true);
    assertEquals(scrollBehavior(), "auto");
  } finally {
    if (saved) g.matchMedia = saved; else delete g.matchMedia;
  }
});

test("moveGridCursor: arrows by day and week, Home/End along the row, never past today", () => {
  // 2025-06-11 is a Wednesday: the last column has Sun–Wed in range.
  const cols = buildGrid([], "2025-06-11", 3);
  const today = lastGridPos(cols);
  assertEquals(today, { col: 2, row: 3 });
  assertEquals(moveGridCursor(cols, today, "ArrowDown"), today); // Thursday is in the future
  assertEquals(moveGridCursor(cols, today, "ArrowRight"), today); // no next week
  assertEquals(moveGridCursor(cols, today, "ArrowUp"), { col: 2, row: 2 });
  assertEquals(moveGridCursor(cols, today, "ArrowLeft"), { col: 1, row: 3 });
  assertEquals(moveGridCursor(cols, { col: 0, row: 0 }, "ArrowLeft"), { col: 0, row: 0 });
  assertEquals(moveGridCursor(cols, { col: 0, row: 0 }, "ArrowUp"), { col: 0, row: 0 });
  assertEquals(moveGridCursor(cols, today, "Home"), { col: 0, row: 3 });
  assertEquals(moveGridCursor(cols, { col: 0, row: 5 }, "End"), { col: 1, row: 5 }); // this week's Friday hasn't come
  assertEquals(moveGridCursor(cols, today, "Enter"), null);
  assertEquals(moveGridCursor(cols, today, "Tab"), null);
});
