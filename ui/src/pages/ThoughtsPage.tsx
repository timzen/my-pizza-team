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
import { Plus, Minus, Pin, PinOff, Trash2, Archive, ArchiveRestore, Users, X, FolderPlus, Palette, Hash, Check } from "lucide-react";
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
const NOTE_H_EST = 120;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;
const MIN_GROUP_W = 180;
const MIN_GROUP_H = 140;

/** The group whose rectangle contains a note's center (topmost by order wins). */
function containingGroup(groups: ThoughtGroup[], n: { x: number; y: number; w: number | null; h: number | null }): string | null {
  const cx = n.x + (n.w ?? NOTE_W) / 2;
  const cy = n.y + (n.h ?? NOTE_H_EST) / 2;
  let hit: string | null = null;
  for (const g of groups) {
    if (cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h) hit = g.id;
  }
  return hit;
}

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
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupTitle, setGroupTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  // Active gesture: pan the canvas, drag a note, or move/resize a group plate.
  // Held in a ref so the window move/up listeners always see fresh values.
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; tx: number; ty: number }
    | { kind: "drag"; id: string; startX: number; startY: number; ox: number; oy: number; moved: boolean }
    | { kind: "plate-move"; id: string; startX: number; startY: number; ox: number; oy: number }
    | { kind: "plate-resize"; id: string; startX: number; startY: number; ow: number; oh: number }
    | null
  >(null);

  // ─── World ⇄ screen ────────────────────────────────────────────────
  const screenToWorldDelta = useCallback((dx: number, dy: number) => ({ dx: dx / view.scale, dy: dy / view.scale }), [view.scale]);

  // ─── Pan (drag on empty canvas) ────────────────────────────────────
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setPaletteFor(null);
    gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty };
  };

  // ─── Note drag ─────────────────────────────────────────────────────
  const onNotePointerDown = (e: React.PointerEvent, note: Thought) => {
    if (e.button !== 0 || editingId === note.id) return;
    e.stopPropagation();
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
    gesture.current = { kind: "plate-move", id: g.id, startX: e.clientX, startY: e.clientY, ox: g.x, oy: g.y };
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
        setView((v) => ({ ...v, tx: g.tx + (e.clientX - g.startX), ty: g.ty + (e.clientY - g.startY) }));
      } else if (g.kind === "drag") {
        const { dx, dy } = screenToWorldDelta(e.clientX - g.startX, e.clientY - g.startY);
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) g.moved = true;
        setNotes((ns) => ns.map((n) => (n.id === g.id ? { ...n, x: g.ox + dx, y: g.oy + dy } : n)));
      } else if (g.kind === "plate-move") {
        const { dx, dy } = screenToWorldDelta(e.clientX - g.startX, e.clientY - g.startY);
        setGroups((gs) => gs.map((gr) => (gr.id === g.id ? { ...gr, x: g.ox + dx, y: g.oy + dy } : gr)));
      } else if (g.kind === "plate-resize") {
        const { dx, dy } = screenToWorldDelta(e.clientX - g.startX, e.clientY - g.startY);
        setGroups((gs) => gs.map((gr) => (gr.id === g.id ? { ...gr, w: Math.max(MIN_GROUP_W, g.ow + dx), h: Math.max(MIN_GROUP_H, g.oh + dy) } : gr)));
      }
    };
    const onUp = () => {
      const g = gesture.current;
      gesture.current = null;
      if (g?.kind === "drag" && g.moved) {
        const n = notes.find((x) => x.id === g.id);
        if (!n) return;
        apiPost("/api/thoughts/positions", { moves: [{ id: n.id, x: Math.round(n.x), y: Math.round(n.y) }] });
        // Membership follows the drop: joins the plate it landed in, or leaves.
        const gid = containingGroup(groups, n);
        if ((n.groupId ?? null) !== gid) {
          setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, groupId: gid } : x)));
          apiPatch(`/api/thoughts/${n.id}`, { groupId: gid });
        }
      } else if (g?.kind === "plate-move") {
        const gr = groups.find((x) => x.id === g.id);
        if (gr) apiPatch(`/api/thought-groups/${gr.id}`, { x: Math.round(gr.x), y: Math.round(gr.y) });
      } else if (g?.kind === "plate-resize") {
        const gr = groups.find((x) => x.id === g.id);
        if (gr) apiPatch(`/api/thought-groups/${gr.id}`, { w: Math.round(gr.w), h: Math.round(gr.h) });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [notes, groups, screenToWorldDelta]);

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
    // Place the new plate centered in the current viewport.
    const rect = viewportRef.current?.getBoundingClientRect();
    const cx = rect ? (rect.width / 2 - view.tx) / view.scale : 0;
    const cy = rect ? (rect.height / 2 - view.ty) / view.scale : 0;
    const res = await apiPost<{ group: ThoughtGroup }>("/api/thought-groups", { title: "New Group", x: Math.round(cx - 180), y: Math.round(cy - 130) });
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

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden select-none rounded-lg border border-border">
      {/* Toolbar */}
      <div className="absolute left-4 top-4 z-30 flex items-center gap-2">
        <button onClick={createNote} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
          <Plus className="h-4 w-4" /> Note
        </button>
        <button onClick={newGroup} className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm shadow-sm hover:bg-accent/50">
          <FolderPlus className="h-4 w-4" /> Group
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
          {/* Group plates (real rectangles; behind notes). Drag the header to
              move, the corner to resize; drop a note inside to add it. */}
          {groups.map((g) => (
            <div key={g.id} className="group/plate absolute rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/20" style={{ left: g.x, top: g.y, width: g.w, height: g.h, zIndex: 0 }}>
              {/* Header / move handle */}
              <div onPointerDown={(e) => onPlatePointerDown(e, g)} className="absolute -top-7 left-0 right-0 flex cursor-move items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                  <Users className="h-3 w-3 shrink-0" />
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
                    <span className="cursor-text" onDoubleClick={() => { setEditingGroupId(g.id); setGroupTitle(g.title); }} title="Double-click to rename">{g.title}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/plate:opacity-100">
                  <CopyId id={g.id} />
                  <button onPointerDown={(e) => e.stopPropagation()} onClick={() => ungroup(g.id)} className="rounded bg-muted/80 p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground" title="Delete group (notes stay)"><X className="h-3 w-3" /></button>
                </div>
              </div>
              {/* Resize handle */}
              <div onPointerDown={(e) => onPlateResizePointerDown(e, g)} className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize rounded-br-xl border-b-2 border-r-2 border-muted-foreground/40 opacity-0 transition-opacity group-hover/plate:opacity-100" />
            </div>
          ))}

          {/* Notes */}
          {notes.map((n) => (
            <div
              key={n.id}
              onPointerDown={(e) => onNotePointerDown(e, n)}
              className={`group absolute rounded-lg border shadow-sm ${noteClass(n.color)} ${n.pinned ? "ring-2 ring-offset-1 ring-amber-400/70" : ""}`}
              style={{ left: n.x, top: n.y, width: n.w ?? NOTE_W, minHeight: 80, zIndex: (n.zIndex || 1) + 1 }}
            >
              {/* Hover toolbar. Wrapped with bottom padding that overlaps the
                  note's top edge so moving the cursor up to the toolbar never
                  crosses a dead zone (which would drop group-hover and hide it). */}
              <div className="absolute -top-9 right-0 hidden pb-2 group-hover:block">
                <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm">
                  <IconBtn title="Color" onClick={() => setPaletteFor(paletteFor === n.id ? null : n.id)}><Palette className="h-3.5 w-3.5" /></IconBtn>
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

              {/* Copyable note id (bottom-right, on hover) — for referencing a
                  specific note to the assistant ("look at th-…"). */}
              {editingId !== n.id && (
                <div className="absolute bottom-1 right-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <CopyId id={n.id} />
                </div>
              )}
            </div>
          ))}
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
