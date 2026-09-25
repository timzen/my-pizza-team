/**
 * ThoughtsPage — a lighter infinite canvas of markdown sticky notes (`/thoughts`).
 *
 * A personal workspace/outbox that feeds the assistant. Pan/zoom canvas, drag
 * to arrange, create/edit/color/pin notes, group them, and archive/restore.
 *
 * Notes are **all one size** on the canvas (lib/thoughtGeometry): click to
 * select, **double-click (or the hover ⤢ icon) to open** the large view/edit dialog
 * (components/thoughts/NoteDialog), which is also where color, pin, group,
 * archive, and delete live. **Drag a note onto a group plate** to add it;
 * drag a member off every plate to remove it (the drop is the only thing that
 * changes membership — position alone never does).
 * Deliberately excludes the standalone Thoughts product's cosmetic surface
 * (100+ backgrounds, skins, palettes). Talks to /api/thoughts. Two-state
 * lifecycle (active⇄archived); direct delete. See docs/ARCHITECTURE.md.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Minus, Trash2, Archive, ArchiveRestore, SquareStack, X, FolderPlus, Palette, Hash, Check, LayoutGrid, BoxSelect, Map as MapIcon, Maximize2 } from "lucide-react";
import { useApi, apiPost, apiPatch, apiDelete } from "@/hooks/useApi";
import { MarkdownView } from "@/components/ui/markdown-view";
import { NoteDialog } from "@/components/thoughts/NoteDialog";
import { THOUGHT_COLORS, noteClass, dotClass, plateTintStyle } from "@/lib/thoughtColors";
import { applyWheelToView, wheelGesture } from "@/lib/wheelGesture";
import { NOTE_W, NOTE_H, dropTarget, membershipChanges, noteCenter, plateRect, previewRect } from "@/lib/thoughtGeometry";
import { toggleTaskMarker } from "@/lib/taskMarkers";

interface Thought {
  id: string; content: string; color: string; status: "active" | "archived";
  x: number; y: number; w: number | null; h: number | null; zIndex: number;
  pinned: boolean; groupId: string | null; createdBy: string; createdAt: string; updatedAt: string;
}
interface ThoughtGroup { id: string; title: string; x: number; y: number; w: number; h: number; groupColor: string | null; plateOpacity: "subtle" | "medium" | "solid"; }
interface ThoughtsData { thoughts: Thought[]; groups: ThoughtGroup[]; }

const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
const MIN_GROUP_W = 180;
const MIN_GROUP_H = 140;

/** Next palette color for a new note: one step past the most-recently-created
 *  note's color (cycling), so a run of new notes fans through the palette. */
function nextRotatedColor(notes: Thought[]): string {
  if (notes.length === 0) return THOUGHT_COLORS[0];
  const recent = notes.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const idx = (THOUGHT_COLORS as readonly string[]).indexOf(recent.color);
  return THOUGHT_COLORS[(idx >= 0 ? idx + 1 : 0) % THOUGHT_COLORS.length];
}

