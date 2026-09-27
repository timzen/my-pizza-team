/**
 * lib/thoughtList.ts — The Thoughts **list view**'s pure rules: how a note is
 * titled and summarised in the sidebar, how notes are arranged into folders
 * (groups) and ordered, which notes a search keeps, and where a note lands on
 * the *canvas* when the list moves it into or out of a group.
 *
 * The list and the canvas are two views of one board, so a folder move made in
 * the list must leave the canvas tidy too: a note joining a group is placed in a
 * free slot inside that group's plate (otherwise the plate would stretch across
 * the canvas to wrap it), and a note leaving is placed below everything.
 *
 * Pure and dependency-free so it's unit-tested in tests/thought-list.test.ts.
 */

import { NOTE_H, NOTE_W, PLATE_PAD, plateRect, type NoteLike, type PlateLike } from "./thoughtGeometry.ts";

export interface ListNote extends NoteLike {
  content: string;
  pinned: boolean;
  updatedAt: string;
}
export interface ListGroup extends PlateLike {
  title: string;
}

/** Gap between notes placed by the list (matches the canvas's Tidy spacing). */
const GAP = 20;

/**
 * Strip a markdown line down to its words: heading hashes, list bullets,
 * checkboxes, quote markers, and inline emphasis/code/link syntax.
 */
function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → their text
    .replace(/[*_`~]+/g, "")
    .trim();
}

/** The non-empty lines of a note, as plain text (fenced-code markers dropped). */
function plainLines(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => !/^\s*(```|~~~)/.test(l))
    .map(plainLine)
    .filter((l) => l.length > 0);
}

/** A note's title in the list: its first line of text, like Apple Notes. */
export function noteTitle(content: string): string {
  return plainLines(content)[0] ?? "";
}

/** The line shown under the title: the next line of text, if any. */
export function noteSnippet(content: string): string {
  return plainLines(content)[1] ?? "";
}

/** List order within a folder: pinned first, then most recently edited. */
export function compareListNotes(a: ListNote, b: ListNote): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Does a note match a search? Case-insensitive substring of its markdown. */
export function matchesQuery(content: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || content.toLowerCase().includes(q);
}

export interface Folder<N, G> {
  group: G;
  notes: N[];
}

export interface ThoughtTree<N, G> {
  /** One folder per group, alphabetical (like folders), each sorted by compareListNotes. */
  folders: Folder<N, G>[];
  /** Notes in no group, after the folders. */
  loose: N[];
}

/**
 * Arrange notes into folders. With a search, notes that don't match are
 * dropped, and so are folders left empty — an empty folder is only worth
 * showing when you aren't searching (it's a place to put notes).
 */
export function buildThoughtTree<N extends ListNote, G extends ListGroup>(
  notes: N[],
  groups: G[],
  query = "",
): ThoughtTree<N, G> {
  const searching = query.trim() !== "";
  const kept = notes.filter((n) => matchesQuery(n.content, query));
  const known = new Set(groups.map((g) => g.id));
  const folders = [...groups]
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id))
    .map((group) => ({ group, notes: kept.filter((n) => n.groupId === group.id).sort(compareListNotes) }))
    .filter((f) => !searching || f.notes.length > 0);
  // A groupId naming no known group is treated as loose, so no note is ever hidden.
  const loose = kept.filter((n) => !n.groupId || !known.has(n.groupId)).sort(compareListNotes);
  return { folders, loose };
}

/**
 * The notes in the order the sidebar shows them, skipping collapsed folders —
 * what ↑/↓ steps through. A search shows every folder's matches regardless of
 * collapse, since hiding a hit would defeat the search.
 */
export function visibleOrder<N extends ListNote, G extends ListGroup>(
  tree: ThoughtTree<N, G>,
  collapsed: ReadonlySet<string>,
  searching = false,
): N[] {
  const out: N[] = [];
  for (const f of tree.folders) if (searching || !collapsed.has(f.group.id)) out.push(...f.notes);
  out.push(...tree.loose);
  return out;
}

