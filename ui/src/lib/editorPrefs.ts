/**
 * editorPrefs.ts — The small, pure rules around the big editor
 * (`components/ui/full-editor.tsx`): whether vim mode is on, and when a
 * composer's draft is really the `/editor` command.
 *
 * Kept out of the component so they're testable without a browser
 * (tests/editor-prefs.test.ts). Storage is passed in for the same reason.
 */

/** localStorage key for the vim toggle. */
export const VIM_PREF_KEY = "mpt.editor.vim";

/** The minimal slice of `Storage` these helpers use. */
export type PrefStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Is vim mode on? **On by default** — only an explicit "off" turns it off, so a
 * missing or unreadable preference keeps vim (docs/DESIGN.md "The Big Editor").
 */
export function readVimPref(storage: PrefStorage | undefined): boolean {
  try {
    return storage?.getItem(VIM_PREF_KEY) !== "off";
  } catch {
    return true; // storage blocked (private mode, sandboxed iframe)
  }
}

/** Remember the vim toggle. Failures are ignored: it's a preference, not data. */
export function writeVimPref(storage: PrefStorage | undefined, on: boolean): void {
  try {
    storage?.setItem(VIM_PREF_KEY, on ? "on" : "off");
  } catch { /* ignore */ }
}

/**
 * If `draft` is the `/editor` command, the text to open the editor with;
 * otherwise `null`. `/editor` alone opens empty; `/editor some text` opens with
 * "some text", so you can start a thought inline and move it into the editor.
 */
export function editorCommandSeed(draft: string): string | null {
  const m = /^\s*\/editor(?:\s+([\s\S]*))?$/.exec(draft);
  if (!m) return null;
  return (m[1] ?? "").trimEnd();
}
