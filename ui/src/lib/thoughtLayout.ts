/**
 * lib/thoughtLayout — Pure layout math for the Thoughts canvas's toolbar and
 * overlays: Tidy's grid, the plate a new group wraps its selection in, which
 * notes a marquee hits, button zoom around a point, the plate-opacity cycle,
 * and the minimap's frame. No DOM or React, so it's unit-tested
 * (tests/thought-layout.test.ts); ThoughtsPage applies the results and
 * persists them.
 *
 * Notes are all one size (NOTE_W × NOTE_H, lib/thoughtGeometry).
 */

import { NOTE_H, NOTE_W, type NoteLike, type PlateLike } from "./thoughtGeometry.ts";

/** The canvas transform: world → screen is `screen = world * scale + t`. */
export interface CanvasView { tx: number; ty: number; scale: number }

/** A note's new canvas position. */
export interface NoteMove { id: string; x: number; y: number }
/** A group plate's new stored rect. */
export interface PlateUpdate { id: string; x: number; y: number; w: number; h: number }

/**
 * Tidy: lay every group's notes out in a grid (up to 4 columns) anchored at the
 * plate's top-left and shrink the plate to fit; grid the ungrouped notes (up to
 * 6 columns) from their current top-left. Groups with no members are left
 * alone. Positions are rounded, ready to persist.
 */
export function tidyLayout(notes: NoteLike[], groups: PlateLike[]): { moves: NoteMove[]; groupUpdates: PlateUpdate[] } {
  const GAP = 20, COL_W = NOTE_W + GAP, ROW_H = NOTE_H + GAP, PAD = 16, NH = NOTE_H;
  const moves: NoteMove[] = [];
  const groupUpdates: PlateUpdate[] = [];
  for (const g of groups) {
    const members = notes.filter((n) => n.groupId === g.id);
    if (!members.length) continue;
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(members.length))));
    const originX = g.x + PAD, originY = g.y + PAD;
    const placed = members.map((n, i) => ({ id: n.id, x: originX + (i % cols) * COL_W, y: originY + Math.floor(i / cols) * ROW_H }));
    for (const p of placed) moves.push({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
    // Shrink the stored rect to exactly wrap the grid (matches the render's
    // union padding/height so the plate ends up snug, not oversized).
    const minX = Math.min(...placed.map((p) => p.x)), minY = Math.min(...placed.map((p) => p.y));
    const maxX = Math.max(...placed.map((p) => p.x)) + NOTE_W, maxY = Math.max(...placed.map((p) => p.y)) + NH;
    groupUpdates.push({ id: g.id, x: Math.round(minX - PAD), y: Math.round(minY - PAD), w: Math.round(maxX - minX + PAD * 2), h: Math.round(maxY - minY + PAD * 2) });
  }
  const ungrouped = notes.filter((n) => !n.groupId);
  if (ungrouped.length) {
    const ox = Math.min(...ungrouped.map((n) => n.x));
    const oy = Math.min(...ungrouped.map((n) => n.y));
    const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(ungrouped.length))));
    ungrouped.forEach((n, i) => moves.push({ id: n.id, x: Math.round(ox + (i % cols) * COL_W), y: Math.round(oy + Math.floor(i / cols) * ROW_H) }));
  }
  return { moves, groupUpdates };
}

/**
 * The rect a new group's plate gets so it encapsulates the selected notes: their
 * bounding box plus `pad` on every side, rounded. `notes` must be non-empty.
 */
export function wrapNotes(notes: Array<Pick<NoteLike, "x" | "y">>, pad = 28): { x: number; y: number; w: number; h: number } {
  const minX = Math.min(...notes.map((n) => n.x)) - pad;
  const minY = Math.min(...notes.map((n) => n.y)) - pad;
  const maxX = Math.max(...notes.map((n) => n.x + NOTE_W)) + pad;
  const maxY = Math.max(...notes.map((n) => n.y + NOTE_H)) + pad;
  return { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
}

/**
 * Ids of the notes whose card intersects the marquee spanned by two world-space
 * corners (in any order). Touching an edge doesn't count.
 */
export function notesInMarquee(
  notes: Array<Pick<NoteLike, "id" | "x" | "y">>,
  a: { x: number; y: number },
  b: { x: number; y: number },
): string[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return notes.filter((n) => n.x < x1 && n.x + NOTE_W > x0 && n.y < y1 && n.y + NOTE_H > y0).map((n) => n.id);
}

/**
 * Zoom by `factor`, clamped to [min, max], keeping the screen point (cx, cy)
 * fixed — the toolbar buttons and shortcuts pass the viewport's center so the
 * view stays put.
 */
export function zoomAround(v: CanvasView, factor: number, cx: number, cy: number, bounds: { min: number; max: number }): CanvasView {
  const next = Math.min(bounds.max, Math.max(bounds.min, v.scale * factor));
  const k = next / v.scale;
  return { scale: next, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
}

/** The plate opacities, in the order the plate popover's button cycles them. */
export const PLATE_OPACITIES = ["subtle", "medium", "solid"] as const;
export type PlateOpacity = (typeof PLATE_OPACITIES)[number];

/** The opacity after `current` in the cycle (solid wraps to subtle). */
export function nextPlateOpacity(current: PlateOpacity): PlateOpacity {
  return PLATE_OPACITIES[(PLATE_OPACITIES.indexOf(current) + 1) % PLATE_OPACITIES.length]!; // modulo keeps it in range
}

/** Where the minimap draws the board: its world-space origin, its scale, and the viewport's world rect. */
export interface MinimapFrame {
  minX: number;
  minY: number;
  /** Minimap px per world unit. */
  s: number;
  viewport: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * The minimap's frame: the board's extent is every note ∪ the current viewport
 * (so the viewport is always shown), padded by `pad`, scaled to fit a
 * `mmW × mmH` box.
 */
export function minimapFrame(
  notes: Array<Pick<NoteLike, "x" | "y">>,
  view: CanvasView,
  vpW: number,
  vpH: number,
  mm: { w: number; h: number; pad: number },
): MinimapFrame {
  // Current viewport in world coords.
  const vwx0 = (0 - view.tx) / view.scale, vwy0 = (0 - view.ty) / view.scale;
  const vwx1 = (vpW - view.tx) / view.scale, vwy1 = (vpH - view.ty) / view.scale;
  let minX = vwx0, minY = vwy0, maxX = vwx1, maxY = vwy1;
  for (const n of notes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NOTE_W); maxY = Math.max(maxY, n.y + NOTE_H);
  }
  minX -= mm.pad; minY -= mm.pad; maxX += mm.pad; maxY += mm.pad;
  const extW = Math.max(1, maxX - minX), extH = Math.max(1, maxY - minY);
  const s = Math.min(mm.w / extW, mm.h / extH);
  return { minX, minY, s, viewport: { x0: vwx0, y0: vwy0, x1: vwx1, y1: vwy1 } };
}
