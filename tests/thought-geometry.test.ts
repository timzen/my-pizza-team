/**
 * tests/thought-geometry.test.ts — The Thoughts canvas's drag-and-drop group
 * membership rules (ui/src/lib/thoughtGeometry.ts): plates wrap their members,
 * a dragged member doesn't stretch its own plate, drops target the plate under
 * the pointer (topmost wins), and only real membership changes are emitted.
 * Also the minimap's group chips: their ordering and the jump-to-center math.
 */

import { assertEquals } from "@std/assert";
import {
  centerViewOn,
  dropTarget,
  groupsByNoteCount,
  membershipChanges,
  NOTE_H,
  NOTE_W,
  noteCenter,
  PLATE_PAD,
  plateRect,
  previewRect,
} from "../ui/src/lib/thoughtGeometry.ts";

const plate = { id: "g1", x: 0, y: 0, w: 300, h: 200 };

Deno.test("plateRect: an empty plate is its stored rect", () => {
  assertEquals(plateRect(plate, []), { left: 0, top: 0, right: 300, bottom: 200 });
});

Deno.test("plateRect: grows to wrap a member (with padding)", () => {
  const notes = [{ id: "n1", x: 400, y: 300, groupId: "g1" }];
  assertEquals(plateRect(plate, notes), {
    left: 0, top: 0, right: 400 + NOTE_W + PLATE_PAD, bottom: 300 + NOTE_H + PLATE_PAD,
  });
});

Deno.test("plateRect: ignores non-members and excluded (dragged) notes", () => {
  const notes = [
    { id: "n1", x: 900, y: 900, groupId: "g2" },
    { id: "n2", x: 900, y: 900, groupId: "g1" },
  ];
  assertEquals(plateRect(plate, notes, new Set(["n2"])), { left: 0, top: 0, right: 300, bottom: 200 });
});

Deno.test("dropTarget: the plate under the pointer, or null on open canvas", () => {
  assertEquals(dropTarget({ x: 150, y: 100 }, [plate], [], new Set()), "g1");
  assertEquals(dropTarget({ x: 600, y: 100 }, [plate], [], new Set()), null);
});

Deno.test("dropTarget: a member dragged out of its plate lands outside (it no longer stretches it)", () => {
  // n1 is being dragged far right; without the exclusion the plate would wrap it.
  const notes = [{ id: "n1", x: 800, y: 50, groupId: "g1" }];
  assertEquals(dropTarget({ x: 850, y: 100 }, [plate], notes, new Set(["n1"])), null);
});

Deno.test("dropTarget: overlapping plates — the later (topmost) one wins", () => {
  const top = { id: "g2", x: 100, y: 50, w: 300, h: 200 };
  assertEquals(dropTarget({ x: 150, y: 100 }, [plate, top], [], new Set()), "g2");
});

Deno.test("membershipChanges: join, leave, and no-op", () => {
  const dragged = [
    { id: "a", x: 0, y: 0, groupId: null },
    { id: "b", x: 0, y: 0, groupId: "g1" },
    { id: "c", x: 0, y: 0, groupId: "g2" },
  ];
  assertEquals(membershipChanges("g1", dragged), [
    { id: "a", groupId: "g1" },
    { id: "c", groupId: "g1" },
  ]);
  assertEquals(membershipChanges(null, dragged), [
    { id: "b", groupId: null },
    { id: "c", groupId: null },
  ]);
});

Deno.test("dropTarget: a note half over a plate counts, wherever it was grabbed", () => {
  // Grabbed by its far-left edge: the pointer is outside, but the center is inside.
  const note = { id: "n1", x: 250, y: 50, groupId: null };
  const pointer = { x: 255, y: 60 };
  const center = noteCenter(note);
  assertEquals(center.x > 300, true); // the center is past the plate's left edge (x: 300)
  assertEquals(dropTarget(pointer, [{ ...plate, x: 300 }], [note], new Set(["n1"])), null);
  assertEquals(dropTarget([pointer, center], [{ ...plate, x: 300 }], [note], new Set(["n1"])), "g1");
});

Deno.test("previewRect: the plate grows to wrap notes hovering over it", () => {
  const note = { id: "n1", x: 250, y: 150, groupId: null };
  assertEquals(previewRect(plate, [note], new Set(["n1"])), {
    left: 0, top: 0, right: 250 + NOTE_W + PLATE_PAD, bottom: 150 + NOTE_H + PLATE_PAD,
  });
  // ...but not for notes that aren't being dragged.
  assertEquals(previewRect(plate, [note], new Set()), { left: 0, top: 0, right: 300, bottom: 200 });
});

Deno.test("groupsByNoteCount: most notes first; ties by title; empty groups last", () => {
  const plates = [
    { id: "a", title: "Zed", x: 0, y: 0, w: 1, h: 1 },
    { id: "b", title: "Beta", x: 0, y: 0, w: 1, h: 1 },
    { id: "c", title: "Alpha", x: 0, y: 0, w: 1, h: 1 },
    { id: "d", title: "Empty", x: 0, y: 0, w: 1, h: 1 },
  ];
  const notes = [
    { id: "n1", x: 0, y: 0, groupId: "a" },
    { id: "n2", x: 0, y: 0, groupId: "a" },
    { id: "n3", x: 0, y: 0, groupId: "a" },
    { id: "n4", x: 0, y: 0, groupId: "b" },
    { id: "n5", x: 0, y: 0, groupId: "c" },
    { id: "n6", x: 0, y: 0, groupId: null },
  ];
  assertEquals(
    groupsByNoteCount(plates, notes).map(({ plate, count }) => [plate.title, count]),
    [["Zed", 3], ["Alpha", 1], ["Beta", 1], ["Empty", 0]],
  );
});

Deno.test("centerViewOn: the rect's center lands in the viewport's center", () => {
  const r = { left: 100, top: 200, right: 300, bottom: 400 }; // center (200, 300)
  const { tx, ty } = centerViewOn(r, 800, 600, 2);
  // screen = world * scale + t
  assertEquals(200 * 2 + tx, 400);
  assertEquals(300 * 2 + ty, 300);
});
