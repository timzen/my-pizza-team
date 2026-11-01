/**
 * useCanvasGestures — The Thoughts canvas's pointer gestures: pan (or, in
 * select mode / with Shift, marquee-select) on empty canvas, click/shift-click
 * and drag notes — dropping onto a plate joins its group, onto open canvas
 * leaves it (lib/thoughtGeometry) — and move/resize group plates. Each gesture
 * updates the page's notes/groups live and is persisted when the pointer comes
 * up (/api/thoughts/positions, PATCH /api/thoughts/:id, PATCH
 * /api/thought-groups/:id).
 *
 * Split out of ThoughtsPage, which owns the data and passes its state in; the
 * hook owns only the gesture in flight and its feedback (marquee, dragged ids,
 * drop target).
 */

import { useEffect, useRef, useState } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import { apiPost, apiPatch } from "@/hooks/useApi";
import { dropTarget, membershipChanges, noteCenter, plateRect } from "@/lib/thoughtGeometry";
import { notesInMarquee, type CanvasView } from "@/lib/thoughtLayout";
import type { Thought, ThoughtGroup } from "@shared/types";

const MIN_GROUP_W = 180;
const MIN_GROUP_H = 140;

/** The page state the gestures read and update. */
export interface CanvasGestureDeps {
  notes: Thought[];
  setNotes: Dispatch<SetStateAction<Thought[]>>;
  groups: ThoughtGroup[];
  setGroups: Dispatch<SetStateAction<ThoughtGroup[]>>;
  view: CanvasView;
  setView: Dispatch<SetStateAction<CanvasView>>;
  screenToWorld: (clientX: number, clientY: number) => { wx: number; wy: number };
  screenToWorldDelta: (dx: number, dy: number) => { dx: number; dy: number };
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  /** A plain drag on empty canvas marquee-selects instead of panning. */
  selectMode: boolean;
  /** Called on any primary press on empty canvas (the page closes its popovers). */
  onCanvasPress: () => void;
}

