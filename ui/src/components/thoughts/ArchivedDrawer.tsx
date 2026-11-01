/**
 * ArchivedDrawer — The Thoughts page's Archived panel (right edge, over either
 * view): each archived note with Restore and Delete. The page owns the data and
 * the mutations.
 */

import { Trash2, ArchiveRestore, X } from "lucide-react";
import { noteClass } from "@/lib/thoughtColors";
import type { Thought } from "@shared/types";

/** The archived-notes drawer; `notes` is undefined while still loading. */
export function ArchivedDrawer({ notes, onClose, onRestore, onDelete }: {
  notes: Thought[] | undefined;
  onClose: () => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="absolute right-0 top-0 z-30 flex h-full w-80 flex-col border-l border-border bg-card shadow-lg">
      <div className="flex items-center justify-between border-b border-border p-3">
        <span className="font-medium">Archived</span>
        <button onClick={onClose} className="rounded p-1 hover:bg-accent/50"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {(notes ?? []).length === 0 && <p className="text-sm text-muted-foreground">Nothing archived.</p>}
        {(notes ?? []).map((n) => (
          <div key={n.id} className={`rounded-md border p-2 ${noteClass(n.color)}`}>
            <div className="mb-1 line-clamp-3 text-xs">{n.content.trim() || <span className="text-muted-foreground/60">(empty)</span>}</div>
            <div className="flex gap-1">
              <button onClick={() => onRestore(n.id)} className="flex items-center gap-1 rounded bg-card/70 px-1.5 py-0.5 text-xs hover:bg-card"><ArchiveRestore className="h-3 w-3" /> Restore</button>
              <button onClick={() => onDelete(n.id)} className="flex items-center gap-1 rounded bg-card/70 px-1.5 py-0.5 text-xs hover:bg-card"><Trash2 className="h-3 w-3" /> Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
