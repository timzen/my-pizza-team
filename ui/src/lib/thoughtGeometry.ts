/**
 * lib/thoughtGeometry — Pure geometry for the Thoughts canvas: the fixed note
 * size, how a group plate wraps its members, and which plate a dragged note
 * lands in. No DOM, so the drag-and-drop membership rules are unit-tested
 * (tests/thought-geometry.test.ts).
 *
 * **Notes are all one size** on the canvas (NOTE_W × NOTE_H): a board of
 * uniform cards scans like a board, not a collage, and the full note opens in a
 * larger view/edit dialog (double-click). Any stored per-note `w`/`h` is
 * ignored by the canvas.
 *
 * **Membership changes by drag-and-drop**: dropping a note onto a plate adds it
 * to that group; dropping a member outside every plate removes it. Membership
 * is still never *inferred* from position — only a drop (an explicit gesture)
 * changes it, so moving a plate over loose notes doesn't absorb them.
 *
 * Also the minimap's group chips: their order (`groupsByNoteCount`) and the
 * jump that centers a group in the view (`centerViewOn`).
 */

export const NOTE_W = 220;
export const NOTE_H = 160;
/** Space between a plate's edge and the members it wraps. */
export const PLATE_PAD = 16;

export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Point { x: number; y: number }

/** The minimal shapes these helpers need (the page's types are wider). */
export interface NoteLike { id: string; x: number; y: number; groupId: string | null }
export interface PlateLike { id: string; x: number; y: number; w: number; h: number }

/**
 * A plate's rendered rect: the union of its own stored rect (the
 * movable/resizable minimum) and its members' bounding box (+ padding), so
 * adding a note grows the plate to wrap it.
 *
 * `exclude` leaves notes out — the ones being dragged. Otherwise a member
 * dragged toward the edge would stretch its own plate along with it and could
 * never be dragged *out*.
 */
export function plateRect(plate: PlateLike, notes: NoteLike[], exclude?: ReadonlySet<string>): Rect {
  let left = plate.x, top = plate.y, right = plate.x + plate.w, bottom = plate.y + plate.h;
  for (const n of notes) {
    if (n.groupId !== plate.id || exclude?.has(n.id)) continue;
    left = Math.min(left, n.x - PLATE_PAD);
    top = Math.min(top, n.y - PLATE_PAD);
    right = Math.max(right, n.x + NOTE_W + PLATE_PAD);
    bottom = Math.max(bottom, n.y + NOTE_H + PLATE_PAD);
  }
  return { left, top, right, bottom };
}

/**
 * The drop preview: while notes are dragged over a plate, it grows live to wrap
 * them too, so you see the group take the note *before* you let go (the same
 * rect it'll settle at after the drop).
 */
export function previewRect(plate: PlateLike, notes: NoteLike[], dragged: ReadonlySet<string>): Rect {
  const r = plateRect(plate, notes, dragged);
  for (const n of notes) {
    if (!dragged.has(n.id)) continue;
    r.left = Math.min(r.left, n.x - PLATE_PAD);
    r.top = Math.min(r.top, n.y - PLATE_PAD);
    r.right = Math.max(r.right, n.x + NOTE_W + PLATE_PAD);
    r.bottom = Math.max(r.bottom, n.y + NOTE_H + PLATE_PAD);
  }
  return r;
}

/** The center of a note card (the "is it half over?" test point). */
export function noteCenter(n: Pick<NoteLike, "x" | "y">): Point {
  return { x: n.x + NOTE_W / 2, y: n.y + NOTE_H / 2 };
}

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/**
 * The plate a drop lands in, or null for open canvas. Any of `points` inside a
 * plate counts — the page passes the pointer (where you're aiming) *and* the
 * grabbed note's center (so a note half over a plate counts, wherever you
 * grabbed it). Tested against the plate *without* the dragged notes, so the
 * live drop preview (previewRect) growing around the note can't feed back into
 * the target and flicker. Plates later in the list render on top, so they win
 * overlaps.
 */
export function dropTarget(points: Point | Point[], plates: PlateLike[], notes: NoteLike[], dragged: ReadonlySet<string>): string | null {
  const pts = Array.isArray(points) ? points : [points];
  for (let i = plates.length - 1; i >= 0; i--) {
    const r = plateRect(plates[i]!, notes, dragged);
    if (pts.some((p) => contains(r, p))) return plates[i]!.id;
  }
  return null;
}

/**
 * The membership changes a drop implies: every dragged note joins the target
 * plate (or, dropped on open canvas, leaves its group). Only real changes are
 * returned, so a drag that stays inside its own group is just a move.
 */
export function membershipChanges(
  target: string | null,
  draggedNotes: NoteLike[],
): Array<{ id: string; groupId: string | null }> {
  return draggedNotes
    .filter((n) => n.groupId !== target)
    .map((n) => ({ id: n.id, groupId: target }));
}

/**
 * The minimap's group chips, in display order: most notes first (the biggest
 * clusters are the likeliest places to jump to). Ties break by title, then id,
 * so the row doesn't reshuffle between renders. Empty groups are kept (at the
 * end) — they're still places on the board.
 */
export function groupsByNoteCount<P extends PlateLike & { title: string }>(
  plates: P[],
  notes: NoteLike[],
): Array<{ plate: P; count: number }> {
  const counts = new Map<string, number>();
  for (const n of notes) if (n.groupId) counts.set(n.groupId, (counts.get(n.groupId) ?? 0) + 1);
  return plates
    .map((plate) => ({ plate, count: counts.get(plate.id) ?? 0 }))
    .sort((a, b) =>
      b.count - a.count ||
      a.plate.title.localeCompare(b.plate.title) ||
      a.plate.id.localeCompare(b.plate.id));
}

/**
 * The view translation that centers world rect `r` in a `vpW × vpH` viewport
 * at the current `scale` (zoom is left alone — a jump moves, it doesn't zoom).
 */
export function centerViewOn(r: Rect, vpW: number, vpH: number, scale: number): { tx: number; ty: number } {
  const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
  return { tx: vpW / 2 - cx * scale, ty: vpH / 2 - cy * scale };
}