/** The canvas's pointer handlers and in-flight feedback. */
export function useCanvasGestures({
  notes, setNotes, groups, setGroups, view, setView, screenToWorld, screenToWorldDelta,
  selected, setSelected, selectMode, onCanvasPress,
}: CanvasGestureDeps) {
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // While a note drag is under way: the notes being dragged (their plates stop
  // wrapping them, so a member can be dragged out) and the plate the drop would
  // land in ("canvas" = open canvas, which removes members from their group).
  const [dragIds, setDragIds] = useState<ReadonlySet<string>>(new Set());
  const [dropHover, setDropHover] = useState<string | "canvas" | null>(null);

  // Active gesture: pan the canvas, drag a note, or move/resize a group plate.
  // Held in a ref so the window move/up listeners always see fresh values.
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; tx: number; ty: number; moved: boolean }
    | { kind: "drag"; ids: string[]; lead: string; startX: number; startY: number; starts: Array<{ id: string; x: number; y: number }>; moved: boolean }
    | { kind: "plate-move"; id: string; startX: number; startY: number; ox: number; oy: number; members: Array<{ id: string; x: number; y: number }> }
    | { kind: "plate-resize"; id: string; startX: number; startY: number; ow: number; oh: number }
    | { kind: "marquee"; startWX: number; startWY: number; curWX: number; curWY: number; additive: boolean; base: Set<string> }
    | null
  >(null);

  // ─── Pan / marquee (drag on empty canvas) ─────────────────────────
  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    onCanvasPress();
    if (selectMode || e.shiftKey) {
      // Marquee select. Shift is additive (keep the current selection as a base).
      const { wx, wy } = screenToWorld(e.clientX, e.clientY);
      gesture.current = { kind: "marquee", startWX: wx, startWY: wy, curWX: wx, curWY: wy, additive: e.shiftKey, base: new Set(selected) };
      setMarquee({ x0: wx, y0: wy, x1: wx, y1: wy });
    } else {
      gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    }
  };

  // ─── Note drag / select ────────────────────────────────────────────
  const onNotePointerDown = (e: ReactPointerEvent, note: Thought) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey) {
      // Shift-click toggles the note in the selection (no drag).
      setSelected((s) => { const next = new Set(s); if (next.has(note.id)) next.delete(note.id); else next.add(note.id); return next; });
      return;
    }
    // Dragging a note that's part of a multi-selection moves the whole selection;
    // otherwise just this note (a click without movement selects it alone).
    const ids = selected.has(note.id) && selected.size > 1 ? [...selected] : [note.id];
    const starts = notes.filter((n) => ids.includes(n.id)).map((n) => ({ id: n.id, x: n.x, y: n.y }));
    gesture.current = { kind: "drag", ids, lead: note.id, startX: e.clientX, startY: e.clientY, starts, moved: false };
  };

  // ─── Plate move / resize ───────────────────────────────────────────
  const onPlatePointerDown = (e: ReactPointerEvent, g: ThoughtGroup) => {
    // No editing-mode guard here: the title <input> stops propagation on its
    // own, so a pointer-down on the header (outside the input) should always
    // move the plate. (Bailing here let the event fall through to the canvas
    // and pan everything while a freshly-created group was in rename mode.)
    if (e.button !== 0) return;
    e.stopPropagation();
    // Capture member start positions so the group carries its notes as it moves.
    const members = notes.filter((n) => n.groupId === g.id).map((n) => ({ id: n.id, x: n.x, y: n.y }));
    gesture.current = { kind: "plate-move", id: g.id, startX: e.clientX, startY: e.clientY, ox: g.x, oy: g.y, members };
  };
  const onPlateResizePointerDown = (e: ReactPointerEvent, g: ThoughtGroup) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Resize from the plate as *drawn*, not its stored rect. The stored rect is
    // only a minimum — members can stretch the plate past it — and the handle
    // sits at the drawn corner. Starting from the smaller stored size meant the
    // first stretch of every drag did nothing visible (the plate felt stuck,
    // then jumped). Adopting the drawn rect makes the corner follow the pointer.
    const r = plateRect(g, notes);
    const drawn = { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
    setGroups((gs) => gs.map((gr) => (gr.id === g.id ? { ...gr, ...drawn } : gr)));
    gesture.current = { kind: "plate-resize", id: g.id, startX: e.clientX, startY: e.clientY, ow: drawn.w, oh: drawn.h };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (g.kind === "pan") {
        const dxs = e.clientX - g.startX, dys = e.clientY - g.startY;
        if (Math.abs(dxs) > 2 || Math.abs(dys) > 2) g.moved = true;
        setView((v) => ({ ...v, tx: g.tx + dxs, ty: g.ty + dys }));
      } else if (g.kind === "drag") {
        const { dx, dy } = screenToWorldDelta(e.clientX - g.startX, e.clientY - g.startY);
        if (!g.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) { g.moved = true; setDragIds(new Set(g.ids)); }
        setNotes((ns) => ns.map((n) => { const s = g.starts.find((ss) => ss.id === n.id); return s ? { ...n, x: s.x + dx, y: s.y + dy } : n; }));
        if (g.moved) {
          // Where would a drop land? That plate highlights and grows around the
          // note (the drop preview), or "leaving" when a member is over open
          // canvas. The pointer *or* the grabbed note's center counts, so a
          // note half over a plate targets it wherever you grabbed it.
          const { wx, wy } = screenToWorld(e.clientX, e.clientY);
          const s = g.starts.find((ss) => ss.id === g.lead);
          const lead = s ? noteCenter({ x: s.x + dx, y: s.y + dy }) : { x: wx, y: wy };
          const target = dropTarget([{ x: wx, y: wy }, lead], groups, notes, new Set(g.ids));
          setDropHover(target ?? "canvas");
        }
      } else if (g.kind === "plate-move") {
        const { dx, dy } = screenToWorldDelta(e.clientX - g.startX, e.clientY - g.startY);
        setGroups((gs) => gs.map((gr) => (gr.id === g.id ? { ...gr, x: g.ox + dx, y: g.oy + dy } : gr)));
        if (g.members.length) {
          setNotes((ns) => ns.map((n) => {
            const m = g.members.find((mm) => mm.id === n.id);
            return m ? { ...n, x: m.x + dx, y: m.y + dy } : n;
          }));
        }
      } else if (g.kind === "plate-resize") {
        const { dx, dy } = screenToWorldDelta(e.clientX - g.startX, e.clientY - g.startY);
        setGroups((gs) => gs.map((gr) => (gr.id === g.id ? { ...gr, w: Math.max(MIN_GROUP_W, g.ow + dx), h: Math.max(MIN_GROUP_H, g.oh + dy) } : gr)));
      } else if (g.kind === "marquee") {
        const { wx, wy } = screenToWorld(e.clientX, e.clientY);
        g.curWX = wx; g.curWY = wy;
        setMarquee({ x0: g.startWX, y0: g.startWY, x1: wx, y1: wy });
      }
    };
    const onUp = (e: PointerEvent) => {
      const g = gesture.current;
      gesture.current = null;
      if (g?.kind === "pan") {
        if (!g.moved) setSelected(new Set()); // a click on empty canvas clears selection
      } else if (g?.kind === "drag") {
        if (g.moved) {
          const ids = new Set(g.ids);
          const dragged = notes.filter((n) => ids.has(n.id));
          const moves = dragged.map((n) => ({ id: n.id, x: Math.round(n.x), y: Math.round(n.y) }));
          if (moves.length) apiPost("/api/thoughts/positions", { moves });
          // Drag-and-drop membership: the drop (under the pointer) decides —
          // onto a plate joins it, onto open canvas leaves the group.
          const { wx, wy } = screenToWorld(e.clientX, e.clientY);
          const leadNote = dragged.find((n) => n.id === g.lead);
          const points = leadNote ? [{ x: wx, y: wy }, noteCenter(leadNote)] : [{ x: wx, y: wy }];
          const changes = membershipChanges(dropTarget(points, groups, notes, ids), dragged);
          if (changes.length) {
            const byId = new Map(changes.map((c) => [c.id, c.groupId]));
            setNotes((ns) => ns.map((n) => (byId.has(n.id) ? { ...n, groupId: byId.get(n.id)! } : n)));
            for (const c of changes) apiPatch(`/api/thoughts/${c.id}`, { groupId: c.groupId });
          }
        } else {
          // A click (no drag) selects the note; double-click opens it.
          setSelected(new Set(g.ids.slice(0, 1)));
        }
        setDragIds(new Set());
        setDropHover(null);
      } else if (g?.kind === "plate-move") {
        const gr = groups.find((x) => x.id === g.id);
        if (gr) apiPatch(`/api/thought-groups/${gr.id}`, { x: Math.round(gr.x), y: Math.round(gr.y) });
        const ids = new Set(g.members.map((m) => m.id));
        const moves = notes.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, x: Math.round(n.x), y: Math.round(n.y) }));
        if (moves.length) apiPost("/api/thoughts/positions", { moves });
      } else if (g?.kind === "plate-resize") {
        const gr = groups.find((x) => x.id === g.id);
        // x/y too: resizing adopts the drawn rect (see onPlateResizePointerDown).
        if (gr) apiPatch(`/api/thought-groups/${gr.id}`, { x: Math.round(gr.x), y: Math.round(gr.y), w: Math.round(gr.w), h: Math.round(gr.h) });
      } else if (g?.kind === "marquee") {
        // Select notes whose rect intersects the marquee.
        const hit = notesInMarquee(notes, { x: g.startWX, y: g.startWY }, { x: g.curWX, y: g.curWY });
        setSelected(g.additive ? new Set([...g.base, ...hit]) : new Set(hit));
        setMarquee(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [notes, groups, screenToWorldDelta, screenToWorld, setNotes, setGroups, setView, setSelected]); // the setters are stable

  return { marquee, dragIds, dropHover, onCanvasPointerDown, onNotePointerDown, onPlatePointerDown, onPlateResizePointerDown };
}
