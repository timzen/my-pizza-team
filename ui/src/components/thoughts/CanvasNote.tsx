/**
 * CanvasNote — One note's card on the Thoughts canvas. All cards are one size
 * (lib/thoughtGeometry NOTE_W × NOTE_H): the body is clipped with a soft fade
 * (checklists stay clickable), with an Open button, the auto-triage badge, the
 * group chip, and a copy-id chip. Click selects, double-click opens the large
 * view/edit dialog, drag moves — the page owns those gestures; this only
 * renders and reports.
 */

import type { PointerEvent } from "react";
import { SquareStack, Maximize2 } from "lucide-react";
import { MarkdownView } from "@/components/ui/markdown-view";
import { CopyId } from "@/components/thoughts/CopyId";
import { TriageBadge } from "@/components/thoughts/TriageBadge";
import type { TriageBadge as TriageBadgeState } from "@/lib/triage";
import { noteClass } from "@/lib/thoughtColors";
import { NOTE_W, NOTE_H } from "@/lib/thoughtGeometry";
import type { Thought } from "@shared/types";
import { Tooltip } from "@/components/ui/tooltip";

/** One note card. `leaving` = a member being dragged over open canvas (it'll leave its group on drop). */
export function CanvasNote({ note: n, selected, dragging, leaving, groupTitle, badge, onPointerDown, onOpen, onToggleTask }: {
  note: Thought;
  selected: boolean;
  dragging: boolean;
  leaving: boolean;
  /** The note's group's title, for the hover chip (unused when it has no group). */
  groupTitle: string;
  badge: TriageBadgeState | undefined;
  onPointerDown: (e: PointerEvent) => void;
  onOpen: () => void;
  onToggleTask: (index: number) => void;
}) {
  return (
    <Tooltip content="Double-click to open" describe={false}>
      <div
        onPointerDown={onPointerDown}
        onDoubleClick={onOpen}
        className={`group absolute flex flex-col overflow-hidden rounded-lg border shadow-sm ${noteClass(n.color)} ${n.pinned ? "ring-2 ring-offset-1 ring-amber-400/70" : ""} ${selected ? "outline outline-2 outline-primary outline-offset-2" : ""} ${dragging ? "cursor-grabbing opacity-90 shadow-lg" : "cursor-pointer"} ${leaving ? "border-dashed" : ""}`}
        style={{ left: n.x, top: n.y, width: NOTE_W, height: NOTE_H, zIndex: dragging ? 60 : (n.zIndex || 1) + 1 }}
        data-note-id={n.id}
      >
        {/* Body — clipped to the card with a soft fade (the full note is
            one double-click away). Checklists stay clickable here. */}
        <div className="min-h-0 flex-1 overflow-hidden p-3 [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
          {n.content.trim()
            ? <MarkdownView content={n.content} className="text-[13px] [&_p]:mb-1" onToggleTask={onToggleTask} />
            : <span className="text-sm text-muted-foreground/60">Empty note — double-click to write</span>}
        </div>

        {/* Expand (top-right, on hover): the discoverable / touch-friendly
            twin of double-click. */}
        <Tooltip content="Open" describe={false}>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="absolute right-1 top-1 rounded bg-background/70 p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="Open note"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>

        {/* Auto-triage badge (top-left): a note's only triage footprint. It
            opens the triage page, where the note becomes work. */}
        <TriageBadge
          noteId={n.id}
          badge={badge}
          className="absolute left-1 top-1 bg-background/70"
          onPointerDown={(e) => e.stopPropagation()}
        />

        {/* Group membership chip (bottom-left) + copyable note id (bottom-right), on hover. */}
        {n.groupId && (
          <div className="pointer-events-none absolute bottom-1 left-1.5 flex items-center gap-0.5 rounded bg-background/70 px-1 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            <SquareStack className="h-2.5 w-2.5" /> {leaving ? "leaving group" : groupTitle}
          </div>
        )}
        <div className="absolute bottom-1 right-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyId id={n.id} />
        </div>
      </div>
    </Tooltip>
  );
}
