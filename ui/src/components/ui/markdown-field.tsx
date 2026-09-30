/**
 * MarkdownField — A description field (story description, a WorkDef's goal and
 * additional context) that renders as markdown by default, with a toggle to
 * edit it.
 *
 * Edit mode is the CodeMirror editor inline (ui/code-editor.tsx) — vim keys on
 * by default, the **Vim** switch in the field's header while editing, and a
 * mode/how-to-get-out line under the text; the same editor a Thoughts note uses
 * (docs/DESIGN.md "The Big Editor"). The form around the field owns saving, so
 * `:w`/⌘S do nothing here, and `:wq`/`:x`/`:q`/⌘↵ go back to Preview.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/ui/markdown-view";
import { CodeEditorSurface, VimStatus, VimSwitch, useVimPref } from "@/components/ui/full-editor";
import type { VimMode } from "@/components/ui/code-editor";
import { Pencil, Eye } from "lucide-react";

interface MarkdownFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  /** Minimum visible lines while editing; the editor grows with its content. */
  rows?: number;
  required?: boolean;
  /** Start in edit mode (for new/empty content) */
  defaultEditing?: boolean;
}

export function MarkdownField({ value, onChange, label, rows = 3, required, defaultEditing }: MarkdownFieldProps) {
  const [editing, setEditing] = useState(defaultEditing ?? false);
  // Focus the editor only when the user asked to edit — a form that merely
  // starts in edit mode (New Story) shouldn't steal focus from its title.
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [vimOn, setVimOn] = useVimPref();
  const [vimMode, setVimMode] = useState<VimMode>("insert");

  const startEditing = () => { setFocusOnOpen(true); setEditing(true); };
  const toPreview = () => setEditing(false);

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-2 pb-1 border-b border-border">
        {label && <label className="text-sm font-medium leading-none">{label}</label>}
        <div className="flex items-center gap-2">
          {editing && <VimSwitch on={vimOn} onChange={setVimOn} className="py-0.5" />}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs gap-1"
            onClick={() => (editing ? toPreview() : startEditing())}
          >
            {editing ? <><Eye className="h-3 w-3" /> Preview</> : <><Pencil className="h-3 w-3" /> Edit</>}
          </Button>
        </div>
      </div>
      {editing ? (
        <div className="overflow-hidden rounded-lg border border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
          <div className="max-h-[60vh] overflow-y-auto">
            <CodeEditorSurface
              initial={value}
              vim={vimOn}
              onChange={onChange}
              onVimMode={setVimMode}
              minLines={rows}
              autoFocus={focusOnOpen}
              placeholder="Write… (markdown)"
              commands={{ write: () => {}, save: toPreview, quit: toPreview, submit: toPreview }}
            />
          </div>
          <div className="flex h-6 items-center gap-3 border-t border-border px-3 text-[11px] text-muted-foreground">
            <VimStatus
              vim={vimOn}
              mode={vimMode}
              insertHint="Esc for normal mode · ⌘↵ for Preview"
              normalHint="i to type · :wq for Preview · or switch Vim off above"
              plainHint="⌘↵ for Preview · Tab indents · Enter continues lists"
            />
          </div>
        </div>
      ) : (
        <div
          className="rounded-md bg-background px-3 py-2 min-h-[80px] cursor-pointer"
          onClick={startEditing}
        >
          {value ? (
            <MarkdownView content={value} />
          ) : (
            <p className="text-sm text-muted-foreground italic">No description. Click to edit.</p>
          )}
        </div>
      )}
      {/* The editor isn't a form control, so this carries `required` for the
          browser's native validation (and anchors its "fill this in" bubble). */}
      {required && (
        <textarea
          required
          value={value}
          onChange={() => {}}
          onFocus={startEditing}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-4 h-px w-px opacity-0"
        />
      )}
    </div>
  );
}
