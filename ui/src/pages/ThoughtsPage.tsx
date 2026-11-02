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
 * With the minimap on, a row of **group chips** runs along the bottom (most
 * notes first); clicking one centers that group in the view.
 * Deliberately excludes the standalone Thoughts product's cosmetic surface
 * (100+ backgrounds, skins, palettes). Talks to /api/thoughts. Two-state
 * lifecycle (active⇄archived); direct delete. See docs/ARCHITECTURE.md.
 *
 * **Two views of one board.** The canvas (above) and a **list view**
 * (components/thoughts/ThoughtsList: folders on the left, the note on the
 * right). This page owns the data and every mutation, and switches between
 * them (remembered in `localStorage`); the selection carries across a switch.
 * Both hang under one shared toolbar, so + Note and the view switch stay put.
 *
 * Split by concern: the camera is hooks/useCanvasView, pointer gestures
 * hooks/useCanvasGestures, the toolbar / plates / note cards / minimap + group
 * chips / archived drawer are components/thoughts/{ThoughtsToolbar, GroupPlate,
 * CanvasNote, Minimap, ArchivedDrawer}, and the layout math (Tidy, new-group
 * wrap, marquee, zoom) is pure in lib/thoughtLayout. This page keeps the data,
 * the mutations, selection, the `?note=` link, and the keyboard shortcuts.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi, apiPost, apiPatch, apiDelete } from "@/hooks/useApi";
import { NoteDialog } from "@/components/thoughts/NoteDialog";
import { ThoughtsList } from "@/components/thoughts/ThoughtsList";
import { CopyId } from "@/components/thoughts/CopyId";
import { ThoughtsToolbar } from "@/components/thoughts/ThoughtsToolbar";
import { GroupPlate } from "@/components/thoughts/GroupPlate";
import { CanvasNote } from "@/components/thoughts/CanvasNote";
import { Minimap, GroupChips } from "@/components/thoughts/Minimap";
import { ArchivedDrawer } from "@/components/thoughts/ArchivedDrawer";
import type { ViewMode } from "@/components/thoughts/ViewSwitch";
import type { TriageBadge as TriageBadgeState } from "@/lib/triage";
import { THOUGHT_COLORS, nextRotatedColor } from "@/lib/thoughtColors";
import { NOTE_W, NOTE_H, centerViewOn, plateRect } from "@/lib/thoughtGeometry";
import { nextPlateOpacity, tidyLayout, wrapNotes } from "@/lib/thoughtLayout";
import { useCanvasView } from "@/hooks/useCanvasView";
import { useCanvasGestures } from "@/hooks/useCanvasGestures";
import { toggleTaskMarker } from "@/lib/taskMarkers";
import { placeForGroupChange, slotBelowAll, slotInPlate } from "@/lib/thoughtList";
import type { Thought, ThoughtGroup } from "@shared/types";
import type { ThoughtsResponse } from "@shared/protocol";

type ThoughtsData = ThoughtsResponse;

/** localStorage key for the minimap on/off choice (default on). */
const MINIMAP_KEY = "mpt.thoughts.minimap";
/** localStorage key for the chosen view: "canvas" (default) or "list". */
const VIEW_KEY = "mpt.thoughts.view";

