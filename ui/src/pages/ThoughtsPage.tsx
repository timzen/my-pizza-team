/**
 * ThoughtsPage — a lighter infinite canvas of markdown sticky notes (`/thoughts`).
 *
 * A personal workspace/outbox that feeds the assistant. Pan/zoom canvas, drag
 * to arrange, create/edit/color/pin notes, group them, and archive/restore.
 * Deliberately excludes the standalone Thoughts product's cosmetic surface
 * (100+ backgrounds, skins, palettes). Talks to /api/thoughts. Two-state
 * lifecycle (active⇄archived); direct delete. See docs/ARCHITECTURE.md.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Minus, Pin, PinOff, Trash2, Archive, ArchiveRestore, SquareStack, X, FolderPlus, Palette, Hash, Check } from "lucide-react";
import { useApi, apiPost, apiPatch, apiDelete } from "@/hooks/useApi";
import { MarkdownView } from "@/components/ui/markdown-view";
import { THOUGHT_COLORS, noteClass, dotClass } from "@/lib/thoughtColors";

interface Thought {
  id: string; content: string; color: string; status: "active" | "archived";
  x: number; y: number; w: number | null; h: number | null; zIndex: number;
  pinned: boolean; groupId: string | null; createdBy: string; createdAt: string; updatedAt: string;
}
interface ThoughtGroup { id: string; title: string; x: number; y: number; w: number; h: number; }
interface ThoughtsData { thoughts: Thought[]; groups: ThoughtGroup[]; }

const NOTE_W = 220;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
const MIN_GROUP_W = 180;
const MIN_GROUP_H = 140;

/** Flip the index-th `- [ ]`↔`- [x]` task marker (source order) in markdown. */
function toggleTaskMarker(content: string, index: number): string {
  let i = -1;
  return content.replace(/(^[ \t]*[-*+] \[)([ xX])(\])/gm, (m, pre, mark, post) => {
    i++;
    return i === index ? `${pre}${mark === " " ? "x" : " "}${post}` : m;
  });
}

