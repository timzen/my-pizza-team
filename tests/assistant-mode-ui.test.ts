/**
 * tests/assistant-mode-ui.test.ts — The assistant's chat/terminal switch in the
 * UI (ui/src/lib/assistant-mode.ts, docs/DESIGN.md "Assistant Chat Model").
 *
 * The rules under test: the dock's size picks the view — docked is the chat,
 * Full page is the terminal — and the terminal is *exactly* the teammate
 * watch/pair view (one shared component, AgentTerminal, not an assistant-only
 * lookalike). The retired `assistant.chatMode` setting is gone from the UI.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { assistantTerminalTarget, assistantView, DEFAULT_LEADER_ID } from "../ui/src/lib/assistant-mode.ts";
import { dockFillsCenter } from "../ui/src/lib/dock-layout.ts";
import { LEADER_MEMBER_NAME } from "../daemon/store.ts";

const read = (p: string) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf-8");

test("assistantView: the terminal at full page on the live session, else the chat", () => {
  assertEquals(assistantView(true, null), "terminal");
  assertEquals(assistantView(false, null), "chat");
  // An earlier session is the chat record, even at full page (a transcript backfills only the current one).
  assertEquals(assistantView(true, "sess-1"), "chat");
  assertEquals(assistantView(false, "sess-1"), "chat");
});

test("assistantView over the dock's modes: only lg+ Full page is the terminal", () => {
  for (const mode of ["expanded", "collapsed", "full"] as const) {
    for (const isDesktop of [true, false]) {
      const want = mode === "full" && isDesktop ? "terminal" : "chat";
      assertEquals(assistantView(dockFillsCenter(mode, isDesktop), null), want, `${mode} desktop=${isDesktop}`);
    }
  }
});

test("the terminal watches the online leader, else the id the leader registers with", () => {
  assertEquals(assistantTerminalTarget({ id: "leader" }), "leader");
  assertEquals(assistantTerminalTarget(null), DEFAULT_LEADER_ID);
  assertEquals(DEFAULT_LEADER_ID, LEADER_MEMBER_NAME);
});

test("the dock passes its full-page state; the phone never does; nothing reads a chat mode", () => {
  for (const f of ["components/dock/SideDock.tsx", "mobile/MobileChat.tsx"]) {
    const src = read(f);
    assertEquals(src.includes("<AssistantPane "), true, f);
    assertEquals(src.includes("<AssistantChat "), false, f);
  }
  assertEquals(/<AssistantPane [^>]*fullPage=\{full\}/.test(read("components/dock/SideDock.tsx")), true);
  assertEquals(read("mobile/MobileChat.tsx").includes("fullPage"), false);
  const pane = read("components/assistant/AssistantPane.tsx");
  assertEquals(pane.includes("assistantView(fullPage, viewingId)"), true);
  assertEquals(pane.includes("<AssistantTerminal "), true);
  assertEquals(pane.includes("<AssistantChat "), true);
  for (const f of ["hooks/useFeatures.ts", "components/config/AssistantSettings.tsx", "components/config/GeneralTab.tsx", "lib/config-draft.ts", "components/assistant/AssistantPane.tsx"]) {
    assertEquals(/chatMode|ChatMode/.test(read(f)), false, f);
  }
});

test("one code path: the assistant terminal and the teammate page share AgentTerminal + useTranscriptStream", () => {
  const terminal = read("components/assistant/AssistantTerminal.tsx");
  const teammate = read("pages/TeammatePage.tsx");
  for (const [name, src] of [["AssistantTerminal", terminal], ["TeammatePage", teammate]] as const) {
    assertEquals(src.includes("useTranscriptStream("), true, name);
    assertEquals(src.includes("<AgentTerminal"), true, name);
    // Neither renders the transcript or the composer itself.
    assertEquals(/<TranscriptView|<PairComposer/.test(src), false, name);
  }
  const shared = read("components/transcript/AgentTerminal.tsx");
  assertEquals(shared.includes("<TranscriptView"), true);
  assertEquals(shared.includes("<PairComposer"), true);
});
