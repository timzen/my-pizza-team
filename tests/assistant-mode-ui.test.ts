/**
 * tests/assistant-mode-ui.test.ts — The assistant's chat/terminal switch in the
 * UI (ui/src/lib/assistant-mode.ts, docs/DESIGN.md "Assistant Chat Model").
 *
 * The rule under test: terminal mode is *exactly* the teammate watch/pair view —
 * one shared component (AgentTerminal), not an assistant-only lookalike — and
 * the dock and phone pick it from the live mode, so a switch needs no reload.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import {
  assistantTerminalTarget, assistantView, DEFAULT_LEADER_ID, resolveAssistantChatMode,
} from "../ui/src/lib/assistant-mode.ts";
import { resolveAssistantChatMode as sharedResolve } from "../shared/types.ts";
import { LEADER_MEMBER_NAME } from "../daemon/store.ts";

const read = (p: string) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf-8");

test("the UI resolves the reported mode exactly as the daemon does", () => {
  for (const raw of [undefined, null, "chat", "terminal", "bogus", 3]) {
    assertEquals(resolveAssistantChatMode(raw), sharedResolve({ assistant: { chatMode: raw as never } }), String(raw));
  }
});

test("assistantView: terminal only in terminal mode, on the live session", () => {
  assertEquals(assistantView("terminal", null), "terminal");
  assertEquals(assistantView("chat", null), "chat");
  // Before the first /api/status answer: the default.
  assertEquals(assistantView(null, null), "chat");
  // An earlier session is the chat record (a transcript has no backfill).
  assertEquals(assistantView("terminal", "sess-1"), "chat");
});

test("the terminal watches the online leader, else the id the leader registers with", () => {
  assertEquals(assistantTerminalTarget({ id: "leader" }), "leader");
  assertEquals(assistantTerminalTarget(null), DEFAULT_LEADER_ID);
  assertEquals(DEFAULT_LEADER_ID, LEADER_MEMBER_NAME);
});

test("dock and phone render the pane that switches on the live mode", () => {
  for (const f of ["components/dock/SideDock.tsx", "mobile/MobileChat.tsx"]) {
    const src = read(f);
    assertEquals(src.includes("<AssistantPane "), true, f);
    assertEquals(src.includes("<AssistantChat "), false, f);
  }
  const pane = read("components/assistant/AssistantPane.tsx");
  assertEquals(pane.includes("useAssistantChatMode()"), true);
  assertEquals(pane.includes("<AssistantTerminal "), true);
  assertEquals(pane.includes("<AssistantChat "), true);
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
