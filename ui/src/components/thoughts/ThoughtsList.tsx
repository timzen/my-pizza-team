/**
 * ThoughtsList — The Thoughts **list view**: a sidebar of notes on the left,
 * grouped into folders (the canvas's groups), and the selected note in full on
 * the right — like Apple Notes or OneNote. An alternative to the canvas over the
 * same board; ThoughtsPage owns the data and switches between the two.
 *
 *  - **Folders** are the groups, alphabetical, each collapsible (remembered in
 *    `localStorage`), with notes in no group listed after them under **Notes**.
 *    Within a folder: pinned first, then most recently edited.
 *  - **Select** a note to read or write it in the pane (NoteEditor, autosaving).
 *    ↑/↓ step through the visible notes.
 *  - **Move** a note by dragging its row onto a folder (or onto **Notes** to take
 *    it out of every group), or with the pane's Group picker.
 *  - **+ Note** and **Folder** live in the page's shared toolbar (so both views
 *    keep their controls in the same places); a new note goes in the selected
 *    note's folder, and a new folder arrives here in rename mode
 *    (`renameGroupId`). Double-click a folder to rename it.
 *  - **Search** filters by text; matching folders open regardless of collapse.
 *
 * The rules (titles, ordering, search, keyboard order) are pure, in
 * lib/thoughtList.ts. See docs/DESIGN.md "Thoughts".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Pin, Search, X } from "lucide-react";
import { NoteEditor } from "@/components/thoughts/NoteEditor";
import { CopyId } from "@/components/thoughts/CopyId";
import { dotClass } from "@/lib/thoughtColors";
import { buildThoughtTree, neighbourAfterRemoval, noteSnippet, noteTitle, visibleOrder } from "@/lib/thoughtList";

export interface ListThought {
  id: string; content: string; color: string; pinned: boolean; groupId: string | null;
  x: number; y: number; updatedAt: string;
}
export interface ListThoughtGroup {
  id: string; title: string; x: number; y: number; w: number; h: number; groupColor: string | null;
}

export interface ThoughtsListProps {
  notes: ListThought[];
  groups: ListThoughtGroup[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A note to open straight into Edit (one just created). */
  editingId: string | null;
  /** A folder to start renaming (one just created); each new id triggers it once. */
  renameGroupId: string | null;
  onRenameGroup: (id: string, title: string) => void;
  onDeleteGroup: (id: string) => void;
  onMoveToGroup: (id: string, groupId: string | null) => void;
  onSave: (id: string, content: string) => void;
  onColor: (id: string, color: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}

const COLLAPSED_KEY = "mpt.thoughts.collapsedFolders";
/** Drag payload type for a note row (the value is the note id). */
const DRAG_TYPE = "application/x-mpt-thought";
/** Drop target id for "no group". */
const LOOSE = "__loose__";

function readCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]") as string[]); } catch { return new Set(); }
}

/** "14:32" today, "Mon" this week, "Sep 3" this year, else "Sep 3, 2025". */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

