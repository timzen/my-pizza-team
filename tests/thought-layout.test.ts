/**
 * tests/thought-layout.test.ts — The Thoughts canvas's layout math
 * (ui/src/lib/thoughtLayout.ts): Tidy's per-group and ungrouped grids and the
 * snug plate it leaves, the rect a new group wraps its selection in, marquee
 * hit-testing, zoom around a fixed point (clamped), the plate-opacity cycle,
 * and the minimap's frame.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { NOTE_H, NOTE_W } from "../ui/src/lib/thoughtGeometry.ts";
import {
  minimapFrame, nextPlateOpacity, notesInMarquee, tidyLayout, wrapNotes, zoomAround,
} from "../ui/src/lib/thoughtLayout.ts";

const note = (id: string, x: number, y: number, groupId: string | null = null) => ({ id, x, y, groupId });

test("tidyLayout: a group's members grid from its top-left and the plate shrinks to fit", () => {
  const g = { id: "g", x: 100, y: 100, w: 2000, h: 2000 };
  const notes = [note("a", 900, 900, "g"), note("b", 50, 1500, "g"), note("c", 300, 300, "g")];
  const { moves, groupUpdates } = tidyLayout(notes, [g]);
  // 3 members → 2 columns, PAD 16, GAP 20.
  assertEquals(moves, [
    { id: "a", x: 116, y: 116 },
    { id: "b", x: 116 + NOTE_W + 20, y: 116 },
    { id: "c", x: 116, y: 116 + NOTE_H + 20 },
  ]);
  assertEquals(groupUpdates, [{ id: "g", x: 100, y: 100, w: 2 * NOTE_W + 20 + 32, h: 2 * NOTE_H + 20 + 32 }]);
});

test("tidyLayout: ungrouped notes grid from their own top-left; empty groups untouched", () => {
  const notes = [note("a", 500, 40), note("b", 10, 300)];
  const { moves, groupUpdates } = tidyLayout(notes, [{ id: "empty", x: 0, y: 0, w: 200, h: 200 }]);
  assertEquals(groupUpdates, []);
  assertEquals(moves, [{ id: "a", x: 10, y: 40 }, { id: "b", x: 10 + NOTE_W + 20, y: 40 }]);
  assertEquals(tidyLayout([], []), { moves: [], groupUpdates: [] });
});

test("wrapNotes: the selection's bounding box plus padding", () => {
  assertEquals(wrapNotes([{ x: 0, y: 0 }, { x: 300, y: 100 }]), { x: -28, y: -28, w: 300 + NOTE_W + 56, h: 100 + NOTE_H + 56 });
  assertEquals(wrapNotes([{ x: 10.4, y: 0 }], 0), { x: 10, y: 0, w: NOTE_W, h: NOTE_H });
});

test("notesInMarquee: card/rect intersection, corners in any order, edges don't count", () => {
  const notes = [note("a", 0, 0), note("b", 500, 500), note("c", NOTE_W, 0)];
  assertEquals(notesInMarquee(notes, { x: 10, y: 10 }, { x: -5, y: -5 }), ["a"]);
  assertEquals(notesInMarquee(notes, { x: 0, y: 0 }, { x: 1000, y: 1000 }), ["a", "b", "c"]);
  // A marquee ending exactly on c's left edge misses it.
  assertEquals(notesInMarquee([note("c", 100, 0)], { x: 0, y: 0 }, { x: 100, y: 50 }), []);
});

test("zoomAround: keeps the anchor point fixed and clamps the scale", () => {
  const bounds = { min: 0.3, max: 2.5 };
  assertEquals(zoomAround({ tx: 0, ty: 0, scale: 1 }, 2, 100, 50, bounds), { scale: 2, tx: -100, ty: -50 });
  assertEquals(zoomAround({ tx: 40, ty: 40, scale: 2 }, 10, 0, 0, bounds).scale, 2.5);
  assertEquals(zoomAround({ tx: 40, ty: 40, scale: 0.5 }, 0.1, 0, 0, bounds).scale, 0.3);
});

test("nextPlateOpacity: subtle → medium → solid → subtle", () => {
  assertEquals(nextPlateOpacity("subtle"), "medium");
  assertEquals(nextPlateOpacity("medium"), "solid");
  assertEquals(nextPlateOpacity("solid"), "subtle");
});

test("minimapFrame: extent covers notes and the viewport, padded, fit to the box", () => {
  const f = minimapFrame([{ x: 1000, y: 0 }], { tx: 0, ty: 0, scale: 1 }, 800, 600, { w: 192, h: 128, pad: 40 });
  assertEquals(f.viewport, { x0: 0, y0: 0, x1: 800, y1: 600 });
  assertEquals([f.minX, f.minY], [-40, -40]);
  // Extent: x −40..1260 (1300), y −40..640 (680) → min(192/1300, 128/680).
  assertEquals(f.s, Math.min(192 / 1300, 128 / 680));
  // At scale 2 the viewport covers half as much world.
  assertEquals(minimapFrame([], { tx: 0, ty: 0, scale: 2 }, 800, 600, { w: 192, h: 128, pad: 0 }).viewport, { x0: 0, y0: 0, x1: 400, y1: 300 });
});
