/**
 * NoteDialog — The canvas's large view/edit dialog for one Thoughts note.
 *
 * Canvas notes are all one small size (lib/thoughtGeometry), so this is where a
 * note is actually read and written on the canvas: **double-click** a note to
 * open it. The editor itself (NoteEditor) is shared with the list view's pane;
 * the dialog adds the frame and its close semantics — every close path (Esc,
 * clicking outside, **Done**, ⌘↵) **saves**, so there's no discard path to lose
 * a thought by. The one exception to "Esc closes": while writing with vim on,
 * Esc belongs to vim (leave insert mode), so it never closes the dialog —
 * `:wq`, ⌘↵, **Done**, or clicking outside do.
 */

import { useRef } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NoteEditor, type EditorNote, type NoteEditorProps } from "@/components/thoughts/NoteEditor";

export type DialogNote = EditorNote;

export interface NoteDialogProps extends Omit<NoteEditorProps, "note" | "onDone" | "closeRef" | "headerStart"> {
  note: DialogNote | null;
  onClose: () => void;
}

export function NoteDialog({ note, onClose, ...editorProps }: NoteDialogProps) {
  // Every dismiss path (Esc, outside click) goes through the editor's
  // save-then-close, which it registers here.
  const closeRef = useRef<(() => void) | null>(null);
  return (
    <Dialog
      open={note !== null}
      onOpenChange={(open, details) => {
        if (open) return;
        const target = details.event?.target;
        if (details.reason === "escape-key" && target instanceof Element && target.closest('[data-vim="on"]')) {
          details.cancel();
          return;
        }
        (closeRef.current ?? onClose)();
      }}
    >
      <DialogContent className="flex h-[min(80vh,44rem)] w-[min(52rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" showCloseButton={false}>
        {/* Keyed by id so each note starts with its own fresh draft. */}
        {note && (
          <NoteEditor
            key={note.id}
            {...editorProps}
            note={note}
            onDone={onClose}
            closeRef={closeRef}
            groupHint="or drag the note onto a group on the canvas"
            headerStart={<DialogTitle className="sr-only">Note</DialogTitle>}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
