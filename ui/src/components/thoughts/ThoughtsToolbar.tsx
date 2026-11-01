/**
 * ThoughtsToolbar — The one toolbar row above both Thoughts views. **+ Note**
 * comes first and the zoom (canvas only), **Archived**, and the view switch sit
 * at the right, so the fixed controls never move when you change view; between
 * them are the view's own tools (canvas: Group, Tidy, Select, Map; list:
 * Folder). ThoughtsPage owns every action; this only renders and reports.
 */

import { Plus, Minus, Archive, FolderPlus, LayoutGrid, BoxSelect, Map as MapIcon } from "lucide-react";
import { ViewSwitch, type ViewMode } from "@/components/thoughts/ViewSwitch";

/** The shared toolbar. `selectedCount` is the canvas selection's size. */
export function ThoughtsToolbar({
  mode, onModeChange, onNewNote, newNoteTitle, selectedCount, onNewGroup, onTidy,
  selectMode, onToggleSelectMode, minimapOn, onToggleMinimap, onNewFolder,
  scale, onZoom, onResetView, showArchived, onToggleArchived, archivedCount,
}: {
  mode: ViewMode;
  onModeChange: (m: ViewMode) => void;
  onNewNote: () => void;
  newNoteTitle: string;
  selectedCount: number;
  onNewGroup: () => void;
  onTidy: () => void;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  minimapOn: boolean;
  onToggleMinimap: () => void;
  onNewFolder: () => void;
  scale: number;
  onZoom: (factor: number) => void;
  onResetView: () => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  /** Undefined until the archived list has loaded. */
  archivedCount: number | undefined;
}) {
  const toolBtn = "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm shadow-sm";
  const toolOff = "border-border bg-card hover:bg-accent/50";
  const toolOn = "border-primary bg-primary text-primary-foreground";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
      <button
        onClick={onNewNote}
        title={newNoteTitle}
        className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
      >
        <Plus className="h-4 w-4" /> Note
      </button>
      {mode === "canvas" ? (<>
        <button onClick={onNewGroup} title={selectedCount > 0 ? `New group with ${selectedCount} selected note(s)` : "New empty group"} className={`${toolBtn} ${toolOff}`}>
          <FolderPlus className="h-4 w-4" /> {selectedCount > 0 ? `Group ${selectedCount}` : "Group"}
        </button>
        <button onClick={onTidy} title="Arrange notes into a grid (per group + ungrouped)" className={`${toolBtn} ${toolOff}`}>
          <LayoutGrid className="h-4 w-4" /> Tidy
        </button>
        <button onClick={onToggleSelectMode} title="Select mode (S) — drag to marquee-select; shift+drag always selects" className={`${toolBtn} ${selectMode ? toolOn : toolOff}`}>
          <BoxSelect className="h-4 w-4" /> Select{selectedCount ? ` (${selectedCount})` : ""}
        </button>
        <button onClick={onToggleMinimap} title="Minimap (M)" className={`${toolBtn} ${minimapOn ? toolOn : toolOff}`}>
          <MapIcon className="h-4 w-4" /> Map
        </button>
      </>) : (
        <button onClick={onNewFolder} title="New folder (a group)" className={`${toolBtn} ${toolOff}`}>
          <FolderPlus className="h-4 w-4" /> Folder
        </button>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* Zoom (canvas only): −  NN% (reset)  + */}
        {mode === "canvas" && (
          <div className="flex items-center rounded-md border border-border bg-card shadow-sm">
            <button onClick={() => onZoom(1 / 1.2)} className="rounded-l-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground" title="Zoom out">
              <Minus className="h-4 w-4" />
            </button>
            <button onClick={onResetView} className="min-w-[3rem] border-x border-border px-1 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground" title="Reset view">
              {Math.round(scale * 100)}%
            </button>
            <button onClick={() => onZoom(1.2)} className="rounded-r-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground" title="Zoom in">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        )}
        <button onClick={onToggleArchived} className={`${toolBtn} ${showArchived ? "border-border bg-accent" : toolOff}`}>
          <Archive className="h-4 w-4" /> Archived {archivedCount !== undefined ? `(${archivedCount})` : ""}
        </button>
        <ViewSwitch mode={mode} onChange={onModeChange} />
      </div>
    </div>
  );
}