export function ThoughtsPage() {
  const { data, refetch } = useApi<ThoughtsData>("/api/thoughts?status=active");
  const { data: archivedData, refetch: refetchArchived } = useApi<ThoughtsData>("/api/thoughts?status=archived");

  const [notes, setNotes] = useState<Thought[]>([]);
  const [groups, setGroups] = useState<ThoughtGroup[]>([]);
  const [seed, setSeed] = useState<ThoughtsData | null>(null);
  if (data && data !== seed) { setSeed(data); setNotes(data.thoughts); setGroups(data.groups); }

  const [view, setView] = useState({ tx: 40, ty: 40, scale: 1 });
  // The note open in the large view/edit dialog (and whether to start in Edit).
  const [openId, setOpenId] = useState<string | null>(null);
  const [openEditing, setOpenEditing] = useState(false);
  const [platePaintFor, setPlatePaintFor] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupTitle, setGroupTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Select mode: when on, a plain drag on empty canvas marquee-selects instead
  // of panning (toggled by the toolbar lasso or the `S` key). Shift+drag always
  // marquees regardless, so panning stays available.
  const [selectMode, setSelectMode] = useState(false);
  const [minimapOn, setMinimapOn] = useState(false);
  // While a note drag is under way: the notes being dragged (their plates stop
  // wrapping them, so a member can be dragged out) and the plate the drop would
  // land in ("canvas" = open canvas, which removes members from their group).
  const [dragIds, setDragIds] = useState<ReadonlySet<string>>(new Set());
  const [dropHover, setDropHover] = useState<string | "canvas" | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
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

  // ─── World ⇄ screen ────────────────────────────────────────────────
  const screenToWorldDelta = useCallback((dx: number, dy: number) => ({ dx: dx / view.scale, dy: dy / view.scale }), [view.scale]);
  // Absolute world coords under a screen point (for marquee hit-testing).
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const ox = rect ? clientX - rect.left : clientX;
    const oy = rect ? clientY - rect.top : clientY;
    return { wx: (ox - view.tx) / view.scale, wy: (oy - view.ty) / view.scale };
  }, [view]);

  // ─── Pan / marquee (drag on empty canvas) ─────────────────────────
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setPlatePaintFor(null);
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
  const onNotePointerDown = (e: React.PointerEvent, note: Thought) => {
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
  const onPlatePointerDown = (e: React.PointerEvent, g: ThoughtGroup) => {
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
  const onPlateResizePointerDown = (e: React.PointerEvent, g: ThoughtGroup) => {
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
        const x0 = Math.min(g.startWX, g.curWX), x1 = Math.max(g.startWX, g.curWX);
        const y0 = Math.min(g.startWY, g.curWY), y1 = Math.max(g.startWY, g.curWY);
        // Select notes whose rect intersects the marquee.
        const hit = notes.filter((n) => n.x < x1 && n.x + NOTE_W > x0 && n.y < y1 && n.y + NOTE_H > y0).map((n) => n.id);
        setSelected(g.additive ? new Set([...g.base, ...hit]) : new Set(hit));
        setMarquee(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [notes, groups, screenToWorldDelta, screenToWorld]);

  // Open a note in the large view/edit dialog.
  const openNote = useCallback((id: string, editing = false) => { setOpenId(id); setOpenEditing(editing); }, []);

  // ─── Wheel: swipe pans, pinch zooms (anchored at cursor) ───────────
  // Bound natively rather than via React's `onWheel` because React registers
  // wheel listeners as passive, where preventDefault() is a no-op — without it
  // a trackpad pinch zooms the whole browser page instead of the canvas.
  // Gesture classification and the transform math live in lib/wheelGesture
  // (pure, unit-tested in tests/wheel-gesture.test.ts).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = wheelGesture(e);
      const rect = el.getBoundingClientRect();
      const cursor = { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
      setView((v) => applyWheelToView(v, g, cursor, { min: MIN_SCALE, max: MAX_SCALE }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Button zoom: anchor on the viewport center so the view stays put.
  const zoomBy = (factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0, cy = rect ? rect.height / 2 : 0;
    setView((v) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = next / v.scale;
      return { scale: next, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  };

  // ─── Mutations ─────────────────────────────────────────────────────
  const createNote = async () => {
    // Place near the current viewport center so a new note lands in view.
    const rect = viewportRef.current?.getBoundingClientRect();
    const cx = rect ? (rect.width / 2 - view.tx) / view.scale : 0;
    const cy = rect ? (rect.height / 2 - view.ty) / view.scale : 0;
    const res = await apiPost<{ thought: Thought }>("/api/thoughts", { content: "", color: nextRotatedColor(notes), x: Math.round(cx - NOTE_W / 2), y: Math.round(cy - NOTE_H / 2) });
    await refetch();
    if (res.thought) openNote(res.thought.id, true);
  };
  const saveContent = async (id: string, content: string) => {
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, content } : n)));
    await apiPatch(`/api/thoughts/${id}`, { content });
  };
  const setColor = async (id: string, color: string) => {
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, color } : n)));
    await apiPatch(`/api/thoughts/${id}`, { color });
  };
  const setPinned = async (id: string, pinned: boolean) => {
    setNotes((ns) => ns.map((x) => (x.id === id ? { ...x, pinned } : x)));
    await apiPatch(`/api/thoughts/${id}`, { pinned });
  };
  const archive = async (id: string) => { await apiPost(`/api/thoughts/${id}/archive`, {}); refetch(); refetchArchived(); };
  const restore = async (id: string) => { await apiPost(`/api/thoughts/${id}/restore`, {}); refetch(); refetchArchived(); };
  const remove = async (id: string) => { await apiDelete(`/api/thoughts/${id}`); refetch(); refetchArchived(); };

  // ─── Selection-scoped actions (keyboard + multi-select) ───────────────
  const archiveSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setSelected(new Set());
    await Promise.all(ids.map((id) => apiPost(`/api/thoughts/${id}/archive`, {}).catch(() => {})));
    refetch(); refetchArchived();
  };
  const colorSelected = async (color: string) => {
    const ids = [...selected];
    if (!ids.length) return;
    setNotes((ns) => ns.map((n) => (selected.has(n.id) ? { ...n, color } : n)));
    await Promise.all(ids.map((id) => apiPatch(`/api/thoughts/${id}`, { color }).catch(() => {})));
  };

  // Toggle a checklist item inside a note (rewrites the markdown, persists).
  const toggleTask = async (n: Pick<Thought, "id" | "content">, index: number) => {
    const content = toggleTaskMarker(n.content, index);
    if (content === n.content) return;
    setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, content } : x)));
    await apiPatch(`/api/thoughts/${n.id}`, { content });
  };

  const newGroup = async () => {
    const memberIds = [...selected];
    let x: number, y: number, w: number | undefined, h: number | undefined;
    if (memberIds.length) {
      // Wrap the selected notes' bounding box so the plate encapsulates them.
      const sel = notes.filter((n) => selected.has(n.id));
      const pad = 28;
      const minX = Math.min(...sel.map((n) => n.x)) - pad;
      const minY = Math.min(...sel.map((n) => n.y)) - pad;
      const maxX = Math.max(...sel.map((n) => n.x + NOTE_W)) + pad;
      const maxY = Math.max(...sel.map((n) => n.y + NOTE_H)) + pad;
      x = Math.round(minX); y = Math.round(minY); w = Math.round(maxX - minX); h = Math.round(maxY - minY);
    } else {
      // Empty group: place centered in the current viewport.
      const rect = viewportRef.current?.getBoundingClientRect();
      x = Math.round((rect ? (rect.width / 2 - view.tx) / view.scale : 0) - 180);
      y = Math.round((rect ? (rect.height / 2 - view.ty) / view.scale : 0) - 130);
    }
    const res = await apiPost<{ group: ThoughtGroup }>("/api/thought-groups", { title: "New Group", x, y, w, h, memberIds });
    setSelected(new Set());
    await refetch();
    if (res.group) { setEditingGroupId(res.group.id); setGroupTitle(res.group.title); }
  };
  const saveGroupTitle = async (id: string) => {
    const title = groupTitle.trim() || "New Group";
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, title } : g)));
    setEditingGroupId(null);
    await apiPatch(`/api/thought-groups/${id}`, { title });
  };
  const ungroup = async (groupId: string) => { await apiDelete(`/api/thought-groups/${groupId}`); refetch(); };

  const setGroupColor = async (id: string, groupColor: string | null) => {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, groupColor } : g)));
    await apiPatch(`/api/thought-groups/${id}`, { groupColor });
  };
  const cyclePlateOpacity = async (id: string) => {
    const order = ["subtle", "medium", "solid"] as const;
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    const next = order[(order.indexOf(g.plateOpacity) + 1) % order.length];
    setGroups((gs) => gs.map((x) => (x.id === id ? { ...x, plateOpacity: next } : x)));
    await apiPatch(`/api/thought-groups/${id}`, { plateOpacity: next });
  };

  // Tidy: lay every group's notes out in a grid and shrink the plate to fit;
  // grid the ungrouped notes in place. Groups stay anchored at their current
  // top-left. One batched note-position write + a geometry update per group.
  const tidy = async () => {
    const GAP = 20, COL_W = NOTE_W + GAP, ROW_H = NOTE_H + GAP, PAD = 16, NH = NOTE_H;
    const moves: Array<{ id: string; x: number; y: number }> = [];
    const groupUpdates: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
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
    if (!moves.length) return;
    const byId = new Map(moves.map((m) => [m.id, m]));
    setNotes((ns) => ns.map((n) => { const m = byId.get(n.id); return m ? { ...n, x: m.x, y: m.y } : n; }));
    const guById = new Map(groupUpdates.map((u) => [u.id, u]));
    setGroups((gs) => gs.map((g) => { const u = guById.get(g.id); return u ? { ...g, x: u.x, y: u.y, w: u.w, h: u.h } : g; }));
    await apiPost("/api/thoughts/positions", { moves });
    for (const u of groupUpdates) apiPatch(`/api/thought-groups/${u.id}`, { x: u.x, y: u.y, w: u.w, h: u.h });
  };

  // Membership is explicit — a drop on a plate (see the drag handler) or the
  // dialog's Group picker — never inferred from where a note happens to sit.
  // null removes it from a group.
  const assignGroup = async (id: string, groupId: string | null) => {
    setNotes((ns) => ns.map((x) => (x.id === id ? { ...x, groupId } : x)));
    await apiPatch(`/api/thoughts/${id}`, { groupId });
  };
  const groupTitleById = (id: string) => groups.find((g) => g.id === id)?.title ?? "group";

  // ─── Keyboard shortcuts ──────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never hijack keys while typing in a note/title editor.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (openId || editingGroupId || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape") { setSelected(new Set()); setPlatePaintFor(null); return; }
      // Zoom (with modifier).
      if ((e.metaKey || e.ctrlKey) && e.key === "0") { e.preventDefault(); setView({ tx: 40, ty: 40, scale: 1 }); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomBy(1.2); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); zoomBy(1 / 1.2); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "s" || e.key === "S") { setSelectMode((m) => !m); return; }
      if (e.key === "m" || e.key === "M") { setMinimapOn((m) => !m); return; }
      // Selection-scoped.
      if (!selected.size) return;
      // Enter opens the (single) selected note, like double-clicking it.
      if (e.key === "Enter" && selected.size === 1) { e.preventDefault(); openNote([...selected][0]!); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); archiveSelected(); return; }
      if (e.key === "g" || e.key === "G") { newGroup(); return; }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= THOUGHT_COLORS.length) { colorSelected(THOUGHT_COLORS[n - 1]); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, editingGroupId, selected, zoomBy, archiveSelected, colorSelected, newGroup, openNote]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden select-none rounded-lg border border-border">
      {/* Toolbar */}
      <div className="absolute left-4 top-4 z-30 flex items-center gap-2">
        <button onClick={createNote} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
          <Plus className="h-4 w-4" /> Note
        </button>
        <button onClick={newGroup} title={selected.size > 0 ? `New group with ${selected.size} selected note(s)` : "New empty group"} className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm shadow-sm hover:bg-accent/50">
          <FolderPlus className="h-4 w-4" /> {selected.size > 0 ? `Group ${selected.size}` : "Group"}
        </button>
        <button onClick={tidy} title="Arrange notes into a grid (per group + ungrouped)" className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm shadow-sm hover:bg-accent/50">
          <LayoutGrid className="h-4 w-4" /> Tidy
        </button>
        <button onClick={() => setSelectMode((m) => !m)} title="Select mode (S) — drag to marquee-select; shift+drag always selects" className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm shadow-sm ${selectMode ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent/50"}`}>
          <BoxSelect className="h-4 w-4" /> Select{selected.size ? ` (${selected.size})` : ""}
        </button>
        <button onClick={() => setMinimapOn((m) => !m)} title="Minimap (M)" className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm shadow-sm ${minimapOn ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent/50"}`}>
          <MapIcon className="h-4 w-4" /> Map
        </button>
        <button onClick={() => setShowArchived((s) => !s)} className={`flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm shadow-sm hover:bg-accent/50 ${showArchived ? "bg-accent" : "bg-card"}`}>
          <Archive className="h-4 w-4" /> Archived {archivedData ? `(${archivedData.thoughts.length})` : ""}
        </button>
      </div>

      {/* Zoom controls: −  NN% (reset)  + */}
      <div className="absolute right-4 top-4 z-30 flex items-center rounded-md border border-border bg-card shadow-sm">
        <button onClick={() => zoomBy(1 / 1.2)} className="rounded-l-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground" title="Zoom out">
          <Minus className="h-4 w-4" />
        </button>
        <button onClick={() => setView({ tx: 40, ty: 40, scale: 1 })} className="min-w-[3rem] border-x border-border px-1 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground" title="Reset view">
          {Math.round(view.scale * 100)}%
        </button>
        <button onClick={() => zoomBy(1.2)} className="rounded-r-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground" title="Zoom in">
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Canvas viewport */}
      <div
        ref={viewportRef}
        onPointerDown={onCanvasPointerDown}
        className={`h-full w-full bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:24px_24px] ${selectMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      >
        {/* Transformed world layer */}
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}>
          {/* Group plates (named, movable/resizable rectangles; behind notes).
              Membership is set from a note's Group menu, not by position; the
              plate carries its member notes when you drag it. */}
          {groups.map((g) => {
            const memberCount = notes.filter((n) => n.groupId === g.id && !dragIds.has(n.id)).length;
            // The plate wraps its members — minus any being dragged, so a
            // member can be dragged out (lib/thoughtGeometry).
            // Drop feedback: this plate would receive the dragged note(s), so it
            // highlights and grows around them now — you see the group take the
            // note before you let go (previewRect).
            const isDropTarget = dropHover === g.id;
            const { left, top, right, bottom } = isDropTarget ? previewRect(g, notes, dragIds) : plateRect(g, notes, dragIds);
            const rect = { left, top, width: right - left, height: bottom - top };
            return (
            <div key={g.id} onPointerDown={(e) => onPlatePointerDown(e, g)} className={`group/plate absolute cursor-move rounded-xl border-2 border-dashed bg-muted/20 ${dragIds.size ? "transition-[left,top,width,height,background-color,border-color] duration-150" : "transition-colors"} ${isDropTarget ? "border-primary bg-primary/10" : "border-muted-foreground/30"}`} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, zIndex: 0, ...plateTintStyle(g.groupColor, g.plateOpacity) }}>
              {/* Header (title + controls). Bubbles to the plate for moving;
                  the input/buttons stop propagation for their own actions. */}
              <div className="absolute -top-7 left-0 right-0 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                  <SquareStack className="h-3 w-3 shrink-0" />
                  {editingGroupId === g.id ? (
                    <input
                      autoFocus
                      value={groupTitle}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => setGroupTitle(e.target.value)}
                      onBlur={() => saveGroupTitle(g.id)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveGroupTitle(g.id); if (e.key === "Escape") setEditingGroupId(null); }}
                      className="w-36 bg-transparent outline-none"
                    />
                  ) : (
                    <span className="cursor-text" onDoubleClick={() => { setEditingGroupId(g.id); setGroupTitle(g.title); }} title="Double-click to rename">{g.title}{memberCount ? ` (${memberCount})` : ""}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/plate:opacity-100">
                  <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setPlatePaintFor(platePaintFor === g.id ? null : g.id)} className="rounded bg-muted/80 p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground" title="Plate color"><Palette className="h-3 w-3" /></button>
                  <CopyId id={g.id} />
                  <button onPointerDown={(e) => e.stopPropagation()} onClick={() => ungroup(g.id)} className="rounded bg-muted/80 p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground" title="Delete group (notes stay)"><X className="h-3 w-3" /></button>
                </div>
              </div>
              {/* Plate color/opacity popover */}
              {platePaintFor === g.id && (
                <div className="absolute -top-9 right-0 z-40 flex items-center gap-1 rounded-md border border-border bg-card p-1 shadow" onPointerDown={(e) => e.stopPropagation()}>
                  {THOUGHT_COLORS.map((c) => (
                    <button key={c} onClick={() => setGroupColor(g.id, c)} className={`h-4 w-4 rounded-full ${dotClass(c)} ${g.groupColor === c ? "ring-2 ring-foreground/50" : ""}`} title={c} />
                  ))}
                  <button onClick={() => setGroupColor(g.id, null)} className="rounded p-0.5 text-muted-foreground hover:bg-accent/60" title="No tint"><X className="h-3.5 w-3.5" /></button>
                  <button onClick={() => cyclePlateOpacity(g.id)} className="ml-1 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/60" title="Cycle plate opacity">{g.plateOpacity}</button>
                </div>
              )}
              {memberCount === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/50">Empty group — drag notes here</div>
              )}
              {/* Resize handle: a 28px hit box straddling the corner (easy to
                  grab), with a visible grip that's always faintly there and
                  firms up on hover. */}
              <div
                onPointerDown={(e) => onPlateResizePointerDown(e, g)}
                className="group/grip absolute -bottom-3 -right-3 z-10 flex h-8 w-8 cursor-se-resize items-center justify-center"
                title="Drag to resize the group"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover/plate:border-muted-foreground/50 group-hover/plate:text-foreground group-hover/grip:border-primary group-hover/grip:text-primary">
                  <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
                    <path d="M10.5 3.5 3.5 10.5M10.5 7 7 10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </span>
              </div>
            </div>
          ); })}

          {/* Notes — all one size (lib/thoughtGeometry). Click selects,
              double-click opens the large view/edit dialog, drag moves (and
              drops onto / off of group plates). */}
          {notes.map((n) => {
            const dragging = dragIds.has(n.id);
            // Dragging a member over open canvas: it'll leave its group on drop.
            const leaving = dragging && dropHover === "canvas" && n.groupId !== null;
            return (
            <div
              key={n.id}
              onPointerDown={(e) => onNotePointerDown(e, n)}
              onDoubleClick={() => openNote(n.id)}
              className={`group absolute flex flex-col overflow-hidden rounded-lg border shadow-sm ${noteClass(n.color)} ${n.pinned ? "ring-2 ring-offset-1 ring-amber-400/70" : ""} ${selected.has(n.id) ? "outline outline-2 outline-primary outline-offset-2" : ""} ${dragging ? "cursor-grabbing opacity-90 shadow-lg" : "cursor-pointer"} ${leaving ? "border-dashed" : ""}`}
              style={{ left: n.x, top: n.y, width: NOTE_W, height: NOTE_H, zIndex: dragging ? 60 : (n.zIndex || 1) + 1 }}
              title="Double-click to open"
              data-note-id={n.id}
            >
              {/* Body — clipped to the card with a soft fade (the full note is
                  one double-click away). Checklists stay clickable here. */}
              <div className="min-h-0 flex-1 overflow-hidden p-3 [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
                {n.content.trim()
                  ? <MarkdownView content={n.content} className="text-[13px] [&_p]:mb-1" onToggleTask={(i) => toggleTask(n, i)} />
                  : <span className="text-sm text-muted-foreground/60">Empty note — double-click to write</span>}
              </div>

              {/* Expand (top-right, on hover): the discoverable / touch-friendly
                  twin of double-click. */}
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); openNote(n.id); }}
                className="absolute right-1 top-1 rounded bg-background/70 p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                title="Open"
                aria-label="Open note"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>

              {/* Group membership chip (bottom-left) + copyable note id (bottom-right), on hover. */}
              {n.groupId && (
                <div className="pointer-events-none absolute bottom-1 left-1.5 flex items-center gap-0.5 rounded bg-background/70 px-1 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  <SquareStack className="h-2.5 w-2.5" /> {leaving ? "leaving group" : groupTitleById(n.groupId)}
                </div>
              )}
              <div className="absolute bottom-1 right-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                <CopyId id={n.id} />
              </div>
            </div>
          ); })}

          {/* Marquee selection rectangle (shift+drag on empty canvas) */}
          {marquee && (
            <div
              className="pointer-events-none absolute rounded border-2 border-primary/60 bg-primary/10"
              style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0), zIndex: 50 }}
            />
          )}
        </div>
      </div>

      {/* Minimap (bottom-left; M toggles) */}
      {minimapOn && <Minimap notes={notes} view={view} viewportRef={viewportRef} onRecenter={(wx, wy) => {
        const r = viewportRef.current?.getBoundingClientRect();
        const vpW = r?.width ?? 800, vpH = r?.height ?? 600;
        setView((v) => ({ ...v, tx: vpW / 2 - wx * v.scale, ty: vpH / 2 - wy * v.scale }));
      }} />}

      {/* The large view/edit experience (double-click a note). */}
      <NoteDialog
        note={notes.find((n) => n.id === openId) ?? null}
        groups={groups}
        startEditing={openEditing}
        onClose={() => setOpenId(null)}
        onSave={saveContent}
        onColor={setColor}
        onPin={setPinned}
        onGroup={assignGroup}
        onArchive={archive}
        onDelete={remove}
        onToggleTask={saveContent}
        idChip={openId ? <CopyId id={openId} /> : null}
      />

      {/* Archived drawer */}
      {showArchived && (
        <div className="absolute right-0 top-0 z-30 flex h-full w-80 flex-col border-l border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border p-3">
            <span className="font-medium">Archived</span>
            <button onClick={() => setShowArchived(false)} className="rounded p-1 hover:bg-accent/50"><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {(archivedData?.thoughts ?? []).length === 0 && <p className="text-sm text-muted-foreground">Nothing archived.</p>}
            {(archivedData?.thoughts ?? []).map((n) => (
              <div key={n.id} className={`rounded-md border p-2 ${noteClass(n.color)}`}>
                <div className="mb-1 line-clamp-3 text-xs">{n.content.trim() || <span className="text-muted-foreground/60">(empty)</span>}</div>
                <div className="flex gap-1">
                  <button onClick={() => restore(n.id)} className="flex items-center gap-1 rounded bg-card/70 px-1.5 py-0.5 text-xs hover:bg-card"><ArchiveRestore className="h-3 w-3" /> Restore</button>
                  <button onClick={() => remove(n.id)} className="flex items-center gap-1 rounded bg-card/70 px-1.5 py-0.5 text-xs hover:bg-card"><Trash2 className="h-3 w-3" /> Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {notes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
          <p>Empty canvas — hit <span className="font-medium text-foreground">+ Note</span> to capture a thought.</p>
        </div>
      )}
    </div>
  );
}

/** A click-to-copy id chip (monospace). Copying lets you paste a note/group id
 *  into the assistant chat to reference it precisely. */
function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title={`Copy id: ${id}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
      }}
      className="inline-flex items-center gap-0.5 rounded bg-background/70 px-1 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-background hover:text-foreground"
    >
      {copied ? <Check className="h-2.5 w-2.5" /> : <Hash className="h-2.5 w-2.5" />}
      {copied ? "copied" : id}
    </button>
  );
}

