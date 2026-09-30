/**
 * code-editor.tsx — The CodeMirror 6 editing surface, with optional vim
 * keybindings (@replit/codemirror-vim). It is used in two places: the full-screen
 * big editor (`full-editor.tsx`) and, inline, a Thoughts note's Edit mode
 * (`thoughts/NoteEditor.tsx`). See docs/DESIGN.md "The Big Editor".
 *
 * Lazy-loaded (hosts import it through `CodeEditorSurface` in full-editor.tsx)
 * so CodeMirror only downloads the first time someone edits with it.
 *
 * What CodeMirror gives us that a textarea can't: real undo history across
 * programmatic edits, markdown list continuation on Enter (`- `, `1. `,
 * `- [ ] `, `> `), line numbers, Tab/Shift+Tab indent, search (⌘F, or `/` in
 * vim), and vim itself — modes, motions, registers, visual mode, `:` commands.
 *
 * The editor is uncontrolled: it's created once with `initial` and reports every
 * change up through `onChange`. The vim toggle is swapped live through a
 * Compartment, so turning vim off doesn't lose the text, the caret, or undo.
 */

import { useEffect, useRef } from "react";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Vim, getCM, vim } from "@replit/codemirror-vim";

/**
 * What the editor asks its host to do. Each host decides what they mean: the
 * big editor closes on `save`, a note just persists on `write` and returns to
 * Preview on `save`.
 */
export interface EditorCommands {
  /** `:w`, ⌘S — persist, keep editing. */
  write: () => void;
  /** `:wq`, `:x` — persist and finish. */
  save: () => void;
  /** `:q` / `:q!` (`force`). */
  quit: (force: boolean) => void;
  /** ⌘↵ — the host's primary action (Send, Done). */
  submit: () => void;
}

export type VimMode = "normal" | "insert" | "visual" | "replace";

export interface CodeEditorProps {
  initial: string;
  vim: boolean;
  onChange: (text: string) => void;
  onVimMode?: (mode: VimMode) => void;
  commands: EditorCommands;
  placeholder?: string;
  /** Font size in px (the big editor is 14, a note is 15). */
  fontSize?: number;
  /** Take focus on mount (default true). False for a form field that merely starts in edit mode. */
  autoFocus?: boolean;
  /**
   * Minimum visible lines. When set, the editor sizes to its content (from this
   * height up) instead of filling its parent — for a field inside a page form.
   */
  minLines?: number;
}

// Vim's ex commands are global to the vim engine, so they're defined once and
// routed to the editor they were typed in (several can be open at once — a
// note in the list pane and the chat's big editor, say).
const commandsByView = new WeakMap<EditorView, () => EditorCommands>();
let exDefined = false;
function defineExCommands() {
  if (exDefined) return;
  exDefined = true;
  type Cm = { cm6?: EditorView };
  const route = (cm: Cm) => (cm.cm6 ? commandsByView.get(cm.cm6)?.() : undefined);
  const forced = (p: { argString?: string; input?: string }) =>
    (p.argString ?? "").trim().startsWith("!") || (p.input ?? "").trim().endsWith("!");
  Vim.defineEx("write", "w", (cm) => route(cm as Cm)?.write());
  Vim.defineEx("wq", "wq", (cm) => route(cm as Cm)?.save());
  Vim.defineEx("xit", "x", (cm) => route(cm as Cm)?.save());
  Vim.defineEx("quit", "q", (cm, p) => route(cm as Cm)?.quit(forced(p)));
}

/** Theme the editor from the app's CSS variables, so light/dark (and note tints) just work. */
function appTheme(fontSize: number, minLines?: number) {
  const grow = minLines !== undefined;
  return EditorView.theme({
    "&": { height: grow ? "auto" : "100%", backgroundColor: "transparent", color: "var(--foreground)", fontSize: `${fontSize}px` },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.65" },
    ".cm-content": {
      padding: grow ? "8px 0" : "24px 0",
      caretColor: "var(--foreground)",
      ...(grow ? { minHeight: `calc(${minLines} * 1.65em + 16px)` } : {}),
    },
    ".cm-line": { padding: "0 24px 0 12px" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-foreground)", border: "none", borderRight: "1px solid color-mix(in oklch, var(--foreground) 12%, transparent)" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 20px", minWidth: "3ch" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
    ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--foreground) 5%, transparent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in oklch, var(--ring) 45%, transparent) !important",
    },
    ".cm-fat-cursor": { background: "var(--foreground) !important", color: "var(--background) !important" },
    "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "solid 1px var(--foreground)" },
    ".cm-panels": { backgroundColor: "var(--muted)", color: "var(--foreground)", borderColor: "var(--border)" },
    ".cm-panels input": { color: "var(--foreground)" },
    ".cm-placeholder": { color: "var(--muted-foreground)" },
  });
}

export default function CodeEditor({
  initial, vim: vimOn, onChange, onVimMode, commands, placeholder: hint, fontSize = 14, autoFocus = true, minLines,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const vimSlot = useRef(new Compartment());
  // Only the first vim setup honours `autoFocus`; flipping the switch later always refocuses.
  const firstVimSetup = useRef(true);
  // Callbacks change every render; the editor reads them through a ref.
  const cb = useRef({ onChange, onVimMode, commands });
  useEffect(() => { cb.current = { onChange, onVimMode, commands }; });

  // Create the editor once.
  useEffect(() => {
    defineExCommands();
    const run = (name: keyof EditorCommands) => () => { cb.current.commands[name](false); return true; };

    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        // Open with the caret at the end: this nearly always means "keep writing".
        selection: EditorSelection.cursor(initial.length),
        extensions: [
          // Vim first, so it sees keys before the default keymap does.
          vimSlot.current.of(vimOn ? vim() : []),
          keymap.of([
            { key: "Mod-Enter", run: run("submit") },
            { key: "Mod-s", run: run("write"), preventDefault: true },
            ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
          ]),
          history(),
          lineNumbers(),
          highlightActiveLineGutter(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          markdown(), // includes Enter-continues-lists and Backspace-removes-markers
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          placeholder(hint ?? "Write… (markdown)"),
          appTheme(fontSize, minLines),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
    commandsByView.set(v, () => cb.current.commands);
    view.current = v;
    if (autoFocus) {
      v.focus();
      v.dispatch({ effects: EditorView.scrollIntoView(initial.length, { y: "center" }) });
    }

    return () => {
      v.destroy();
      view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Vim on/off, swapped live.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: vimSlot.current.reconfigure(vimOn ? vim() : []) });
    const cm = getCM(v);
    if (vimOn && cm) {
      // Start in insert mode: you can type straight away (like `A` in vim),
      // and Esc drops to normal mode for anyone who wants it. Kinder to
      // non-vim friends, costs a vim user one keystroke at most.
      Vim.handleKey(cm, "i", "mapping");
      cb.current.onVimMode?.("insert");
      cm.on("vim-mode-change", (e: { mode: VimMode }) => cb.current.onVimMode?.(e.mode));
    }
    if (autoFocus || !firstVimSetup.current) v.focus();
    firstVimSetup.current = false;
  }, [vimOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // `data-vim` lets an enclosing dialog see that Esc here belongs to vim.
  return (
    <div
      ref={host}
      data-vim={vimOn ? "on" : "off"}
      className={minLines !== undefined ? "" : "h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full"}
    />
  );
}
