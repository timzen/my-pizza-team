/**
 * full-editor.tsx — The big editor: open any text box full-screen, write, and
 * hand the text back. The web UI's version of Pi/Claude Code's Ctrl+G ("edit
 * this prompt in $EDITOR") — see docs/DESIGN.md "The Big Editor".
 *
 * Three ways in, from any host that wires it:
 *
 *   - the **Edit** button beside the text box (**Editor** where "Edit" already
 *     means inline editing: notes, descriptions)
 *   - **Ctrl+G** while typing in it (the Pi/Claude chord)
 *   - `/editor` + Enter in a composer (`/editor some text` carries the text in)
 *
 * The surface is CodeMirror (`code-editor.tsx`, lazy-loaded) with **vim mode on
 * by default** and an always-visible **Vim: On/Off** switch in the header for
 * anyone who'd rather not. With vim on it opens in insert mode, so typing just
 * works; `:wq`/`:w`/`:x` hand the text back, `:q!` throws it away. Either way:
 * ⌘S or Done hands it back, **⌘↵** runs the host's action (Send), and
 * **Esc** closes when vim is off (with vim on, Esc belongs to vim).
 *
 * The same CodeMirror surface is also embedded inline — a Thoughts note's Edit
 * mode *is* it — through the pieces exported below: `CodeEditorSurface` (the
 * lazy editor), `useVimPref` (one vim setting, shared live by every editor),
 * `VimSwitch`, and `VimStatus` (the mode badge and how-to-get-out hint).
 *
 * The host wires the full-screen editor with `useFullEditor`:
 *
 * ```tsx
 * const editor = useFullEditor({ value: draft, onChange: setDraft, title: "Message", onSubmit: send });
 * <Textarea onKeyDown={(e) => { if (editor.handleKeyDown(e)) return; ... }} />
 * <FullEditorButton onClick={() => editor.open()} />
 * {editor.overlay}
 * ```
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/ui/markdown-view";
import { readVimPref, writeVimPref } from "@/lib/editorPrefs";
import type { CodeEditorProps, VimMode } from "./code-editor";
import { Check, Columns2, Maximize2, X } from "lucide-react";

const CodeEditor = lazy(() => import("./code-editor"));

/** The CodeMirror editor, lazy-loaded; fills its parent. */
export function CodeEditorSurface(props: CodeEditorProps) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading editor…</p>}>
      <CodeEditor {...props} />
    </Suspense>
  );
}

/** Fired when the vim setting changes, so every open editor follows the switch. */
const VIM_PREF_EVENT = "mpt:vim-pref";

/**
 * The vim setting (on by default, lib/editorPrefs.ts) and a setter that
 * persists it. Every editor on the page shares it: flip it in a note and the
 * chat's editor follows.
 */
export function useVimPref(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readVimPref(globalThis.localStorage));
  useEffect(() => {
    const sync = () => setOn(readVimPref(globalThis.localStorage));
    globalThis.addEventListener(VIM_PREF_EVENT, sync);
    globalThis.addEventListener("storage", sync); // other tabs
    return () => {
      globalThis.removeEventListener(VIM_PREF_EVENT, sync);
      globalThis.removeEventListener("storage", sync);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    writeVimPref(globalThis.localStorage, next);
    setOn(next);
    globalThis.dispatchEvent(new Event(VIM_PREF_EVENT));
  }, []);
  return [on, set];
}

