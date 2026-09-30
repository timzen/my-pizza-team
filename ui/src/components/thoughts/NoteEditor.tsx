/**
 * NoteEditor — Reading and writing one Thoughts note, shared by the canvas's
 * large dialog (NoteDialog) and the list view's right-hand pane (ThoughtsList).
 *
 *  - **Preview** (the default for a note with content): the rendered markdown,
 *    checklists clickable. Double-click the text, or **Edit**, to write.
 *  - **Edit** (the default for an empty/new note): the CodeMirror editor, inline
 *    (ui/code-editor.tsx) — vim keys on by default, with the **Vim** switch in the
 *    header and a mode/how-to-get-out line under the text (docs/DESIGN.md "The
 *    Big Editor"). `:w`/⌘S save, `:wq`/`:x`/`:q`/⌘↵ finish (there is no discard:
 *    `:q!` finishes too, because a note never loses a thought).
 *  - The header holds everything you do *to* a note: color, pin, group, copy id,
 *    vim, edit/preview, archive, delete.
 *
 * Saving differs by where it's shown, because the two are used differently:
 *
 *  - In the **dialog** (`onDone` given) a note is opened, written, and closed, so
 *    every close path saves and there's a **Done** button (⌘↵).
 *  - In the **pane** (`onDone` absent) there is nothing to close — you click the
 *    next note — so edits **autosave** shortly after you stop typing, and any
 *    pending edit is saved when the pane switches notes or unmounts. There is no
 *    path that loses a thought in either.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/ui/markdown-view";
import { CodeEditorSurface, VimStatus, VimSwitch, useVimPref } from "@/components/ui/full-editor";
import type { VimMode } from "@/components/ui/code-editor";
import { THOUGHT_COLORS, dotClass, noteClass } from "@/lib/thoughtColors";
import { toggleTaskMarker } from "@/lib/taskMarkers";
import { Archive, Eye, Pencil, Pin, PinOff, Trash2 } from "lucide-react";

export interface EditorNote {
  id: string;
  content: string;
  color: string;
  pinned: boolean;
  groupId: string | null;
}

export interface NoteEditorProps {
  note: EditorNote;
  groups: Array<{ id: string; title: string }>;
  /** Open straight into Edit (a just-created note). */
  startEditing?: boolean;
  onSave: (id: string, content: string) => void;
  onColor: (id: string, color: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onGroup: (id: string, groupId: string | null) => void;
  /** Called after any pending edit is saved. */
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  /** A checklist item was clicked in Preview; `content` is the updated markdown to persist. */
  onToggleTask: (id: string, content: string) => void;
  /** Rendered in the header (the copy-id chip). */
  idChip?: React.ReactNode;
  /** Dialog mode: shows **Done**, and is called after the draft is saved. */
  onDone?: () => void;
  /** Dialog mode: the dialog's own dismiss paths call this to save-then-close. */
  closeRef?: React.RefObject<(() => void) | null>;
  /** Hint beside the group picker (how else membership can be changed here). */
  groupHint?: string;
  /** Extra header content (e.g. the dialog's screen-reader title). */
  headerStart?: React.ReactNode;
}

/** How long the pane waits after the last keystroke before saving. */
const AUTOSAVE_MS = 600;