export function ThoughtsPage() {
  const { data, refetch } = useApi<ThoughtsData>("/api/thoughts?status=active");
  // Auto-triage badges, keyed by note id (docs/DESIGN.md "Auto Triage"). One call
  // for the whole board; only notes with something to show are in it.
  const { data: triageData } = useApi<{ badges: Record<string, TriageBadgeState> }>(
    "/api/triage/badges", [], { pollInterval: 60_000 },
  );
  const badges = triageData?.badges ?? {};
  const { data: archivedData, refetch: refetchArchived } = useApi<ThoughtsData>("/api/thoughts?status=archived");

  const [notes, setNotes] = useState<Thought[]>([]);
  const [groups, setGroups] = useState<ThoughtGroup[]>([]);
  const [seed, setSeed] = useState<ThoughtsData | null>(null);
  if (data && data !== seed) { setSeed(data); setNotes(data.thoughts); setGroups(data.groups); }

  // Canvas or list (remembered). The list has its own selection: the note shown
  // in its pane, and the one just created there (which opens in Edit).
  const [mode, setModeState] = useState<ViewMode>(() => (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "canvas"));
  // The canvas camera: pan/zoom, viewport size, wheel, button zoom.
  const { view, setView, viewportRef, vpSize, screenToWorldDelta, screenToWorld, zoomBy, resetView } = useCanvasView(mode);
  const [searchParams] = useSearchParams();
  const [listSelectedId, setListSelectedId] = useState<string | null>(null);
  const [listEditingId, setListEditingId] = useState<string | null>(null);
  // A folder the list should put into rename mode (one just created from the toolbar).
  const [listRenameId, setListRenameId] = useState<string | null>(null);
  // The note open in the large view/edit dialog (and whether to start in Edit).
  const [openId, setOpenId] = useState<string | null>(null);
  const [openEditing, setOpenEditing] = useState(false);
  const [platePaintFor, setPlatePaintFor] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupTitle, setGroupTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Select mode: when on, a plain drag on empty canvas marquee-selects instead
  // of panning (toggled by the toolbar lasso or the `S` key). Shift+drag always
  // marquees regardless, so panning stays available.
  const [selectMode, setSelectMode] = useState(false);
  // Minimap: on by default, and the choice sticks (M / the Map button).
  const [minimapOn, setMinimapOnState] = useState(() => localStorage.getItem(MINIMAP_KEY) !== "0");
  const toggleMinimap = useCallback(() => {
    setMinimapOnState((on) => {
      try { localStorage.setItem(MINIMAP_KEY, on ? "0" : "1"); } catch { /* private mode */ }
      return !on;
    });
  }, []);
  // Pointer gestures on the canvas: pan, marquee, note drag (with drop-to-group),
  // plate move/resize — each persisted when it ends.
  const { marquee, dragIds, dropHover, onCanvasPointerDown, onNotePointerDown, onPlatePointerDown, onPlateResizePointerDown } = useCanvasGestures({
    notes, setNotes, groups, setGroups, view, setView, screenToWorld, screenToWorldDelta,
    selected, setSelected, selectMode, onCanvasPress: () => setPlatePaintFor(null),
  });

  // Open a note in the large view/edit dialog.
  const openNote = useCallback((id: string, editing = false) => { setOpenId(id); setOpenEditing(editing); }, []);

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
    // Bump updatedAt locally too (the server does the same for a content change),
    // so the list view re-sorts the edited note to the top straight away.
    const updatedAt = new Date().toISOString();
    setNotes((ns) => ns.map((n) => (n.id === id && n.content !== content ? { ...n, content, updatedAt } : n)));
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
  const archiveSelected = useCallback(async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setSelected(new Set());
    await Promise.all(ids.map((id) => apiPost(`/api/thoughts/${id}/archive`, {}).catch(() => {})));
    refetch(); refetchArchived();
  }, [selected, refetch, refetchArchived]);
  const colorSelected = useCallback(async (color: string) => {
    const ids = [...selected];
    if (!ids.length) return;
    setNotes((ns) => ns.map((n) => (selected.has(n.id) ? { ...n, color } : n)));
    await Promise.all(ids.map((id) => apiPatch(`/api/thoughts/${id}`, { color }).catch(() => {})));
  }, [selected]);

  // Toggle a checklist item inside a note (rewrites the markdown, persists).
  const toggleTask = async (n: Pick<Thought, "id" | "content">, index: number) => {
    const content = toggleTaskMarker(n.content, index);
    if (content === n.content) return;
    setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, content } : x)));
    await apiPatch(`/api/thoughts/${n.id}`, { content });
  };

  const newGroup = useCallback(async () => {
    const memberIds = [...selected];
    let x: number, y: number, w: number | undefined, h: number | undefined;
    if (memberIds.length) {
      // Wrap the selected notes' bounding box so the plate encapsulates them.
      ({ x, y, w, h } = wrapNotes(notes.filter((n) => selected.has(n.id))));
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
  }, [selected, notes, view, viewportRef, refetch]);
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
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    const next = nextPlateOpacity(g.plateOpacity);
    setGroups((gs) => gs.map((x) => (x.id === id ? { ...x, plateOpacity: next } : x)));
    await apiPatch(`/api/thought-groups/${id}`, { plateOpacity: next });
  };

  // Tidy: lay every group's notes out in a grid and shrink the plate to fit;
  // grid the ungrouped notes in place (lib/thoughtLayout tidyLayout). One
  // batched note-position write + a geometry update per group.
  const tidy = async () => {
    const { moves, groupUpdates } = tidyLayout(notes, groups);
    if (!moves.length) return;
    const byId = new Map(moves.map((m) => [m.id, m]));
    setNotes((ns) => ns.map((n) => { const m = byId.get(n.id); return m ? { ...n, x: m.x, y: m.y } : n; }));
    const guById = new Map(groupUpdates.map((u) => [u.id, u]));
    setGroups((gs) => gs.map((g) => { const u = guById.get(g.id); return u ? { ...g, x: u.x, y: u.y, w: u.w, h: u.h } : g; }));
    await apiPost("/api/thoughts/positions", { moves });
    for (const u of groupUpdates) apiPatch(`/api/thought-groups/${u.id}`, { x: u.x, y: u.y, w: u.w, h: u.h });
  };

  // Membership is explicit — a drop on a plate (see the drag handler), a Group
  // picker, or a folder drop in the list — never inferred from where a note
  // happens to sit. null removes it from a group. Off the canvas the note also
  // moves to where it now belongs (into its plate, or out from under one), so
  // the canvas agrees with the list (lib/thoughtList placeForGroupChange).
  const assignGroup = async (id: string, groupId: string | null) => {
    const n = notes.find((x) => x.id === id);
    const pos = n ? placeForGroupChange(n, groupId, notes, groups) : null;
    setNotes((ns) => ns.map((x) => (x.id === id ? { ...x, groupId, ...(pos ?? {}) } : x)));
    await apiPatch(`/api/thoughts/${id}`, { groupId, ...(pos ?? {}) });
  };

  // ─── List view ───────────────────────────────────────────────────
  // `?note=<id>` selects that note on arrival (and centers it on the canvas), so a
  // link *to a note* works — the triage page's "Edit note" is one.
  //
  // Adjusted during render rather than in an effect (React's "adjusting state when
  // a prop changes"): the notes arrive asynchronously, and the re-render they cause
  // is what re-checks this. Guarded by the id it has already handled, so it fires
  // once per link and never fights the user's own selection.
  const noteParam = searchParams.get("note");
  const [focusedParam, setFocusedParam] = useState<string | null>(null);
  const paramTarget = noteParam && noteParam !== focusedParam
    ? notes.find((x) => x.id === noteParam)
    : undefined;
  if (paramTarget) {
    setFocusedParam(noteParam);
    setListSelectedId(paramTarget.id);
    setSelected(new Set([paramTarget.id]));
    if (mode === "canvas") {
      const box = { left: paramTarget.x, top: paramTarget.y, right: paramTarget.x + NOTE_W, bottom: paramTarget.y + NOTE_H };
      setView((v) => ({ ...v, ...centerViewOn(box, vpSize.w, vpSize.h, v.scale) }));
    }
  }

  // Switching carries the selection across: a single canvas selection becomes
  // the list's note, and the list's note is selected and centered on the canvas.
  const setMode = (next: ViewMode) => {
    if (next === mode) return;
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* private mode */ }
    if (next === "list") {
      if (selected.size === 1) setListSelectedId([...selected][0]!);
    } else {
      const n = notes.find((x) => x.id === listSelectedId);
      if (n) {
        setSelected(new Set([n.id]));
        setView((v) => ({ ...v, ...centerViewOn({ left: n.x, top: n.y, right: n.x + NOTE_W, bottom: n.y + NOTE_H }, vpSize.w, vpSize.h, v.scale) }));
      }
    }
    setModeState(next);
  };
  // New notes and folders made in the list still need a canvas spot: a note
  // goes into a free slot in its folder's plate (or below everything), a folder
  // below everything.
  const createNoteInList = async (groupId: string | null) => {
    const g = groupId ? groups.find((x) => x.id === groupId) : undefined;
    const pos = g ? slotInPlate(g, notes) : slotBelowAll(notes, groups);
    const res = await apiPost<{ thought: Thought }>("/api/thoughts", { content: "", color: nextRotatedColor(notes), ...pos, ...(g ? { groupId: g.id } : {}) });
    await refetch();
    if (res.thought) { setListEditingId(res.thought.id); setListSelectedId(res.thought.id); }
  };
  const createGroupInList = async () => {
    const pos = slotBelowAll(notes, groups);
    const res = await apiPost<{ group: ThoughtGroup }>("/api/thought-groups", { title: "New Group", ...pos });
    await refetch();
    if (res.group) setListRenameId(res.group.id);
  };
  const renameGroup = async (id: string, title: string) => {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, title } : g)));
    await apiPatch(`/api/thought-groups/${id}`, { title });
  };
  const groupTitleById = (id: string) => groups.find((g) => g.id === id)?.title ?? "group";

  // ─── Keyboard shortcuts ──────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never hijack keys while typing in a note/title editor.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // The canvas's shortcuts; the list view handles its own keys. The
      // contenteditable check covers the big editor (CodeMirror).
      if (mode !== "canvas" || openId || editingGroupId || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;

      if (e.key === "Escape") { setSelected(new Set()); setPlatePaintFor(null); return; }
      // Zoom (with modifier).
      if ((e.metaKey || e.ctrlKey) && e.key === "0") { e.preventDefault(); resetView(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomBy(1.2); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); zoomBy(1 / 1.2); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "s" || e.key === "S") { setSelectMode((m) => !m); return; }
      if (e.key === "m" || e.key === "M") { toggleMinimap(); return; }
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
  }, [mode, openId, editingGroupId, selected, zoomBy, resetView, archiveSelected, colorSelected, newGroup, openNote, toggleMinimap]);

  // ─── The shared toolbar ───────────────────────────────────────────
  // One row above both views: + Note first and the view switch last never
  // move when you switch; what's between them depends on the view.
  const listFolder = (() => {
    const gid = notes.find((n) => n.id === listSelectedId)?.groupId;
    return gid && groups.some((g) => g.id === gid) ? gid : null;
  })();

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border">
      {/* The page's heading for screen readers (the canvas has no room for a visible one). */}
      <h1 className="sr-only">Thoughts</h1>
      <ThoughtsToolbar
        mode={mode}
        onModeChange={setMode}
        onNewNote={mode === "list" ? () => createNoteInList(listFolder) : createNote}
        newNoteTitle={mode === "list" && listFolder ? `New note in ${groups.find((g) => g.id === listFolder)?.title}` : "New note"}
        selectedCount={selected.size}
        onNewGroup={newGroup}
        onTidy={tidy}
        selectMode={selectMode}
        onToggleSelectMode={() => setSelectMode((m) => !m)}
        minimapOn={minimapOn}
        onToggleMinimap={toggleMinimap}
        onNewFolder={createGroupInList}
        scale={view.scale}
        onZoom={zoomBy}
        onResetView={resetView}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
        archivedCount={archivedData?.thoughts.length}
      />

      {/* The view (and the overlays that sit over either: dialog, archived drawer) */}
      <div className={`relative min-h-0 flex-1 ${mode === "canvas" ? "select-none" : ""}`}>
      {mode === "list" ? (
        <ThoughtsList
          notes={notes}
          groups={groups}
          selectedId={listSelectedId}
          onSelect={setListSelectedId}
          editingId={listEditingId}
          renameGroupId={listRenameId}
          onRenameGroup={renameGroup}
          onDeleteGroup={ungroup}
          onMoveToGroup={assignGroup}
          onSave={saveContent}
          onColor={setColor}
          onPin={setPinned}
          onArchive={archive}
          onDelete={remove}
          badges={badges}
        />
      ) : (<>
      {/* Canvas viewport */}
      <div
        ref={viewportRef}
        onPointerDown={onCanvasPointerDown}
        className={`relative h-full w-full overflow-hidden bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:24px_24px] ${selectMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      >
        {/* Transformed world layer */}
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}>
          {/* Group plates (named, movable/resizable rectangles; behind notes).
              Membership is set by a drop, a Group picker, or the list — not by
              position; the plate carries its member notes when you drag it. */}
          {groups.map((g) => (
            <GroupPlate
              key={g.id}
              group={g}
              notes={notes}
              dragIds={dragIds}
              isDropTarget={dropHover === g.id}
              rename={editingGroupId === g.id ? {
                title: groupTitle,
                onChange: setGroupTitle,
                onSave: () => saveGroupTitle(g.id),
                onCancel: () => setEditingGroupId(null),
              } : null}
              onStartRename={() => { setEditingGroupId(g.id); setGroupTitle(g.title); }}
              paintOpen={platePaintFor === g.id}
              onTogglePaint={() => setPlatePaintFor(platePaintFor === g.id ? null : g.id)}
              onSetColor={(c) => setGroupColor(g.id, c)}
              onCycleOpacity={() => cyclePlateOpacity(g.id)}
              onDelete={() => ungroup(g.id)}
              onPointerDown={(e) => onPlatePointerDown(e, g)}
              onResizePointerDown={(e) => onPlateResizePointerDown(e, g)}
            />
          ))}

          {/* Notes — all one size (lib/thoughtGeometry). Click selects,
              double-click opens the large view/edit dialog, drag moves (and
              drops onto / off of group plates). */}
          {notes.map((n) => {
            const dragging = dragIds.has(n.id);
            // Dragging a member over open canvas: it'll leave its group on drop.
            const leaving = dragging && dropHover === "canvas" && n.groupId !== null;
            return (
              <CanvasNote
                key={n.id}
                note={n}
                selected={selected.has(n.id)}
                dragging={dragging}
                leaving={leaving}
                groupTitle={n.groupId ? groupTitleById(n.groupId) : ""}
                badge={badges[n.id]}
                onPointerDown={(e) => onNotePointerDown(e, n)}
                onOpen={() => openNote(n.id)}
                onToggleTask={(i) => toggleTask(n, i)}
              />
            );
          })}

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
      {minimapOn && <Minimap notes={notes} view={view} vpW={vpSize.w} vpH={vpSize.h} onRecenter={(wx, wy) => {
        const r = viewportRef.current?.getBoundingClientRect();
        const vpW = r?.width ?? 800, vpH = r?.height ?? 600;
        setView((v) => ({ ...v, tx: vpW / 2 - wx * v.scale, ty: vpH / 2 - wy * v.scale }));
      }} />}

      {/* Group chips beside the minimap (shown with it): click to center a group. */}
      {minimapOn && groups.length > 0 && <GroupChips groups={groups} notes={notes} onJump={(g) => {
        const r = viewportRef.current?.getBoundingClientRect();
        const vpW = r?.width ?? 800, vpH = r?.height ?? 600;
        setView((v) => ({ ...v, ...centerViewOn(plateRect(g, notes), vpW, vpH, v.scale) }));
      }} />}

      {notes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
          <p>Empty canvas — hit <span className="font-medium text-foreground">+ Note</span> to capture a thought.</p>
        </div>
      )}
      </>)}

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

      {showArchived && (
        <ArchivedDrawer
          notes={archivedData?.thoughts}
          onClose={() => setShowArchived(false)}
          onRestore={restore}
          onDelete={remove}
        />
      )}
      </div>
    </div>
  );
}
