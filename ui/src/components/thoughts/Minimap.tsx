/**
 * Minimap — The Thoughts canvas's orientation overlays (bottom row, shown
 * together; `M` toggles): the minimap of note dots and the viewport, and the
 * group chips beside it that center a group in the view. The frame math is
 * pure in lib/thoughtLayout (`minimapFrame`), the chip order in
 * lib/thoughtGeometry (`groupsByNoteCount`).
 */

import type { PointerEvent } from "react";
import { dotClass } from "@/lib/thoughtColors";
import { NOTE_W, NOTE_H, groupsByNoteCount } from "@/lib/thoughtGeometry";
import { minimapFrame, type CanvasView } from "@/lib/thoughtLayout";
import type { Thought, ThoughtGroup } from "@shared/types";
import { Tooltip } from "@/components/ui/tooltip";

/** Minimap size (px); the group-chip row starts just right of it. */
const MINIMAP_W = 192, MINIMAP_H = 128;

/** A small orientation minimap (bottom-left): note dots + the current viewport
 *  rectangle over the board's extent. Click/drag to recenter the view. */
export function Minimap({ notes, view, vpW, vpH, onRecenter }: {
  notes: Thought[];
  view: CanvasView;
  /** The canvas viewport's size (px), tracked by the page. */
  vpW: number;
  vpH: number;
  onRecenter: (wx: number, wy: number) => void;
}) {
  const MMW = MINIMAP_W, MMH = MINIMAP_H;
  const { minX, minY, s, viewport } = minimapFrame(notes, view, vpW, vpH, { w: MMW, h: MMH, pad: 40 });
  const mx = (wx: number) => (wx - minX) * s;
  const my = (wy: number) => (wy - minY) * s;

  const recenterFrom = (e: PointerEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    onRecenter(minX + (e.clientX - box.left) / s, minY + (e.clientY - box.top) / s);
  };

  return (
    <Tooltip content="Minimap — click to jump" describe={false}>
      <div
        className="absolute bottom-4 left-4 z-30 overflow-hidden rounded-md border border-border bg-card/90 shadow-sm"
        style={{ width: MMW, height: MMH }}
        onPointerDown={(e) => { e.preventDefault(); recenterFrom(e); }}
        onPointerMove={(e) => { if (e.buttons === 1) recenterFrom(e); }}
      >
        {notes.map((n) => (
          <div key={n.id} className="absolute rounded-[1px] bg-muted-foreground/50" style={{ left: mx(n.x), top: my(n.y), width: Math.max(2, NOTE_W * s), height: Math.max(2, NOTE_H * s) }} />
        ))}
        {/* Viewport rectangle */}
        <div className="absolute border border-primary bg-primary/10" style={{ left: mx(viewport.x0), top: my(viewport.y0), width: (viewport.x1 - viewport.x0) * s, height: (viewport.y1 - viewport.y0) * s }} />
      </div>
    </Tooltip>
  );
}

/**
 * Group chips (bottom, beside the minimap and shown with it): one per group,
 * most notes first (`groupsByNoteCount`). Clicking one centers that group's
 * plate in the view at the current zoom. The row scrolls horizontally rather
 * than wrapping, so it never grows up over the canvas.
 */
export function GroupChips({ groups, notes, onJump }: {
  groups: ThoughtGroup[];
  notes: Thought[];
  onJump: (g: ThoughtGroup) => void;
}) {
  return (
    <div
      className="pointer-events-none absolute bottom-4 right-4 z-30 flex items-end gap-1.5 overflow-x-auto [scrollbar-width:none]"
      // 16px (left-4) + the minimap + an 8px gap. The row spans the canvas
      // width, so only the chips take pointer events — the gaps stay canvas.
      style={{ left: 16 + MINIMAP_W + 8 }}
    >
      {groupsByNoteCount(groups, notes).map(({ plate: g, count }) => (
        <Tooltip key={g.id} content={`Jump to ${g.title}`}>
          <button
            onClick={() => onJump(g)}
            className="pointer-events-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card/90 px-2.5 py-1 text-xs shadow-sm hover:bg-accent"
          >
            <span className={`h-2 w-2 rounded-full ${g.groupColor ? dotClass(g.groupColor) : "bg-muted-foreground/40"}`} />
            {g.title}
            <span className="text-muted-foreground">{count}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
