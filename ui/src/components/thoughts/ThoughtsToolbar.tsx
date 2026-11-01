/**
 * ThoughtsToolbar — The one toolbar row above both Thoughts views. **+ Note**
 * comes first and the zoom (canvas only), **Archived**, and the view switch sit
 * at the right, so the fixed controls never move when you change view; between
 * them are the view's own tools (canvas: Group, Tidy, Select, Map; list:
 * Folder). ThoughtsPage owns every action; this only renders and reports.
 */

import { Plus, Minus, Archive, FolderPlus, LayoutGrid, BoxSelect, Map as MapIcon } from "lucide-react";
import { ViewSwitch, type ViewMode } from "@/components/thoughts/ViewSwitch";
import { Tooltip } from "@/components/ui/tooltip";

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
      <Tooltip content={newNoteTitle}>
        <button
          onClick={onNewNote}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Note
        </button>
      </Tooltip>
      {mode === "canvas" ? (<>
        <Tooltip content={selectedCount > 0 ? `New group with ${selectedCount} selected note(s)` : "New empty group"}>
          <button onClick={onNewGroup} className={`${toolBtn} ${toolOff}`}>
            <FolderPlus className="h-4 w-4" /> {selectedCount > 0 ? `Group ${selectedCount}` : "Group"}
          </button>
        </Tooltip>
        <Tooltip content="Arrange notes into a grid (per group + ungrouped)">
          <button onClick={onTidy} className={`${toolBtn} ${toolOff}`}>
            <LayoutGrid className="h-4 w-4" /> Tidy
          </button>
        </Tooltip>
        <Tooltip content="Select mode (S) — drag to marquee-select; shift+drag always selects">
          <button onClick={onToggleSelectMode} aria-pressed={selectMode} className={`${toolBtn} ${selectMode ? toolOn : toolOff}`}>
            <BoxSelect className="h-4 w-4" /> Select{selectedCount ? ` (${selectedCount})` : ""}
          </button>
        </Tooltip>
        <Tooltip content="Minimap (M)">
          <button onClick={onToggleMinimap} aria-pressed={minimapOn} className={`${toolBtn} ${minimapOn ? toolOn : toolOff}`}>
            <MapIcon className="h-4 w-4" /> Map
          </button>
        </Tooltip>
      </>) : (
        <Tooltip content="New folder (a group)">
          <button onClick={onNewFolder} className={`${toolBtn} ${toolOff}`}>
            <FolderPlus className="h-4 w-4" /> Folder
          </button>
        </Tooltip>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* Zoom (canvas only): −  NN% (reset)  + */}
        {mode === "canvas" && (
          <div className="flex items-center rounded-md border border-border bg-card shadow-sm">
            <Tooltip content="Zoom out" describe={false}>
              <button onClick={() => onZoom(1 / 1.2)} className="rounded-l-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground" aria-label="Zoom out">
                <Minus className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content="Reset view" describe={false}>
              <button onClick={onResetView} aria-label={`Zoom ${Math.round(scale * 100)}%, reset view`} className="min-w-[3rem] border-x border-border px-1 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground">
                {Math.round(scale * 100)}%
              </button>
            </Tooltip>
            <Tooltip content="Zoom in" describe={false}>
              <button onClick={() => onZoom(1.2)} className="rounded-r-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground" aria-label="Zoom in">
                <Plus className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
        )}
        <button onClick={onToggleArchived} aria-pressed={showArchived} className={`${toolBtn} ${showArchived ? "border-border bg-accent" : toolOff}`}>
          <Archive className="h-4 w-4" /> Archived {archivedCount !== undefined ? `(${archivedCount})` : ""}
        </button>
        <ViewSwitch mode={mode} onChange={onModeChange} />
      </div>
    </div>
  );
}
