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
import { Plus, Pin, PinOff, Trash2, Archive, ArchiveRestore, Users, X, FolderPlus, Palette } from "lucide-react";
import { useApi, apiPost, apiPatch, apiDelete } from "@/hooks/useApi";
import { MarkdownView } from "@/components/ui/markdown-view";
import { THOUGHT_COLORS, noteClass, dotClass } from "@/lib/thoughtColors";

interface Thought {
  id: string; content: string; color: string; status: "active" | "archived";
  x: number; y: number; w: number | null; h: number | null; zIndex: number;
  pinned: boolean; groupId: string | null; createdBy: string; createdAt: string; updatedAt: string;
}
interface ThoughtGroup { id: string; title: string; }
interface ThoughtsData { thoughts: Thought[]; groups: ThoughtGroup[]; }

const NOTE_W = 220;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;

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
  const [showArchived, setShowArchived] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  // Active gesture: pan (canvas) or drag (a note). Held in a ref so the
  // window move/up listeners always see fresh values without re-binding.
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; tx: number; ty: number }
    | { kind: "drag"; id: string; startX: number; startY: number; ox: number; oy: number; moved: boolean }
    | null
  >(null);

  // ─── World ⇄ screen ────────────────────────────────────────────────
  const screenToWorldDelta = useCallback((dx: number, dy: number) => ({ dx: dx / view.scale, dy: dy / view.scale }), [view.scale]);

  // ─── Pan (drag on empty canvas) ────────────────────────────────────
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setPaletteFor(null); setGroupMenuFor(null);
    gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty };
  };

  // ─── Note drag ─────────────────────────────────────────────────────
  const onNotePointerDown = (e: React.PointerEvent, note: Thought) => {
    if (e.button !== 0 || editingId === note.id) return;
    e.stopPropagation();
    gesture.current = { kind: "drag", id: note.id, startX: e.clientX, startY: e.clientY, ox: note.x, oy: note.y, moved: false };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (g.kind === "pan") {
        setView((v) => ({ ...v, tx: g.tx + (e.clientX - g.startX), ty: g.ty + (e.clientY - g.startY) }));
      } else {
        const { dx, dy } = screenToWorldDelta(e.clientX - g.startX, e.clientY - g.startY);
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) g.moved = true;
        setNotes((ns) => ns.map((n) => (n.id === g.id ? { ...n, x: g.ox + dx, y: g.oy + dy } : n)));
      }
    };
    const onUp = () => {
      const g = gesture.current;
      gesture.current = null;
      if (g?.kind === "drag" && g.moved) {
        const n = notes.find((x) => x.id === g.id);
        if (n) apiPost("/api/thoughts/positions", { moves: [{ id: n.id, x: Math.round(n.x), y: Math.round(n.y) }] });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [notes, screenToWorldDelta]);

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

  const newGroup = async () => {
    const title = prompt("Group name?")?.trim();
    if (!title) return;
    await apiPost("/api/thought-groups", { title });
    refetch();
  };
  const assignGroup = async (id: string, groupId: string | null) => {
    setGroupMenuFor(null);
    await apiPatch(`/api/thoughts/${id}`, { groupId });
    refetch();
  };
  const ungroup = async (groupId: string) => { await apiDelete(`/api/thought-groups/${groupId}`); refetch(); };

  // ─── Group plates (bounding box behind member notes) ───────────────
  const plates = groups
    .map((g) => {
      const members = notes.filter((n) => n.groupId === g.id);
      if (members.length === 0) return null;
      const pad = 16;
      const minX = Math.min(...members.map((m) => m.x)) - pad;
      const minY = Math.min(...members.map((m) => m.y)) - pad - 22; // room for the label
      const maxX = Math.max(...members.map((m) => m.x + (m.w ?? NOTE_W))) + pad;
      const maxY = Math.max(...members.map((m) => m.y + (m.h ?? 140))) + pad;
      return { group: g, minX, minY, w: maxX - minX, h: maxY - minY };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  return (
    <div className="relative h-[calc(100vh-3.5rem)] w-full overflow-hidden select-none">
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

      {/* Zoom readout / reset */}
      <button
        onClick={() => setView({ tx: 40, ty: 40, scale: 1 })}
        className="absolute right-4 top-4 z-30 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-sm hover:bg-accent/50"
        title="Reset view"
      >
        {Math.round(view.scale * 100)}%
      </button>

      {/* Canvas viewport */}
      <div
        ref={viewportRef}
        onPointerDown={onCanvasPointerDown}
        onWheel={onWheel}
        className="h-full w-full cursor-grab bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:24px_24px] active:cursor-grabbing"
      >
        {/* Transformed world layer */}
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}>
          {/* Group plates (behind notes) */}
          {plates.map((p) => (
            <div key={p.group.id} className="absolute rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/30" style={{ left: p.minX, top: p.minY, width: p.w, height: p.h, zIndex: 0 }}>
              <div className="absolute -top-0.5 left-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Users className="h-3 w-3" /> {p.group.title}
                <button onClick={() => ungroup(p.group.id)} className="ml-1 rounded p-0.5 hover:bg-accent/60" title="Ungroup"><X className="h-3 w-3" /></button>
              </div>
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
              {/* Hover toolbar */}
              <div className="absolute -top-8 right-0 hidden items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm group-hover:flex">
                <IconBtn title="Color" onClick={() => { setPaletteFor(paletteFor === n.id ? null : n.id); setGroupMenuFor(null); }}><Palette className="h-3.5 w-3.5" /></IconBtn>
                <IconBtn title="Group" onClick={() => { setGroupMenuFor(groupMenuFor === n.id ? null : n.id); setPaletteFor(null); }}><Users className="h-3.5 w-3.5" /></IconBtn>
                <IconBtn title={n.pinned ? "Unpin" : "Pin"} onClick={() => togglePin(n)}>{n.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</IconBtn>
                <IconBtn title="Archive" onClick={() => archive(n.id)}><Archive className="h-3.5 w-3.5" /></IconBtn>
                <IconBtn title="Delete" onClick={() => remove(n.id)}><Trash2 className="h-3.5 w-3.5" /></IconBtn>
              </div>

              {/* Palette popover */}
              {paletteFor === n.id && (
                <div className="absolute -top-8 left-0 z-40 flex gap-1 rounded-md border border-border bg-card p-1 shadow" onPointerDown={(e) => e.stopPropagation()}>
                  {THOUGHT_COLORS.map((c) => (
                    <button key={c} onClick={() => setColor(n.id, c)} className={`h-4 w-4 rounded-full ${dotClass(c)} ${n.color === c ? "ring-2 ring-foreground/50" : ""}`} title={c} />
                  ))}
                </div>
              )}

              {/* Group menu popover */}
              {groupMenuFor === n.id && (
                <div className="absolute -top-8 left-0 z-40 w-44 rounded-md border border-border bg-card p-1 text-sm shadow" onPointerDown={(e) => e.stopPropagation()}>
                  {groups.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No groups yet</div>}
                  {groups.map((g) => (
                    <button key={g.id} onClick={() => assignGroup(n.id, g.id)} className={`block w-full rounded px-2 py-1 text-left hover:bg-accent/60 ${n.groupId === g.id ? "font-medium" : ""}`}>{g.title}</button>
                  ))}
                  {n.groupId && <button onClick={() => assignGroup(n.id, null)} className="mt-1 block w-full rounded px-2 py-1 text-left text-muted-foreground hover:bg-accent/60">Remove from group</button>}
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
                    ? <MarkdownView content={n.content} />
                    : <span className="text-sm text-muted-foreground/60">Empty note — double-click to edit</span>}
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
