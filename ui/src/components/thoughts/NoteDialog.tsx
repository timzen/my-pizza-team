/**
 * NoteDialog — The large view/edit experience for one Thoughts note.
 *
 * Canvas notes are all one small size (lib/thoughtGeometry), so this is where a
 * note is actually read and written: **double-click** a note to open it.
 *
 *  - **Preview** (the default for a note with content): the rendered markdown,
 *    checklists clickable. Double-click the text, or **Edit**, to write.
 *  - **Edit** (the default for an empty/new note): a large markdown textarea.
 *    ⌘/Ctrl+Enter saves and closes.
 *  - Closing (Esc, clicking outside, **Done**) **saves** any change — there's
 *    no discard path to lose a thought by.
 *
 * Everything that used to crowd a note's hover toolbar lives in the header:
 * **color** (moved here from the canvas), pin, group membership (drag-and-drop
 * on the canvas is the quick way; this is the precise one), copy id, archive,
 * delete.
 */

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/ui/markdown-view";
import { THOUGHT_COLORS, dotClass, noteClass } from "@/lib/thoughtColors";
import { toggleTaskMarker } from "@/lib/taskMarkers";
import { Archive, Eye, Pencil, Pin, PinOff, Trash2 } from "lucide-react";

export interface DialogNote {
  id: string;
  content: string;
  color: string;
  pinned: boolean;
  groupId: string | null;
}

export interface NoteDialogProps {
  note: DialogNote | null;
  groups: Array<{ id: string; title: string }>;
  /** Open straight into Edit (a just-created note). */
  startEditing?: boolean;
  onClose: () => void;
  onSave: (id: string, content: string) => void;
  onColor: (id: string, color: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onGroup: (id: string, groupId: string | null) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  /** A checklist item was clicked in Preview; `content` is the updated markdown to persist. */
  onToggleTask: (id: string, content: string) => void;
  /** Rendered in the header (the canvas's copy-id chip). */
  idChip?: React.ReactNode;
}

export function NoteDialog(props: NoteDialogProps) {
  const { note, onClose } = props;
  // Every dismiss path (Esc, outside click) goes through the editor's
  // save-then-close, which it registers here.
  const closeRef = useRef<(() => void) | null>(null);
  return (
    <Dialog open={note !== null} onOpenChange={(open) => { if (!open) (closeRef.current ?? onClose)(); }}>
      <DialogContent className="flex h-[min(80vh,44rem)] w-[min(52rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" showCloseButton={false}>
        {/* Keyed by id so each note starts with its own fresh draft. */}
        {note && <NoteEditor key={note.id} {...props} note={note} closeRef={closeRef} />}
      </DialogContent>
    </Dialog>
  );
}

function NoteEditor({
  note, groups, startEditing, onClose, onSave, onColor, onPin, onGroup, onArchive, onDelete, onToggleTask, idChip, closeRef,
}: NoteDialogProps & { note: DialogNote; closeRef: React.RefObject<(() => void) | null> }) {
  const [draft, setDraft] = useState(note.content);
  const [mode, setMode] = useState<"preview" | "edit">(startEditing || !note.content.trim() ? "edit" : "preview");

  /** Persist the draft if it changed, then close (every close path saves). */
  const close = () => {
    if (draft !== note.content) onSave(note.id, draft);
    onClose();
  };
  // Register for the dialog's own dismiss paths (see NoteDialog).
  useEffect(() => {
    closeRef.current = close;
    return () => { closeRef.current = null; };
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: color, pin, group, id … edit/preview, archive, delete, done */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <DialogTitle className="sr-only">Note</DialogTitle>
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Color">
          {THOUGHT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={note.color === c}
              onClick={() => onColor(note.id, c)}
              className={`h-5 w-5 rounded-full ${dotClass(c)} ${note.color === c ? "ring-2 ring-foreground/60 ring-offset-2 ring-offset-background" : ""}`}
              title={c}
            />
          ))}
        </div>
        <div className="h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onPin(note.id, !note.pinned)} title={note.pinned ? "Unpin" : "Pin"}>
          {note.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
        </Button>
        <select
          value={note.groupId ?? ""}
          onChange={(e) => onGroup(note.id, e.target.value || null)}
          className="h-7 max-w-[12rem] rounded-md border border-border bg-background px-2 text-xs"
          title="Group (or drag the note onto a group on the canvas)"
        >
          <option value="">No group</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
        </select>
        {idChip}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setMode(mode === "edit" ? "preview" : "edit")} title={mode === "edit" ? "Preview" : "Edit"}>
            {mode === "edit" ? <><Eye className="mr-1 h-4 w-4" />Preview</> : <><Pencil className="mr-1 h-4 w-4" />Edit</>}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => { if (draft !== note.content) onSave(note.id, draft); onArchive(note.id); onClose(); }} title="Archive">
            <Archive className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => { if (window.confirm("Delete this note? This can't be undone.")) { onDelete(note.id); onClose(); } }} title="Delete">
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button size="sm" className="h-7" onClick={close} title="Save and close (⌘↵)">Done</Button>
        </div>
      </div>

      {/* Body, tinted like the note */}
      <div className={`min-h-0 flex-1 overflow-y-auto border-0 ${noteClass(note.color)}`}>
        {mode === "edit" ? (
          <textarea
            autoFocus
            // Caret at the end: opening a note to write usually means adding to it.
            onFocus={(e) => { const end = e.currentTarget.value.length; e.currentTarget.setSelectionRange(end, end); }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); close(); } }}
            className="h-full w-full resize-none bg-transparent p-6 font-mono text-sm leading-relaxed outline-none"
            placeholder="Write a thought… (markdown)"
          />
        ) : (
          <div className="cursor-text p-6" onDoubleClick={() => setMode("edit")} title="Double-click to edit">
            {draft.trim() ? (
              <MarkdownView
                content={draft}
                className="text-base"
                onToggleTask={(i) => {
                  // Toggle against the draft and persist that, so a checkbox
                  // click never clobbers unsaved text (or vice versa).
                  const next = toggleTaskMarker(draft, i);
                  setDraft(next);
                  onToggleTask(note.id, next);
                }}
              />
            ) : (
              <p className="text-muted-foreground">Empty note — double-click to write.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