/** A small orientation minimap (bottom-left): note dots + the current viewport
 *  rectangle over the board's extent. Click/drag to recenter the view. */
function Minimap({ notes, view, viewportRef, onRecenter }: {
  notes: Thought[];
  view: { tx: number; ty: number; scale: number };
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onRecenter: (wx: number, wy: number) => void;
}) {
  const MMW = 192, MMH = 128, PAD = 40;
  const r = viewportRef.current?.getBoundingClientRect();
  const vpW = r?.width ?? 800, vpH = r?.height ?? 600;
  // Current viewport in world coords.
  const vwx0 = (0 - view.tx) / view.scale, vwy0 = (0 - view.ty) / view.scale;
  const vwx1 = (vpW - view.tx) / view.scale, vwy1 = (vpH - view.ty) / view.scale;
  // Board extent = notes ∪ viewport (+ padding), so the viewport is always shown.
  let minX = vwx0, minY = vwy0, maxX = vwx1, maxY = vwy1;
  for (const n of notes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NOTE_W); maxY = Math.max(maxY, n.y + NOTE_H);
  }
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  const extW = Math.max(1, maxX - minX), extH = Math.max(1, maxY - minY);
  const s = Math.min(MMW / extW, MMH / extH);
  const mx = (wx: number) => (wx - minX) * s;
  const my = (wy: number) => (wy - minY) * s;

  const recenterFrom = (e: React.PointerEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    onRecenter(minX + (e.clientX - box.left) / s, minY + (e.clientY - box.top) / s);
  };

  return (
    <div
      className="absolute bottom-4 left-4 z-30 overflow-hidden rounded-md border border-border bg-card/90 shadow-sm"
      style={{ width: MMW, height: MMH }}
      onPointerDown={(e) => { e.preventDefault(); recenterFrom(e); }}
      onPointerMove={(e) => { if (e.buttons === 1) recenterFrom(e); }}
      title="Minimap — click to jump"
    >
      {notes.map((n) => (
        <div key={n.id} className="absolute rounded-[1px] bg-muted-foreground/50" style={{ left: mx(n.x), top: my(n.y), width: Math.max(2, NOTE_W * s), height: Math.max(2, NOTE_H * s) }} />
      ))}
      {/* Viewport rectangle */}
      <div className="absolute border border-primary bg-primary/10" style={{ left: mx(vwx0), top: my(vwy0), width: (vwx1 - vwx0) * s, height: (vwy1 - vwy0) * s }} />
    </div>
  );
}
