/**
 * tests/thought-list.test.ts — The Thoughts list view's rules
 * (ui/src/lib/thoughtList.ts): titles and snippets from markdown, folder
 * arrangement and ordering, search, keyboard order, the selection after a
 * removal, and where a note lands on the canvas when the list moves it into or
 * out of a group.
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildThoughtTree,
  neighbourAfterRemoval,
  noteSnippet,
  noteTitle,
  placeForGroupChange,
  slotBelowAll,
  slotInPlate,
  visibleOrder,
  type ListGroup,
  type ListNote,
} from "../ui/src/lib/thoughtList.ts";
import { NOTE_H, NOTE_W, PLATE_PAD, plateRect } from "../ui/src/lib/thoughtGeometry.ts";

function note(id: string, over: Partial<ListNote> = {}): ListNote {
  return { id, x: 0, y: 0, groupId: null, content: id, pinned: false, updatedAt: "2026-09-01T00:00:00.000Z", ...over };
}
function group(id: string, title: string, over: Partial<ListGroup> = {}): ListGroup {
  return { id, title, x: 0, y: 0, w: 360, h: 260, ...over };
}

Deno.test("title and snippet are the first two lines of text, without markdown syntax", () => {
  const md = "# Q3 **planning**\n\n- [ ] ship the `list` view\n- more";
  assertEquals(noteTitle(md), "Q3 planning");
  assertEquals(noteSnippet(md), "ship the list view");
  assertEquals(noteTitle("> a [link](http://x) here"), "a link here");
  assertEquals(noteTitle("```\ncode\n```"), "code");
  assertEquals(noteTitle("   \n\n"), "");
  assertEquals(noteSnippet("only one line"), "");
});

Deno.test("folders are alphabetical, loose notes come after, each pinned-first then newest", () => {
  const groups = [group("g-b", "beta"), group("g-a", "Alpha")];
  const notes = [
    note("old", { groupId: "g-a", updatedAt: "2026-01-01T00:00:00.000Z" }),
    note("new", { groupId: "g-a", updatedAt: "2026-09-01T00:00:00.000Z" }),
    note("pinned-old", { groupId: "g-a", pinned: true, updatedAt: "2025-01-01T00:00:00.000Z" }),
    note("b1", { groupId: "g-b" }),
    note("loose1", { updatedAt: "2026-02-01T00:00:00.000Z" }),
    note("loose2", { updatedAt: "2026-03-01T00:00:00.000Z" }),
  ];
  const tree = buildThoughtTree(notes, groups);
  assertEquals(tree.folders.map((f) => f.group.title), ["Alpha", "beta"]);
  assertEquals(tree.folders[0]!.notes.map((n) => n.id), ["pinned-old", "new", "old"]);
  assertEquals(tree.loose.map((n) => n.id), ["loose2", "loose1"]);
});

Deno.test("an empty folder shows until you search; a search keeps only matches", () => {
  const groups = [group("g-empty", "Empty"), group("g-x", "X")];
  const notes = [note("a", { groupId: "g-x", content: "Buy milk" }), note("b", { groupId: "g-x", content: "call bob" }), note("c", { content: "MILK again" })];
  assertEquals(buildThoughtTree(notes, groups).folders.map((f) => f.group.id), ["g-empty", "g-x"]);
  const found = buildThoughtTree(notes, groups, "milk");
  assertEquals(found.folders.map((f) => f.group.id), ["g-x"]);
  assertEquals(found.folders[0]!.notes.map((n) => n.id), ["a"]);
  assertEquals(found.loose.map((n) => n.id), ["c"]);
});

Deno.test("a note whose group no longer exists is listed as loose, never hidden", () => {
  const tree = buildThoughtTree([note("orphan", { groupId: "gone" })], []);
  assertEquals(tree.loose.map((n) => n.id), ["orphan"]);
});

Deno.test("keyboard order skips collapsed folders, except while searching", () => {
  const groups = [group("g-a", "A"), group("g-b", "B")];
  const notes = [note("a1", { groupId: "g-a" }), note("b1", { groupId: "g-b" }), note("l1")];
  const tree = buildThoughtTree(notes, groups);
  assertEquals(visibleOrder(tree, new Set(["g-a"])).map((n) => n.id), ["b1", "l1"]);
  assertEquals(visibleOrder(tree, new Set(["g-a"]), true).map((n) => n.id), ["a1", "b1", "l1"]);
});

Deno.test("after a removal the selection moves to the next note, else the previous", () => {
  const order = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assertEquals(neighbourAfterRemoval(order, "b"), "c");
  assertEquals(neighbourAfterRemoval(order, "c"), "b");
  assertEquals(neighbourAfterRemoval([{ id: "a" }], "a"), null);
  assertEquals(neighbourAfterRemoval(order, "missing"), "a");
});

Deno.test("joining a group fills the first free slot inside its plate", () => {
  // A plate two notes wide, with the first slot taken.
  const w = 2 * NOTE_W + 20 + 2 * PLATE_PAD;
  const g = group("g", "G", { x: 100, y: 100, w, h: 260 });
  const first = note("m1", { groupId: "g", x: 100 + PLATE_PAD, y: 100 + PLATE_PAD });
  const slot = slotInPlate(g, [first]);
  assertEquals(slot, { x: 100 + PLATE_PAD + NOTE_W + 20, y: 100 + PLATE_PAD });
  // Inside the plate as drawn, so the plate doesn't have to grow.
  const r = plateRect(g, [first, note("new", { groupId: "g", ...slot })]);
  assertEquals(r, plateRect(g, [first]));
});

Deno.test("a full plate gets a new row, and the note being moved doesn't block its own slot", () => {
  const g = group("g", "G", { x: 0, y: 0, w: NOTE_W + 2 * PLATE_PAD, h: NOTE_H + 2 * PLATE_PAD });
  const m = note("m", { groupId: "g", x: PLATE_PAD, y: PLATE_PAD });
  assertEquals(slotInPlate(g, [m]), { x: PLATE_PAD, y: PLATE_PAD + NOTE_H + 20 });
  assertEquals(slotInPlate(g, [m], "m"), { x: PLATE_PAD, y: PLATE_PAD });
});

Deno.test("leaving every group places the note below all notes and plates", () => {
  const g = group("g", "G", { x: 500, y: 0, w: 360, h: 900 });
  const notes = [note("loose", { x: 40, y: 0 }), note("mover", { groupId: "g", x: 520, y: 20 })];
  const slot = slotBelowAll(notes, [g], "mover");
  assertEquals(slot.x, 40);
  assert(slot.y > 900, "clears the plate's bottom edge");
  assertEquals(slotBelowAll([], []), { x: 0, y: 0 });
});

Deno.test("a group change moves the note only when its position would disagree", () => {
  const g = group("g", "G", { x: 1000, y: 0, w: 360, h: 260 });
  const far = note("far", { x: 0, y: 0 });
  // Joining from far away: into the plate.
  assertEquals(placeForGroupChange(far, "g", [far], [g]), { x: 1000 + PLATE_PAD, y: PLATE_PAD });
  // Joining a plate it already sits on: stays put.
  const on = note("on", { x: 1040, y: 40 });
  assertEquals(placeForGroupChange(on, "g", [on], [g]), null);
  // Leaving while under the plate: moved clear of it.
  const member = note("member", { groupId: "g", x: 1040, y: 40 });
  const moved = placeForGroupChange(member, null, [member], [g]);
  assert(moved !== null && moved.y > 260, "moved below the plate");
  // Leaving from a spot no plate covers: stays put.
  assertEquals(placeForGroupChange(far, null, [far], [g]), null);
  // Unknown group: nothing to do.
  assertEquals(placeForGroupChange(far, "nope", [far], [g]), null);
});