/** Which note to select after `removedId` leaves the list: the next one, else the previous. */
export function neighbourAfterRemoval<N extends { id: string }>(order: N[], removedId: string): string | null {
  const i = order.findIndex((n) => n.id === removedId);
  if (i < 0) return order[0]?.id ?? null;
  return order[i + 1]?.id ?? order[i - 1]?.id ?? null;
}

function overlaps(x: number, y: number, n: NoteLike): boolean {
  return x < n.x + NOTE_W + GAP && x + NOTE_W + GAP > n.x && y < n.y + NOTE_H + GAP && y + NOTE_H + GAP > n.y;
}

/**
 * Where a note joining `group` goes on the canvas: the first grid slot inside
 * the plate (row-major from its top-left, as wide as the plate is drawn) that
 * no current member occupies. Filling gaps before growing keeps the plate as
 * small as it can be; when it's full the slot is a new row, and the plate grows
 * down to wrap it.
 */
export function slotInPlate(group: PlateLike, notes: NoteLike[], movingId?: string): { x: number; y: number } {
  const members = notes.filter((n) => n.groupId === group.id && n.id !== movingId);
  const r = plateRect(group, members);
  const cols = Math.max(1, Math.floor((r.right - r.left - 2 * PLATE_PAD + GAP) / (NOTE_W + GAP)));
  const originX = r.left + PLATE_PAD, originY = r.top + PLATE_PAD;
  for (let i = 0; ; i++) {
    const x = originX + (i % cols) * (NOTE_W + GAP);
    const y = originY + Math.floor(i / cols) * (NOTE_H + GAP);
    if (!members.some((m) => overlaps(x, y, m))) return { x: Math.round(x), y: Math.round(y) };
  }
}

/**
 * Where a note leaving every group (or a new loose note) goes: below
 * everything on the canvas — notes and plates alike — at the left edge of the
 * loose notes, so it never lands under a plate it isn't a member of.
 */
export function slotBelowAll(notes: NoteLike[], groups: PlateLike[], movingId?: string): { x: number; y: number } {
  const others = notes.filter((n) => n.id !== movingId);
  let bottom = -Infinity;
  for (const n of others) bottom = Math.max(bottom, n.y + NOTE_H);
  for (const g of groups) bottom = Math.max(bottom, plateRect(g, others).bottom);
  if (bottom === -Infinity) return { x: 0, y: 0 };
  const loose = others.filter((n) => !n.groupId);
  const x = loose.length ? Math.min(...loose.map((n) => n.x)) : 0;
  // Extra room above: a plate's title sits 28px over its top edge.
  return { x: Math.round(x), y: Math.round(bottom + GAP + 28) };
}

/**
 * Where a note should move on the canvas when its group changes somewhere other
 * than a canvas drop (the list, or a Group picker) — or `null` to leave it put.
 *
 * It stays put when it already sits where it belongs: joining a group whose
 * plate it's already on, or leaving to a spot no plate covers. Otherwise it
 * jumps to `slotInPlate` / `slotBelowAll`, so membership and position agree —
 * a far-away member would stretch its plate across the canvas, and an
 * ex-member left under a plate would look like it never left.
 */
export function placeForGroupChange(
  note: NoteLike,
  groupId: string | null,
  notes: NoteLike[],
  groups: PlateLike[],
): { x: number; y: number } | null {
  const others = notes.filter((n) => n.id !== note.id);
  const cx = note.x + NOTE_W / 2, cy = note.y + NOTE_H / 2;
  const covers = (g: PlateLike) => {
    const r = plateRect(g, others);
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  };
  if (groupId) {
    const target = groups.find((g) => g.id === groupId);
    if (!target) return null;
    return covers(target) ? null : slotInPlate(target, others);
  }
  return groups.some(covers) ? slotBelowAll(others, groups) : null;
}