/** The labelled, always-visible vim on/off switch. */
export function VimSwitch({ on, onChange, className }: { on: boolean; onChange: (on: boolean) => void; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`flex shrink-0 items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted ${className ?? ""}`}
      title={on ? "Vim keybindings are on — click for a plain editor" : "Turn on vim keybindings"}
    >
      <span className={`relative inline-block h-4 w-7 rounded-full transition-colors ${on ? "bg-primary" : "bg-muted-foreground/40"}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-background transition-all ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      Vim: <strong>{on ? "On" : "Off"}</strong>
    </button>
  );
}

/**
 * The status-bar left side: with vim on, the mode badge and how to get out of
 * it (so nobody is ever stuck in normal mode); with it off, `plainHint`.
 */
export function VimStatus({ vim: on, mode, insertHint, normalHint, plainHint }: {
  vim: boolean; mode: VimMode; insertHint: string; normalHint: string; plainHint: string;
}) {
  if (!on) return <span className="truncate">{plainHint}</span>;
  return (
    <>
      <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono font-semibold ${mode === "insert" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}>
        {mode.toUpperCase()}
      </span>
      <span className="truncate">{mode === "insert" ? insertHint : normalHint}</span>
    </>
  );
}

export interface UseFullEditorOptions {
  /** The host's current text; seeds the editor each time it opens. */
  value: string;
  /** Called with the edited text when the editor hands it back. */
  onChange: (value: string) => void;
  /** Shown in the header (e.g. "Message", "Note", "Description"). */
  title?: string;
  /**
   * The host's primary action — a composer's Send. Runs *after* the host has
   * re-rendered with the edited text (so it sends what you wrote, not the old
   * draft). Bound to ⌘↵; without it ⌘↵ just hands the text back.
   */
  onSubmit?: () => void;
  /** Label for the submit button (default "Send"). */
  submitLabel?: string;
  /** While false, Ctrl+G and `open` do nothing (a read-only host). */
  enabled?: boolean;
}

export interface FullEditorHandle {
  /** Open the editor — with the host's current value, or `seed` if given. */
  open: (seed?: string) => void;
  /** Call first from the host textarea's `onKeyDown`; `true` means it handled the key (Ctrl+G). */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Render this somewhere in the host's tree. */
  overlay: React.ReactNode;
}

/** Ctrl+G — never ⌘G, which is the browser's find-again on a Mac. */
function isOpenChord(e: React.KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "g";
}

export function useFullEditor(opts: UseFullEditorOptions): FullEditorHandle {
  const { value, onChange, title, onSubmit, submitLabel, enabled = true } = opts;
  const [seed, setSeed] = useState<string | null>(null); // non-null while open
  const pendingSubmit = useRef(false);

  const open = useCallback((s?: string) => {
    if (enabled) setSeed(s ?? value);
  }, [enabled, value]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpenChord(e)) return false;
    e.preventDefault();
    open();
    return true;
  }, [open]);

  // Submit waits a render: `onChange` updates the host's state, and the host's
  // `onSubmit` must see that new state, not the closure from before the edit.
  // Closing re-renders the host anyway, so the effect after that render runs it.
  useEffect(() => {
    if (!pendingSubmit.current) return;
    pendingSubmit.current = false;
    onSubmit?.();
  });

  const finish = useCallback((text: string, submit: boolean) => {
    onChange(text);
    setSeed(null);
    if (submit && onSubmit) pendingSubmit.current = true;
  }, [onChange, onSubmit]);

  return {
    open,
    handleKeyDown,
    overlay: seed !== null
      ? (
        <FullEditor
          initial={seed}
          title={title}
          submitLabel={onSubmit ? (submitLabel ?? "Send") : undefined}
          onFinish={finish}
          onDiscard={() => setSeed(null)}
        />
      )
      : null,
  };
}

interface FullEditorProps {
  initial: string;
  title?: string;
  /** Present only when the host has a primary action. */
  submitLabel?: string;
  onFinish: (text: string, submit: boolean) => void;
  onDiscard: () => void;
}

/**
 * The overlay. It's a base-ui Dialog so it nests properly inside other dialogs
 * (the Thoughts canvas's NoteDialog): focus is trapped here, and Esc closes only
 * this one.
 */
function FullEditor({ initial, title, submitLabel, onFinish, onDiscard }: FullEditorProps) {
  const [text, setText] = useState(initial);
  const [vimOn, setVimOn] = useVimPref();
  const [mode, setMode] = useState<VimMode>("insert");
  const [preview, setPreview] = useState(false);
  const dirty = text !== initial;

  const discard = (force: boolean) => {
    if (!force && dirty && !window.confirm("Discard your changes?")) return;
    onDiscard();
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // With vim on, Esc is vim's (leave insert mode), never "close".
        if (details.reason === "escape-key" && vimOn) { details.cancel(); return; }
        onFinish(text, false); // every other dismiss path keeps the text
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          className="fixed inset-0 z-[60] flex flex-col bg-background text-foreground outline-none"
          aria-label={`Edit ${title ?? "text"}`}
          // Keep a vim Esc from reaching an enclosing dialog's dismiss handler.
          onKeyDown={(e) => { if (e.key === "Escape" && vimOn) e.stopPropagation(); }}
        >
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <Maximize2 className="h-4 w-4 text-muted-foreground" />
            <DialogPrimitive.Title className="text-sm font-medium">{title ?? "Editor"}</DialogPrimitive.Title>

            {/* The vim switch: labelled, always visible, one click. */}
            <VimSwitch on={vimOn} onChange={setVimOn} className="ml-2" />

            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setPreview(!preview)} title="Show the rendered markdown beside the text">
                <Columns2 className="mr-1 h-4 w-4" />{preview ? "Hide preview" : "Preview"}
              </Button>
              <Button variant="ghost" size="sm" className="h-8 text-destructive" onClick={() => discard(false)} title="Close without keeping changes">
                <X className="mr-1 h-4 w-4" />Discard
              </Button>
              <Button size="sm" variant={submitLabel ? "outline" : "default"} className="h-8" onClick={() => onFinish(text, false)} title="Keep the text and close (⌘S)">
                <Check className="mr-1 h-4 w-4" />Done
              </Button>
              {submitLabel && (
                <Button size="sm" className="h-8" onClick={() => onFinish(text, true)} title={`${submitLabel} (⌘↵)`}>
                  {submitLabel}
                </Button>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className={`min-h-0 flex-1 ${preview ? "border-r border-border" : ""}`}>
              <CodeEditorSurface
                initial={initial}
                vim={vimOn}
                onChange={setText}
                onVimMode={setMode}
                commands={{
                  // There's no file to keep open here, so :w closes just like :wq.
                  write: () => onFinish(text, false),
                  save: () => onFinish(text, false),
                  quit: discard,
                  submit: () => onFinish(text, submitLabel !== undefined),
                }}
              />
            </div>
            {preview && (
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                {text.trim()
                  ? <MarkdownView content={text} />
                  : <p className="text-sm italic text-muted-foreground">Nothing to preview yet.</p>}
              </div>
            )}
          </div>

          <div className="flex h-8 shrink-0 items-center gap-4 border-t border-border px-4 text-xs text-muted-foreground">
            <VimStatus
              vim={vimOn}
              mode={mode}
              insertHint="Esc for normal mode · ⌘S or Done to finish"
              normalHint="i to type · :wq to finish · :q! to discard · or switch Vim off above"
              plainHint={`⌘S or Esc to finish · ⌘↵ ${submitLabel ?? "Done"} · Tab indents · Enter continues lists`}
            />
            <span className="ml-auto">{words} {words === 1 ? "word" : "words"} · {dirty ? "modified" : "unchanged"}</span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The "open the big editor" button hosts put beside a text box. */
export function FullEditorButton({ onClick, disabled, className }: { onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={disabled} className={className} title="Open in the big editor (⌃G, or /editor)">
      Edit
    </Button>
  );
}
