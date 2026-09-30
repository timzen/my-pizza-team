/**
 * tests/editor-prefs.test.ts — The big editor's small rules
 * (ui/src/lib/editorPrefs.ts): vim mode is on unless explicitly turned off
 * (and survives broken storage), and when a composer draft is the `/editor`
 * command rather than a message.
 */

import { assertEquals } from "@std/assert";
import { editorCommandSeed, readVimPref, VIM_PREF_KEY, writeVimPref } from "../ui/src/lib/editorPrefs.ts";

/** An in-memory Storage slice. */
function memStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

Deno.test("vim mode is on by default", () => {
  assertEquals(readVimPref(memStorage()), true);
  assertEquals(readVimPref(undefined), true);
});

Deno.test("vim mode: only an explicit off turns it off", () => {
  assertEquals(readVimPref(memStorage({ [VIM_PREF_KEY]: "off" })), false);
  assertEquals(readVimPref(memStorage({ [VIM_PREF_KEY]: "on" })), true);
  assertEquals(readVimPref(memStorage({ [VIM_PREF_KEY]: "garbage" })), true);
});

Deno.test("vim mode: the toggle round-trips", () => {
  const s = memStorage();
  writeVimPref(s, false);
  assertEquals(readVimPref(s), false);
  writeVimPref(s, true);
  assertEquals(readVimPref(s), true);
});

Deno.test("vim mode: blocked storage falls back to on and never throws", () => {
  const blocked = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("SecurityError"); },
  };
  assertEquals(readVimPref(blocked), true);
  writeVimPref(blocked, false); // must not throw
});

Deno.test("/editor alone opens an empty editor", () => {
  assertEquals(editorCommandSeed("/editor"), "");
  assertEquals(editorCommandSeed("  /editor  "), "");
});

Deno.test("/editor carries the rest of the draft in", () => {
  assertEquals(editorCommandSeed("/editor fix the login bug"), "fix the login bug");
  assertEquals(editorCommandSeed("/editor line one\nline two\n"), "line one\nline two");
});

Deno.test("anything else is a message, not the command", () => {
  assertEquals(editorCommandSeed("please open /editor"), null);
  assertEquals(editorCommandSeed("/editorial"), null);
  assertEquals(editorCommandSeed("/edit"), null);
  assertEquals(editorCommandSeed(""), null);
});
