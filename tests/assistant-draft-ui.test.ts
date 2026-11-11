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
import {
  assistantDraft, composerSource, createDraftStore, pairComposerKey, placeCursorAtEnd,
  type ComposerDraft, type DraftStore,
} from "../ui/src/lib/assistant-draft.ts";

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
  assert(pair.includes("composerSource(draft, local)"), "PairComposer picks one source: the draft, else its own state");
  assert(!/draft\s*\?\?|\?\?\s*local/.test(pair), "no inline fallback that could pick the text rather than the pair");
  assert(read("components/transcript/AgentTerminal.tsx").includes("key={pairComposerKey(memberId, !!draft)}"),
    "AgentTerminal keys the composer by agent and draft source");
  // The teammate page doesn't pass one.
  assert(!read("pages/TeammatePage.tsx").includes("draft="), "a teammate's watch page keeps a local draft");
  for (const f of ["components/assistant/Composer.tsx", "components/transcript/PairComposer.tsx"]) {
    assert(read(f).includes("placeCursorAtEnd("), `${f} puts the cursor at the end on mount`);
  }
});

// ---------------------------------------------------------------------------
// PairComposer's one source of truth (cases from the story's review task).
//
// The UI has no DOM test harness, so this models what React does with
// PairComposer's state: an instance — and its `useState("")` — lives as long as
// its key is rendered, and a new key is a fresh, empty one. `mount` renders
// AgentTerminal's composer for an agent (shared draft or not) through the same
// `pairComposerKey` + `composerSource` the component uses; `send` follows
// PairComposer's `send` (clear only on success, keep the text and show an
// error on failure).
// ---------------------------------------------------------------------------

/** A screen's composer slot, keeping instances' local state the way React does. */
function composerSlot() {
  let key: string | null = null;
  let local = "";
  let error = "";
  const localPair: ComposerDraft = [local, (v) => { local = v; }];
  return {
    /** Render the composer for `memberId`; `store` = the assistant's shared draft. */
    mount(memberId: string, store?: DraftStore) {
      const next = pairComposerKey(memberId, !!store);
      // A different key is a different instance: React drops the old state.
      if (next !== key) { key = next; local = ""; error = ""; }
      const draft: ComposerDraft | undefined = store ? [store.get(), store.set] : undefined;
      localPair[0] = local;
      const [text, setText] = composerSource(draft, localPair);
      return {
        text,
        error,
        type: (v: string) => setText(v),
        send(ok: boolean) {
          if (!text.trim()) return;
          if (!ok) { error = "Couldn't send"; return; }
          error = "";
          setText("");
        },
      };
    },
    /** The slot renders nothing (dock switched to chat, or not paired). */
    unmount() { key = null; local = ""; error = ""; },
  };
}

test("case 1: the assistant's terminal composer reads and writes the shared draft, across size switches", () => {
  const store = createDraftStore();
  const terminal = composerSlot();
  // Docked chat typed something; going Full page mounts the terminal composer.
  store.set("half");
  let c = terminal.mount("leader", store);
  assertEquals(c.text, "half");
  c.type("half a thought");
  assertEquals(store.get(), "half a thought", "typing in the terminal writes the shared draft");
  // Back to docked (terminal unmounts), the chat edits, then Full page again.
  terminal.unmount();
  store.set("half a thought, edited in chat");
  c = terminal.mount("leader", store);
  assertEquals(c.text, "half a thought, edited in chat");
  // Sending from the terminal clears it for both views.
  c.send(true);
  assertEquals(store.get(), "");
  assertEquals(terminal.mount("leader", store).text, "");
});

test("case 1: an emptied shared draft is empty — never stale local text", () => {
  const store = createDraftStore();
  const stale: ComposerDraft = ["stale local text", () => {}];
  assertEquals(composerSource(["", store.set], stale)[0], "", "\"\" is still the draft");
  // And writes go to the draft, not to local state.
  let localWrites = 0;
  const [, setText] = composerSource([store.get(), store.set], ["", () => { localWrites++; }]);
  setText("typed");
  assertEquals(store.get(), "typed");
  assertEquals(localWrites, 0);
  // The chat clears it (its send) while the terminal is mounted.
  const terminal = composerSlot();
  terminal.mount("leader", store);
  store.set("");
  assertEquals(terminal.mount("leader", store).text, "");
});

test("case 2: a teammate's pair composer keeps local text and never touches the assistant's draft", () => {
  const store = createDraftStore();
  store.set("for the assistant");
  const page = composerSlot();
  const c = page.mount("alice");
  assertEquals(c.text, "", "starts empty, not with the assistant's draft");
  c.type("hi alice");
  assertEquals(page.mount("alice").text, "hi alice", "local text survives a re-render");
  assertEquals(store.get(), "for the assistant", "nothing leaks into the assistant's draft");
  page.mount("alice").send(true);
  assertEquals(page.mount("alice").text, "");
  assertEquals(store.get(), "for the assistant");
});

test("case 3: no text carries between the assistant and a teammate, or between teammates", () => {
  // Keys differ by source and by agent, so each is its own instance.
  assert(pairComposerKey("leader", true) !== pairComposerKey("leader", false), "shared vs local are different composers");
  assert(pairComposerKey("alice", false) !== pairComposerKey("bob", false), "one teammate's composer isn't another's");
  assertEquals(pairComposerKey("alice", false), pairComposerKey("alice", false));

  const store = createDraftStore();
  // One slot reused across views, the worst case for React's state retention.
  const slot = composerSlot();
  slot.mount("leader", store).type("to the assistant");
  assertEquals(slot.mount("alice").text, "", "the assistant's text doesn't show on a teammate's page");
  slot.mount("alice").type("to alice");
  assertEquals(slot.mount("leader", store).text, "to the assistant", "and the teammate's doesn't reach the assistant");
  assertEquals(store.get(), "to the assistant");
  // /teammates/alice → /teammates/bob renders the same tree: a fresh composer.
  slot.mount("alice").type("to alice");
  const bob = slot.mount("bob");
  assertEquals(bob.text, "", "alice's text isn't offered (or sent) to bob");
  // And her failed-send error doesn't follow either.
  slot.mount("alice").type("x");
  slot.mount("alice").send(false);
  assertEquals(slot.mount("alice").error, "Couldn't send");
  assertEquals(slot.mount("bob").error, "");
});

test("case 4: a failed send keeps the text (and, for the assistant, the shared draft)", () => {
  const store = createDraftStore();
  const terminal = composerSlot();
  terminal.mount("leader", store).type("important");
  terminal.mount("leader", store).send(false);
  const c = terminal.mount("leader", store);
  assertEquals(c.text, "important");
  assertEquals(c.error, "Couldn't send");
  assertEquals(store.get(), "important", "still there when the dock goes back to chat");

  const page = composerSlot();
  page.mount("alice").type("retry me");
  page.mount("alice").send(false);
  assertEquals(page.mount("alice").text, "retry me");
  // A retry that works clears text and error.
  page.mount("alice").send(true);
  assertEquals(page.mount("alice").text, "");
  assertEquals(page.mount("alice").error, "");
});

test("PairComposer only clears on a successful send, as modelled above", () => {
  const pair = read("components/transcript/PairComposer.tsx");
  const send = pair.slice(pair.indexOf("const send = async"), pair.indexOf("const editor ="));
  const fail = send.indexOf("if (!res.success)");
  const clear = send.indexOf('setText("")');
  assert(fail >= 0 && clear > fail, "the failure branch returns before the text is cleared");
  assert(/if \(!res\.success\) \{ setError\([^}]*\); return; \}/.test(send), "a failure sets the error and returns, keeping the text");
});
