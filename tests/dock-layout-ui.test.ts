/**
 * tests/dock-layout-ui.test.ts — The desktop dock's layout rules
 * (ui/src/lib/dock-layout.ts, docs/DESIGN.md "The Shell: a Dock and a Center"):
 * reading stored position/mode (and migrating the old open flag), width
 * limits, the resize drag on either side, and which way the inner edge and
 * tooltips face, and Full page's transitions (the toggle, Esc, navigation).
 * Plus structural checks that a Right dock and a Full page one are laid out
 * with CSS, not moved in the DOM.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import {
  DEFAULT_DOCK_WIDTH, DOCK_MODE_KEY, DOCK_POSITION_KEY, DOCK_POSITIONS, LEGACY_DOCK_OPEN_KEY, MAX_DOCK_WIDTH, MIN_DOCK_WIDTH,
  clampDockWidth, dockFillsCenter, dockInnerEdge, dockModeAfterEscape, dockModeAfterNavigate, dockTooltipSide,
  dockWidthFromPointer, isDockOpen, modeForOpen, parseDockMode, parseDockPosition, parseDockWidth, toggleFullPage,
} from "../ui/src/lib/dock-layout.ts";

const read = (p: string) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf-8");

test("the keys: new ones for position and mode, the old open flag kept for migration", () => {
  assertEquals(DOCK_POSITION_KEY, "mpt.sideDock.position");
  assertEquals(DOCK_MODE_KEY, "mpt.sideDock.mode");
  assertEquals(LEGACY_DOCK_OPEN_KEY, "mpt.assistantDock.open");
});

test("parseDockPosition: Left and Right; anything else (incl. Bottom, not offered yet) is Left", () => {
  assertEquals(parseDockPosition("left"), "left");
  assertEquals(parseDockPosition("right"), "right");
  for (const raw of [null, "", "bottom", "Right", "top"]) assertEquals(parseDockPosition(raw), "left", String(raw));
  assertEquals(DOCK_POSITIONS.map((p) => p.position), ["left", "right"]);
});

test("parseDockMode: a stored mode wins; else the old open flag decides; default expanded", () => {
  assertEquals(parseDockMode("collapsed", null), "collapsed");
  assertEquals(parseDockMode("expanded", "0"), "expanded");
  // Migration from mpt.assistantDock.open: only an explicit "0" was collapsed.
  assertEquals(parseDockMode(null, "0"), "collapsed");
  assertEquals(parseDockMode(null, "1"), "expanded");
  assertEquals(parseDockMode(null, null), "expanded");
  assertEquals(parseDockMode("full", "0"), "full");
  assertEquals(parseDockMode("bogus", "0"), "collapsed");
});

test("open is any mode but collapsed; opening keeps an open mode", () => {
  assertEquals(isDockOpen("collapsed"), false);
  assertEquals(isDockOpen("expanded"), true);
  assertEquals(isDockOpen("full"), true);
  assertEquals(modeForOpen("collapsed", true), "expanded");
  assertEquals(modeForOpen("full", true), "full");
  assertEquals(modeForOpen("expanded", true), "expanded");
  assertEquals(modeForOpen("full", false), "collapsed");
});

test("widths: clamped while dragging, out-of-range stored values fall back to the default", () => {
  assertEquals(clampDockWidth(100), MIN_DOCK_WIDTH);
  assertEquals(clampDockWidth(9999), MAX_DOCK_WIDTH);
  assertEquals(clampDockWidth(420), 420);
  assertEquals(parseDockWidth("420"), 420);
  for (const raw of [null, "", "abc", "100", "9999"]) assertEquals(parseDockWidth(raw), DEFAULT_DOCK_WIDTH, String(raw));
});

test("the drag: x on the Left, distance from the right edge on the Right", () => {
  assertEquals(dockWidthFromPointer("left", 400, 1600), 400);
  assertEquals(dockWidthFromPointer("right", 1200, 1600), 400);
  assertEquals(dockWidthFromPointer("right", 1500, 1600), MIN_DOCK_WIDTH);
  assertEquals(dockWidthFromPointer("right", 100, 1600), MAX_DOCK_WIDTH);
});

test("the inner edge and tooltips face the center", () => {
  assertEquals(dockInnerEdge("left"), "right");
  assertEquals(dockInnerEdge("right"), "left");
  assertEquals(dockInnerEdge("bottom"), "top");
  assertEquals(dockTooltipSide("left"), "right");
  assertEquals(dockTooltipSide("right"), "left");
});

test("a Right dock is reordered with CSS and keeps the landmark and tour mark", () => {
  const dock = read("components/dock/SideDock.tsx");
  // Visual order only: the dock stays first in the DOM (App.tsx DesktopShell).
  assert(dock.includes('"order-last border-l"'), "Right dock uses order-last + border-l");
  // The rail's and column's hints follow the position; only the below-lg floating button (always bottom-left) says "right".
  assertEquals(dock.match(/side="right"/g)?.length, 1);
  assert(dock.includes('aria-label="Dock position"'), "the Dock position menu");
  const shell = read("App.tsx");
  assert(shell.indexOf("<SideDock />") < shell.indexOf("<NavBar />"), "dock before the center in the DOM");
});

test("the Full page button: full goes back to the column, the column goes full", () => {
  assertEquals(toggleFullPage("expanded"), "full");
  assertEquals(toggleFullPage("full"), "expanded");
  assertEquals(toggleFullPage("collapsed"), "full");
});

test("Full page fills the center only on a desktop", () => {
  assertEquals(dockFillsCenter("full", true), true);
  assertEquals(dockFillsCenter("full", false), false);
  assertEquals(dockFillsCenter("expanded", true), false);
  assertEquals(dockFillsCenter("collapsed", true), false);
});

test("a new page leaves Full page; the first render, a query change, and other modes don't", () => {
  assertEquals(dockModeAfterNavigate("full", "/work/board", "/teammates/t1"), "expanded");
  assertEquals(dockModeAfterNavigate("full", null, "/"), "full");
  assertEquals(dockModeAfterNavigate("full", "/story/s1", "/story/s1"), "full");
  assertEquals(dockModeAfterNavigate("expanded", "/", "/config"), "expanded");
  assertEquals(dockModeAfterNavigate("collapsed", "/", "/config"), "collapsed");
});

test("Esc leaves Full page only from inside the dock, and only when nothing else took it", () => {
  assertEquals(dockModeAfterEscape({ mode: "full", handled: false, focusInDock: true }), "expanded");
  // A dialog, menu, popover or the composer closed something first.
  assertEquals(dockModeAfterEscape({ mode: "full", handled: true, focusInDock: true }), null);
  assertEquals(dockModeAfterEscape({ mode: "full", handled: false, focusInDock: false }), null);
  assertEquals(dockModeAfterEscape({ mode: "expanded", handled: false, focusInDock: true }), null);
  assertEquals(dockModeAfterEscape({ mode: "collapsed", handled: false, focusInDock: true }), null);
});

test("Full page is laid out with CSS: the page stays mounted but hidden, no resize handle", () => {
  const shell = read("App.tsx");
  // One element tree in every mode: <main> is hidden, not unmounted, and the nav is drawn first.
  assert(shell.includes("hidden={full}"), "<main> hidden in Full page");
  assert(shell.includes('"order-first shrink-0"'), "the center (the nav) drawn on top in Full page");
  assertEquals(shell.match(/<SideDock \/>/g)?.length, 1);
  const dock = read("components/dock/SideDock.tsx");
  assert(dock.includes('label={full ? "Restore the dock" : "Full page"}'), "the toggle names its action");
  assert(dock.includes("{!full && ("), "the resize handle is hidden in Full page");
});
