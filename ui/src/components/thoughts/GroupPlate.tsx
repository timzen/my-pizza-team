/**
 * GroupPlate — One group's plate on the Thoughts canvas: a named, movable,
 * resizable rectangle behind its notes, with a header (title — double-click to
 * rename — color/opacity popover, copy-id, delete) and a corner resize grip.
 *
 * The plate wraps its members — minus any being dragged, so a member can be
 * dragged out (lib/thoughtGeometry `plateRect`). While it's the drop target it
 * highlights and grows around the dragged note(s) (`previewRect`), so you see
 * the group take the note before you let go. Membership itself is set by a
 * drop, a Group picker, or the list — never by position. The page owns the
 * gestures and mutations; this only renders and reports.
 */

import type { PointerEvent } from "react";
import { SquareStack, X, Palette } from "lucide-react";
import { CopyId } from "@/components/thoughts/CopyId";
import { THOUGHT_COLORS, dotClass, plateTintStyle } from "@/lib/thoughtColors";
import { plateRect, previewRect } from "@/lib/thoughtGeometry";
import type { Thought, ThoughtGroup } from "@shared/types";

/** One plate. `rename` is set while its title is being edited (the draft title and its handlers). */
export function GroupPlate({
  group: g, notes, dragIds, isDropTarget, rename, onStartRename, paintOpen, onTogglePaint,
  onSetColor, onCycleOpacity, onDelete, onPointerDown, onResizePointerDown,
}: {
  group: ThoughtGroup;
  notes: Thought[];
  /** The notes being dragged (they don't count toward, or stretch, the plate). */
  dragIds: ReadonlySet<string>;
  /** This plate would receive the dragged note(s) on drop. */
  isDropTarget: boolean;
  rename: { title: string; onChange: (title: string) => void; onSave: () => void; onCancel: () => void } | null;
  onStartRename: () => void;
  paintOpen: boolean;
  onTogglePaint: () => void;
  onSetColor: (color: string | null) => void;
  onCycleOpacity: () => void;
  onDelete: () => void;
  onPointerDown: (e: PointerEvent) => void;
  onResizePointerDown: (e: PointerEvent) => void;
}) {
  const memberCount = notes.filter((n) => n.groupId === g.id && !dragIds.has(n.id)).length;
  const { left, top, right, bottom } = isDropTarget ? previewRect(g, notes, dragIds) : plateRect(g, notes, dragIds);
  const rect = { left, top, width: right - left, height: bottom - top };
  return (
    <div onPointerDown={onPointerDown} className={`group/plate absolute cursor-move rounded-xl border-2 border-dashed bg-muted/20 ${dragIds.size ? "transition-[left,top,width,height,background-color,border-color] duration-150" : "transition-colors"} ${isDropTarget ? "border-primary bg-primary/10" : "border-muted-foreground/30"}`} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, zIndex: 0, ...plateTintStyle(g.groupColor, g.plateOpacity) }}>
      {/* Header (title + controls). Bubbles to the plate for moving;
          the input/buttons stop propagation for their own actions. */}
      <div className="absolute -top-7 left-0 right-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          <SquareStack className="h-3 w-3 shrink-0" />
          {rename ? (
            <input
              autoFocus
              value={rename.title}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => rename.onChange(e.target.value)}
              onBlur={rename.onSave}
              onKeyDown={(e) => { if (e.key === "Enter") rename.onSave(); if (e.key === "Escape") rename.onCancel(); }}
              className="w-36 bg-transparent outline-none"
            />
          ) : (
            <span className="cursor-text" onDoubleClick={onStartRename} title="Double-click to rename">{g.title}{memberCount ? ` (${memberCount})` : ""}</span>
          )}
        </div>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/plate:opacity-100">
          <button onPointerDown={(e) => e.stopPropagation()} onClick={onTogglePaint} className="rounded bg-muted/80 p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground" title="Plate color"><Palette className="h-3 w-3" /></button>
          <CopyId id={g.id} />
          <button onPointerDown={(e) => e.stopPropagation()} onClick={onDelete} className="rounded bg-muted/80 p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground" title="Delete group (notes stay)"><X className="h-3 w-3" /></button>
        </div>
      </div>
      {/* Plate color/opacity popover */}
      {paintOpen && (
        <div className="absolute -top-9 right-0 z-40 flex items-center gap-1 rounded-md border border-border bg-card p-1 shadow" onPointerDown={(e) => e.stopPropagation()}>
          {THOUGHT_COLORS.map((c) => (
            <button key={c} onClick={() => onSetColor(c)} className={`h-4 w-4 rounded-full ${dotClass(c)} ${g.groupColor === c ? "ring-2 ring-foreground/50" : ""}`} title={c} />
          ))}
          <button onClick={() => onSetColor(null)} className="rounded p-0.5 text-muted-foreground hover:bg-accent/60" title="No tint"><X className="h-3.5 w-3.5" /></button>
          <button onClick={onCycleOpacity} className="ml-1 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/60" title="Cycle plate opacity">{g.plateOpacity}</button>
        </div>
      )}
      {memberCount === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/50">Empty group — drag notes here</div>
      )}
      {/* Resize handle: a 28px hit box straddling the corner (easy to
          grab), with a visible grip that's always faintly there and
          firms up on hover. */}
      <div
        onPointerDown={onResizePointerDown}
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
  );
}