/** Mount with `key={note.id}` so each note starts with its own draft. */
export function NoteEditor({
  note, groups, startEditing, onSave, onColor, onPin, onGroup, onArchive, onDelete, onToggleTask,
  idChip, onDone, closeRef, groupHint, headerStart,
}: NoteEditorProps) {
  const [draft, setDraft] = useState(note.content);
  const [mode, setMode] = useState<"preview" | "edit">(startEditing || !note.content.trim() ? "edit" : "preview");
  const inDialog = onDone !== undefined;
  const [vimOn, setVimOn] = useVimPref();
  const [vimMode, setVimMode] = useState<VimMode>("insert");

  // The last content known to be saved. A ref (not `note.content`) so the
  // unmount flush below compares against what *this* editor last persisted.
  const saved = useRef(note.content);
  // What the unmount flush needs, kept current after every render.
  const latest = useRef({ draft, id: note.id, onSave });
  useEffect(() => { latest.current = { draft, id: note.id, onSave }; });

  /** Persist the draft if it has changed since the last save. */
  const flush = () => {
    const { draft: d, id, onSave: save } = latest.current;
    if (d !== saved.current) { saved.current = d; save(id, d); }
  };

  // Pane mode: autosave a moment after typing stops.
  useEffect(() => {
    if (inDialog || draft === saved.current) return;
    const t = setTimeout(flush, AUTOSAVE_MS);
    return () => clearTimeout(t);
  });
  // Pane mode: switching notes (a new key) or leaving the view unmounts this —
  // save anything still pending. The dialog saves through its close paths instead.
  useEffect(() => () => { if (!inDialog) flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Dialog mode: save, then close. */
  const done = () => { flush(); onDone?.(); };
  /** Finish writing: close the dialog, or save and return to Preview in the pane. */
  const finish = () => { if (inDialog) done(); else { flush(); setMode("preview"); } };
  useEffect(() => {
    if (!closeRef) return;
    closeRef.current = done;
    return () => { closeRef.current = null; };
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: color, pin, group, id … edit/preview, archive, delete, (done) */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {headerStart}
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
          title={groupHint ? `Group (${groupHint})` : "Group"}
        >
          <option value="">No group</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
        </select>
        {idChip}
        <div className="ml-auto flex items-center gap-1">
          {mode === "edit" && <VimSwitch on={vimOn} onChange={setVimOn} className="mr-1" />}
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setMode(mode === "edit" ? "preview" : "edit")} title={mode === "edit" ? "Preview" : "Edit"}>
            {mode === "edit" ? <><Eye className="mr-1 h-4 w-4" />Preview</> : <><Pencil className="mr-1 h-4 w-4" />Edit</>}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => { flush(); onArchive(note.id); onDone?.(); }} title="Archive">
            <Archive className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost" size="sm" className="h-7 px-2 text-destructive"
            onClick={() => {
              if (!window.confirm("Delete this note? This can't be undone.")) return;
              saved.current = latest.current.draft; // nothing left to flush
              onDelete(note.id);
              onDone?.();
            }}
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          {inDialog && <Button size="sm" className="h-7" onClick={done} title="Save and close (⌘↵)">Done</Button>}
        </div>
      </div>

      {/* Body, tinted like the note */}
      <div className={`min-h-0 flex-1 border-0 ${mode === "edit" ? "overflow-hidden" : "overflow-y-auto"} ${noteClass(note.color)}`}>
        {mode === "edit" ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <CodeEditorSurface
                initial={draft}
                vim={vimOn}
                fontSize={15}
                onChange={setDraft}
                onVimMode={setVimMode}
                placeholder="Write a thought… (markdown)"
                commands={{
                  write: flush,
                  save: finish,
                  // A note has no discard path (see the header comment): :q and :q! finish.
                  quit: finish,
                  submit: finish,
                }}
              />
            </div>
            <div className="flex h-7 shrink-0 items-center gap-3 border-t border-foreground/10 px-4 text-xs text-muted-foreground">
              <VimStatus
                vim={vimOn}
                mode={vimMode}
                insertHint={`Esc for normal mode · ⌘↵ ${inDialog ? "to close" : "for Preview"}`}
                normalHint={`i to type · :w saves · :wq ${inDialog ? "closes" : "for Preview"} · or switch Vim off above`}
                plainHint={`⌘↵ ${inDialog ? "to close" : "for Preview"} · Tab indents · Enter continues lists`}
              />
            </div>
          </div>
        ) : (
          <div className="min-h-full cursor-text p-6" onDoubleClick={() => setMode("edit")} title="Double-click to edit">
            {draft.trim() ? (
              <MarkdownView
                content={draft}
                className="text-base"
                onToggleTask={(i) => {
                  // Toggle against the draft and persist that, so a checkbox
                  // click never clobbers unsaved text (or vice versa).
                  const next = toggleTaskMarker(draft, i);
                  setDraft(next);
                  saved.current = next;
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