export function ThoughtsList(props: ThoughtsListProps) {
  const { notes, groups, selectedId, onSelect, editingId, renameGroupId } = props;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsedState] = useState<Set<string>>(readCollapsed);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // A rename request from the toolbar's Folder button, handled once per id.
  // Seeded with the current value so remounting (a view switch) doesn't repeat it.
  const [seenRename, setSeenRename] = useState(renameGroupId);
  // Waits until the new group has arrived in `groups` before counting it as seen.
  if (renameGroupId !== seenRename) {
    const g = groups.find((x) => x.id === renameGroupId);
    if (g || renameGroupId === null) {
      setSeenRename(renameGroupId);
      if (g) setRenaming({ id: g.id, title: g.title });
    }
  }
  const [dropOver, setDropOver] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const searching = query.trim() !== "";
  const tree = useMemo(() => buildThoughtTree(notes, groups, query), [notes, groups, query]);
  const order = useMemo(() => visibleOrder(tree, collapsed, searching), [tree, collapsed, searching]);
  const selected = notes.find((n) => n.id === selectedId) ?? null;

  const setCollapsed = (next: Set<string>) => {
    setCollapsedState(next);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
  };
  const toggleFolder = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCollapsed(next);
  };

  // Nothing selected (first visit, or the selection went away): take the first note.
  useEffect(() => {
    if (!selected && order[0]) onSelect(order[0].id);
  }, [selected, order, onSelect]);

  // A newly selected note inside a collapsed folder (e.g. carried over from the
  // canvas) opens its folder, so the selection is always visible. Adjusted
  // during render, on a selection change only — collapsing the folder
  // afterwards is allowed. Not persisted: the next manual toggle saves it.
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  if (selectedId !== revealedFor) {
    setRevealedFor(selectedId);
    const gid = notes.find((n) => n.id === selectedId)?.groupId;
    if (gid && collapsed.has(gid)) {
      const next = new Set(collapsed);
      next.delete(gid);
      setCollapsedState(next);
    }
  }
  useEffect(() => {
    if (selectedId) listRef.current?.querySelector(`[data-note-row="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // ↑/↓ step through the visible notes — unless you're typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (document.querySelector("[role=dialog]")) return;
      if (!order.length) return;
      e.preventDefault();
      const i = order.findIndex((n) => n.id === selectedId);
      const next = e.key === "ArrowDown" ? Math.min(order.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      onSelect(order[next]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selectedId, onSelect]);

  const commitRename = () => {
    if (!renaming) return;
    props.onRenameGroup(renaming.id, renaming.title.trim() || "New Group");
    setRenaming(null);
  };
  /** Archive/delete move the selection on first, so the pane never goes blank. */
  const removing = (id: string, act: (id: string) => void) => {
    if (id === selectedId) onSelect(neighbourAfterRemoval(order, id));
    act(id);
  };

  // ─── Drag a row onto a folder ─────────────────────────────────────
  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropOver !== target) setDropOver(target);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Only when leaving the target itself, not moving between its children.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver((d) => (d === target ? null : d));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropOver(null);
      const id = e.dataTransfer.getData(DRAG_TYPE);
      const note = notes.find((n) => n.id === id);
      const groupId = target === LOOSE ? null : target;
      if (note && note.groupId !== groupId) props.onMoveToGroup(id, groupId);
    },
  });

  const row = (n: ListThought, indent: boolean) => {
    const title = noteTitle(n.content);
    const isSel = n.id === selectedId;
    return (
      <button
        key={n.id}
        type="button"
        data-note-row={n.id}
        draggable
        onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, n.id); e.dataTransfer.effectAllowed = "move"; }}
        onClick={() => onSelect(n.id)}
        className={`flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left ${indent ? "pl-7" : "pl-2"} ${isSel ? "bg-primary/15" : "hover:bg-accent/50"}`}
      >
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass(n.color)}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className={`truncate text-sm ${title ? "font-medium" : "italic text-muted-foreground"}`}>{title || "Empty note"}</span>
            {n.pinned && <Pin className="h-3 w-3 shrink-0 text-amber-500" aria-label="Pinned" />}
          </span>
          <span className="flex gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{shortDate(n.updatedAt)}</span>
            <span className="truncate">{noteSnippet(n.content)}</span>
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ─── Sidebar ─────────────────────────────────────────────── */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-muted/20">
        <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
              placeholder="Search"
              className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-6 text-sm outline-none focus:border-primary"
            />
            {searching && (
              <button onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" title="Clear search">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {tree.folders.map(({ group: g, notes: members }) => {
            const open = searching || !collapsed.has(g.id);
            return (
              <div key={g.id} {...dropProps(g.id)} className={`mb-0.5 rounded-md ${dropOver === g.id ? "bg-primary/10 ring-1 ring-primary" : ""}`}>
                <div className="group/folder flex items-center gap-1 rounded-md px-1 py-1 hover:bg-accent/40">
                  <button onClick={() => toggleFolder(g.id)} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title={open ? "Collapse" : "Expand"} disabled={searching}>
                    {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <span className={`h-2 w-2 shrink-0 rounded-sm ${g.groupColor ? dotClass(g.groupColor) : "bg-muted-foreground/40"}`} />
                  {renaming?.id === g.id ? (
                    <input
                      autoFocus
                      value={renaming.title}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setRenaming({ id: g.id, title: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
                      className="min-w-0 flex-1 rounded border border-primary bg-background px-1 text-sm font-semibold outline-none"
                    />
                  ) : (
                    <span
                      className="min-w-0 flex-1 cursor-default truncate text-sm font-semibold"
                      onClick={() => toggleFolder(g.id)}
                      onDoubleClick={() => setRenaming({ id: g.id, title: g.title })}
                      title="Double-click to rename"
                    >
                      {g.title}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">{members.length}</span>
                  <button
                    onClick={() => props.onDeleteGroup(g.id)}
                    className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover/folder:opacity-100"
                    title="Delete folder (its notes stay, ungrouped)"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {open && (members.length
                  ? members.map((n) => row(n, true))
                  : <p className="py-1 pl-8 text-xs text-muted-foreground/70">Empty — drag notes here</p>)}
              </div>
            );
          })}

          {/* Notes in no group. Its header is also the drop target for "take it out of its folder". */}
          {(tree.folders.length > 0 || tree.loose.length > 0) && (
            <div {...dropProps(LOOSE)} className={`rounded-md ${dropOver === LOOSE ? "bg-primary/10 ring-1 ring-primary" : ""}`}>
              {tree.folders.length > 0 && (
                <div className="px-2 pb-0.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</div>
              )}
              {tree.loose.map((n) => row(n, false))}
              {tree.loose.length === 0 && tree.folders.length > 0 && !searching && (
                <p className="py-1 pl-2 text-xs text-muted-foreground/70">Drag a note here to take it out of its folder</p>
              )}
            </div>
          )}

          {searching && order.length === 0 && <p className="p-3 text-sm text-muted-foreground">No notes match “{query.trim()}”.</p>}
          {!searching && notes.length === 0 && <p className="p-3 text-sm text-muted-foreground">No notes yet.</p>}
        </div>
      </div>

      {/* ─── The selected note ───────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {selected ? (
            <NoteEditor
              key={selected.id}
              note={selected}
              groups={[...groups].sort((a, b) => a.title.localeCompare(b.title))}
              startEditing={selected.id === editingId}
              onSave={props.onSave}
              onColor={props.onColor}
              onPin={props.onPin}
              onGroup={props.onMoveToGroup}
              onArchive={(id) => removing(id, props.onArchive)}
              onDelete={(id) => removing(id, props.onDelete)}
              onToggleTask={props.onSave}
              idChip={<CopyId id={selected.id} />}
              groupHint="or drag it onto a folder in the list"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {notes.length ? "Select a note" : "Nothing here yet — + Note to capture a thought"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
