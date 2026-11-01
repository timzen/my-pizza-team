/**
 * ViewSwitch — The Thoughts page's Canvas ⇄ List switch (a two-button
 * segmented control at the right of the shared toolbar). The chosen view is
 * remembered by ThoughtsPage (`mpt.thoughts.view`).
 */

import type { ReactNode } from "react";
import { StickyNote, ListTree } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

/** The Thoughts page's two views of one board. */
export type ViewMode = "canvas" | "list";

/** Canvas ⇄ list switch (a two-button segmented control). */
export function ViewSwitch({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const btn = (m: ViewMode, label: string, icon: ReactNode) => (
    <Tooltip content={`${label} view`}>
      <button
        onClick={() => onChange(m)}
        aria-pressed={mode === m}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm ${mode === m ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}
      >
        {icon}{label}
      </button>
    </Tooltip>
  );
  return (
    <div className="flex overflow-hidden rounded-md border border-border shadow-sm" role="group" aria-label="View">
      {btn("canvas", "Canvas", <StickyNote className="h-4 w-4" />)}
      {btn("list", "List", <ListTree className="h-4 w-4" />)}
    </div>
  );
}
