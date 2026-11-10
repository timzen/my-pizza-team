/**
 * tests/assistant-draft-ui.test.ts — The assistant's shared unsent draft
 * (ui/src/lib/assistant-draft.ts, docs/DESIGN.md "Assistant Chat Model").
 *
 * Docked the assistant is the chat (`Composer`), at Full page the terminal
 * (`PairComposer`); switching size swaps one for the other. The rules under
 * test: one draft both read and write, so it survives the switch; sending from
 * either clears it; the carried-over text puts the cursor at the end; and only
 * the assistant shares it — a teammate's pair composer keeps its own.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import { assistantDraft, createDraftStore, placeCursorAtEnd } from "../ui/src/lib/assistant-draft.ts";

const read = (p: string) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf-8");

test("the draft survives a size switch: the other composer reads what this one wrote", () => {
  const store = createDraftStore();
  // The chat's composer (docked) types...
  const chat = { get: store.get, set: store.set };
  chat.set("half a thought");
  // ...the dock goes Full page: the chat unmounts, the terminal's composer mounts.
  const terminal = { get: store.get, set: store.set };
  assertEquals(terminal.get(), "half a thought");
  terminal.set("half a thought, finished");
  // And back to docked.
  assertEquals(chat.get(), "half a thought, finished");
});

test("sending from either composer clears it", () => {
  const store = createDraftStore();
  store.set("ship it");
  store.set(""); // the chat's send (or the terminal's, after the POST succeeds)
  assertEquals(store.get(), "");
});

test("subscribers hear real changes only, and can unsubscribe", () => {
  const store = createDraftStore();
  let calls = 0;
  const off = store.subscribe(() => { calls++; });
  store.set("a");
  store.set("a");
  store.set("ab");
  assertEquals(calls, 2);
  off();
  store.set("abc");
  assertEquals(calls, 2);
});

test("the app's store starts empty", () => {
  assertEquals(assistantDraft.get(), "");
});

test("placeCursorAtEnd puts the cursor after the carried-over text", () => {
  let range: [number, number] | null = null;
  placeCursorAtEnd({ value: "hello", setSelectionRange: (s, e) => { range = [s, e]; } });
  assertEquals(range, [5, 5]);
});

test("both assistant composers use the shared draft; a teammate's pair composer keeps its own", () => {
  assert(read("components/assistant/AssistantChat.tsx").includes("useAssistantDraft()"), "the chat reads the shared draft");
  assert(!/useState\(""\)/.test(read("components/assistant/AssistantChat.tsx")), "the chat keeps no local draft");
  assert(read("components/assistant/AssistantTerminal.tsx").includes("draft={draft}"), "the terminal passes it down");
  assert(read("components/transcript/AgentTerminal.tsx").includes("draft={draft}"), "AgentTerminal hands it to PairComposer");
  const pair = read("components/transcript/PairComposer.tsx");
  assert(pair.includes("draft ?? local"), "PairComposer falls back to its own state");
  // The teammate page doesn't pass one.
  assert(!read("pages/TeammatePage.tsx").includes("draft="), "a teammate's watch page keeps a local draft");
  for (const f of ["components/assistant/Composer.tsx", "components/transcript/PairComposer.tsx"]) {
    assert(read(f).includes("placeCursorAtEnd("), `${f} puts the cursor at the end on mount`);
  }
});