export function ThoughtsPage() {
  const { data, refetch } = useApi<ThoughtsData>("/api/thoughts?status=active");
  const { data: archivedData, refetch: refetchArchived } = useApi<ThoughtsData>("/api/thoughts?status=archived");

  const [notes, setNotes] = useState<Thought[]>([]);
  const [groups, setGroups] = useState<ThoughtGroup[]>([]);
  const [seed, setSeed] = useState<ThoughtsData | null>(null);
  if (data && data !== seed) { setSeed(data); setNotes(data.thoughts); setGroups(data.groups); }

  const [view, setView] = useState({ tx: 40, ty: 40, scale: 1 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const [groupMenuFor, setGroupMenuFor] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupTitle, setGroupTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  // Active gesture: pan the canvas, drag a note, or move/resize a group plate.
  // Held in a ref so the window move/up listeners always see fresh values.
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; tx: number; ty: number; moved: boolean }
    | { kind: "drag"; id: string; startX: number; startY: number; ox: number; oy: number; moved: boolean }
    | { kind: "plate-move"; id: string; startX: number; startY: number; ox: number; oy: number; members: Array<{ id: string; x: number; y: number }> }
    | { kind: "plate-resize"; id: string; startX: number; startY: number; ow: number; oh: number }
    | { kind: "marquee"; startWX: number; startWY: number; curWX: number; curWY: number }
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
    setPaletteFor(null); setGroupMenuFor(null);
    if (e.shiftKey) {
      // Shift+drag on empty canvas = marquee select (plain drag still pans).
      const { wx, wy } = screenToWorld(e.clientX, e.clientY);
      gesture.current = { kind: "marquee", startWX: wx, startWY: wy, curWX: wx, curWY: wy };
      setMarquee({ x0: wx, y0: wy, x1: wx, y1: wy });
    } else {
      gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    }
  };

  // ─── Note drag / select ────────────────────────────────────────────
  const onNotePointerDown = (e: React.PointerEvent, note: Thought) => {
    if (e.button !== 0 || editingId === note.id) return;
    e.stopPropagation();
    if (e.shiftKey) {
      // Shift-click toggles the note in the selection (no drag).
      setSelected((s) => { const next = new Set(s); if (next.has(note.id)) next.delete(note.id); else next.add(note.id); return next; });
      return;
    }
    gesture.current = { kind: "drag", id: note.id, startX: e.clientX, startY: e.clientY, ox: note.x, oy: note.y, moved: false };
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
    gesture.current = { kind: "plate-resize", id: g.id, startX: e.clientX, startY: e.clientY, ow: g.w, oh: g.h };
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
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) g.moved = true;
        setNotes((ns) => ns.map((n) => (n.id === g.id ? { ...n, x: g.ox + dx, y: g.oy + dy } : n)));
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
    const onUp = () => {
      const g = gesture.current;
      gesture.current = null;
      if (g?.kind === "pan") {
        if (!g.moved) setSelected(new Set()); // a click on empty canvas clears selection
      } else if (g?.kind === "drag") {
        const n = notes.find((x) => x.id === g.id);
        if (!n) return;
        if (g.moved) {
          apiPost("/api/thoughts/positions", { moves: [{ id: n.id, x: Math.round(n.x), y: Math.round(n.y) }] });
        } else {
          setSelected(new Set([n.id])); // a click (no drag) selects just this note
        }
      } else if (g?.kind === "plate-move") {
        const gr = groups.find((x) => x.id === g.id);
        if (gr) apiPatch(`/api/thought-groups/${gr.id}`, { x: Math.round(gr.x), y: Math.round(gr.y) });
        const ids = new Set(g.members.map((m) => m.id));
        const moves = notes.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, x: Math.round(n.x), y: Math.round(n.y) }));
        if (moves.length) apiPost("/api/thoughts/positions", { moves });
      } else if (g?.kind === "plate-resize") {
        const gr = groups.find((x) => x.id === g.id);
        if (gr) apiPatch(`/api/thought-groups/${gr.id}`, { w: Math.round(gr.w), h: Math.round(gr.h) });
      } else if (g?.kind === "marquee") {
        const x0 = Math.min(g.startWX, g.curWX), x1 = Math.max(g.startWX, g.curWX);
        const y0 = Math.min(g.startWY, g.curWY), y1 = Math.max(g.startWY, g.curWY);
        // Select notes whose rect intersects the marquee.
        const hit = notes.filter((n) => n.x < x1 && n.x + (n.w ?? NOTE_W) > x0 && n.y < y1 && n.y + (n.h ?? 140) > y0).map((n) => n.id);
        setSelected(new Set(hit));
        setMarquee(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [notes, groups, screenToWorldDelta, screenToWorld]);

  // ─── Zoom (wheel, anchored at cursor) ──────────────────────────────
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    setView((v) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      const k = next / v.scale;
      return { scale: next, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  };

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
    const res = await apiPost<{ thought: Thought }>("/api/thoughts", { content: "", x: Math.round(cx), y: Math.round(cy) });
    await refetch();
    if (res.thought) { setEditingId(res.thought.id); setEditText(""); }
  };
  const saveEdit = async (id: string) => {
    await apiPatch(`/api/thoughts/${id}`, { content: editText });
    setEditingId(null);
    refetch();
  };
  const setColor = async (id: string, color: string) => {
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, color } : n)));
    setPaletteFor(null);
    await apiPatch(`/api/thoughts/${id}`, { color });
  };
  const togglePin = async (n: Thought) => {
    setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, pinned: !x.pinned } : x)));
    await apiPatch(`/api/thoughts/${n.id}`, { pinned: !n.pinned });
  };
  const archive = async (id: string) => { await apiPost(`/api/thoughts/${id}/archive`, {}); refetch(); refetchArchived(); };
  const restore = async (id: string) => { await apiPost(`/api/thoughts/${id}/restore`, {}); refetch(); refetchArchived(); };
  const remove = async (id: string) => { await apiDelete(`/api/thoughts/${id}`); refetch(); refetchArchived(); };

  // Toggle a checklist item inside a note (rewrites the markdown, persists).
  const toggleTask = async (n: Thought, index: number) => {
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
      const maxX = Math.max(...sel.map((n) => n.x + (n.w ?? NOTE_W))) + pad;
      const maxY = Math.max(...sel.map((n) => n.y + (n.h ?? 140))) + pad;
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

  // Membership is explicit (via a note's Group menu), not spatial — assigning
  // never depends on where a note happens to sit. null removes it from a group.
  const assignGroup = async (id: string, groupId: string | null) => {
    setGroupMenuFor(null);
    setNotes((ns) => ns.map((x) => (x.id === id ? { ...x, groupId } : x)));
    await apiPatch(`/api/thoughts/${id}`, { groupId });
  };
  const groupTitleById = (id: string) => groups.find((g) => g.id === id)?.title ?? "group";

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
        onWheel={onWheel}
        className="h-full w-full cursor-grab bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:24px_24px] active:cursor-grabbing"
      >
        {/* Transformed world layer */}
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}>
          {/* Group plates (named, movable/resizable rectangles; behind notes).
              Membership is set from a note's Group menu, not by position; the
              plate carries its member notes when you drag it. */}
          {groups.map((g) => {
            const members = notes.filter((n) => n.groupId === g.id);
            const memberCount = members.length;
            // The plate encapsulates its members: render the union of its own
            // stored rect (the movable/resizable minimum) and the members'
            // bounding box (+padding), so adding a note grows the plate to wrap it.
            const pad = 16;
            let left = g.x, top = g.y, right = g.x + g.w, bottom = g.y + g.h;
            for (const m of members) {
              left = Math.min(left, m.x - pad);
              top = Math.min(top, m.y - pad);
              right = Math.max(right, m.x + (m.w ?? NOTE_W) + pad);
              bottom = Math.max(bottom, m.y + (m.h ?? 140) + pad);
            }
            const rect = { left, top, width: right - left, height: bottom - top };
            return (
            <div key={g.id} onPointerDown={(e) => onPlatePointerDown(e, g)} className="group/plate absolute cursor-move rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/20" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, zIndex: 0 }}>
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
                  <CopyId id={g.id} />
                  <button onPointerDown={(e) => e.stopPropagation()} onClick={() => ungroup(g.id)} className="rounded bg-muted/80 p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground" title="Delete group (notes stay)"><X className="h-3 w-3" /></button>
                </div>
              </div>
              {memberCount === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/50">Empty group — add notes with a note's ⌘ Group menu</div>
              )}
              {/* Resize handle */}
              <div onPointerDown={(e) => onPlateResizePointerDown(e, g)} className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize rounded-br-xl border-b-2 border-r-2 border-muted-foreground/40 opacity-0 transition-opacity group-hover/plate:opacity-100" />
            </div>
          ); })}

          {/* Notes */}
          {notes.map((n) => (
            <div
              key={n.id}
              onPointerDown={(e) => onNotePointerDown(e, n)}
              className={`group absolute rounded-lg border shadow-sm ${noteClass(n.color)} ${n.pinned ? "ring-2 ring-offset-1 ring-amber-400/70" : ""} ${selected.has(n.id) ? "outline outline-2 outline-primary outline-offset-2" : ""}`}
              style={{ left: n.x, top: n.y, width: n.w ?? NOTE_W, minHeight: 80, zIndex: (n.zIndex || 1) + 1 }}
            >
              {/* Hover toolbar. Wrapped with bottom padding that overlaps the
                  note's top edge so moving the cursor up to the toolbar never
                  crosses a dead zone (which would drop group-hover and hide it). */}
              <div className="absolute -top-9 right-0 hidden pb-2 group-hover:block">
                <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm">
                  <IconBtn title="Color" onClick={() => { setPaletteFor(paletteFor === n.id ? null : n.id); setGroupMenuFor(null); }}><Palette className="h-3.5 w-3.5" /></IconBtn>
                  <IconBtn title="Group" onClick={() => { setGroupMenuFor(groupMenuFor === n.id ? null : n.id); setPaletteFor(null); }}><SquareStack className="h-3.5 w-3.5" /></IconBtn>
                  <IconBtn title={n.pinned ? "Unpin" : "Pin"} onClick={() => togglePin(n)}>{n.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</IconBtn>
                  <IconBtn title="Archive" onClick={() => archive(n.id)}><Archive className="h-3.5 w-3.5" /></IconBtn>
                  <IconBtn title="Delete" onClick={() => remove(n.id)}><Trash2 className="h-3.5 w-3.5" /></IconBtn>
                </div>
              </div>

              {/* Palette popover */}
              {paletteFor === n.id && (
                <div className="absolute -top-8 left-0 z-40 flex gap-1 rounded-md border border-border bg-card p-1 shadow" onPointerDown={(e) => e.stopPropagation()}>
                  {THOUGHT_COLORS.map((c) => (
                    <button key={c} onClick={() => setColor(n.id, c)} className={`h-4 w-4 rounded-full ${dotClass(c)} ${n.color === c ? "ring-2 ring-foreground/50" : ""}`} title={c} />
                  ))}
                </div>
              )}

              {/* Group menu popover — explicit add/remove membership */}
              {groupMenuFor === n.id && (
                <div className="absolute -top-8 left-0 z-40 w-52 rounded-md border border-border bg-card p-1 text-sm shadow" onPointerDown={(e) => e.stopPropagation()}>
                  {groups.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No groups yet — make one with the <span className="font-medium">Group</span> button.</div>}
                  {groups.map((gr) => (
                    <button key={gr.id} onClick={() => assignGroup(n.id, gr.id)} className={`block w-full truncate rounded px-2 py-1 text-left hover:bg-accent/60 ${n.groupId === gr.id ? "font-medium text-foreground" : ""}`}>{n.groupId === gr.id ? "✓ " : ""}{gr.title}</button>
                  ))}
                  {n.groupId && <button onClick={() => assignGroup(n.id, null)} className="mt-1 block w-full rounded border-t border-border px-2 py-1 text-left text-muted-foreground hover:bg-accent/60">Remove from group</button>}
                </div>
              )}

              {/* Body */}
              {editingId === n.id ? (
                <div className="p-2" onPointerDown={(e) => e.stopPropagation()}>
                  <textarea
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => saveEdit(n.id)}
                    onKeyDown={(e) => { if (e.key === "Escape") setEditingId(null); if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveEdit(n.id); }}
                    className="h-32 w-full resize-none bg-transparent text-sm outline-none"
                    placeholder="Write a thought… (markdown)"
                  />
                </div>
              ) : (
                <div className="cursor-text p-3" onDoubleClick={() => { setEditingId(n.id); setEditText(n.content); }}>
                  {n.content.trim()
                    ? <MarkdownView content={n.content} onToggleTask={(i) => toggleTask(n, i)} />
                    : <span className="text-sm text-muted-foreground/60">Empty note — double-click to edit</span>}
                </div>
              )}

              {/* Copyable note id + group chip (bottom, on hover). */}
              {editingId !== n.id && (
                <>
                  {n.groupId && (
                    <div className="pointer-events-none absolute bottom-1 left-1.5 flex items-center gap-0.5 rounded bg-background/70 px-1 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                      <SquareStack className="h-2.5 w-2.5" /> {groupTitleById(n.groupId)}
                    </div>
                  )}
                  <div className="absolute bottom-1 right-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <CopyId id={n.id} />
                  </div>
                </>
              )}
            </div>
          ))}

          {/* Marquee selection rectangle (shift+drag on empty canvas) */}
          {marquee && (
            <div
              className="pointer-events-none absolute rounded border-2 border-primary/60 bg-primary/10"
              style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0), zIndex: 50 }}
            />
          )}
        </div>
      </div>

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

function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button title={title} onClick={onClick} onPointerDown={(e) => e.stopPropagation()} className="rounded p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground">
      {children}
    </button>
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
