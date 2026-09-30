/**
 * tests/team-status.test.ts — How the Team tab words a teammate's status and
 * session (ui/src/lib/team.ts): status labels (the icon's tooltip — status is
 * shape, not color), compact token counts, the context label (percent when
 * known, tokens otherwise, "?" just after compaction — never a fake 0%), the
 * model tooltip, and session cost.
 */

import { assertEquals } from "@std/assert";
import { formatContext, formatCost, formatTokens, modelTitle, statusLabel, type TeammateSession } from "../ui/src/lib/team.ts";

const session = (over: Partial<TeammateSession>): TeammateSession => ({
  contextTokens: null, contextWindow: null, contextPercent: null, costUsd: 0, model: null, at: 0, ...over,
});

Deno.test("statusLabel names each status; anything unknown reads as lost contact", () => {
  assertEquals(statusLabel("pairing"), "Pairing with you");
  assertEquals(statusLabel("idle"), "Waiting for work");
  assertEquals(statusLabel("working"), "Working");
  assertEquals(statusLabel("offline"), "Lost contact");
  assertEquals(statusLabel("???"), "Lost contact");
});

Deno.test("formatTokens is compact", () => {
  assertEquals(formatTokens(950), "950");
  assertEquals(formatTokens(1000), "1k");
  assertEquals(formatTokens(12_345), "12k");
  assertEquals(formatTokens(8_400), "8.4k");
  assertEquals(formatTokens(84_000), "84k");
  assertEquals(formatTokens(1_200_000), "1.2M");
  assertEquals(formatTokens(2_000_000), "2M");
});

Deno.test("formatContext: the percentage when known, tokens in the tooltip", () => {
  const c = formatContext(session({ contextTokens: 84_000, contextWindow: 200_000, contextPercent: 42 }));
  assertEquals(c?.label, "42%");
  assertEquals(c?.title, "Context: 84,000 of 200,000 tokens (42%)");
  assertEquals(formatContext(session({ contextTokens: 900, contextWindow: 200_000, contextPercent: 0.45 }))?.label, "<1%");
});

Deno.test("formatContext: tokens without a window, '?' after compaction, nothing when unreported", () => {
  assertEquals(formatContext(session({ contextTokens: 84_000 }))?.label, "84k");
  assertEquals(formatContext(session({ contextWindow: 200_000 }))?.label, "?");
  assertEquals(formatContext(session({})), null);
  assertEquals(formatContext(null), null);
  assertEquals(formatContext(undefined), null);
});

Deno.test("formatCost", () => {
  assertEquals(formatCost(0), "$0.00");
  assertEquals(formatCost(0.004), "<$0.01");
  assertEquals(formatCost(1.254), "$1.25");
  assertEquals(formatCost(12.4), "$12.40");
});

Deno.test("modelTitle is provider/id, or just the id", () => {
  assertEquals(modelTitle({ id: "claude-opus-4-5", provider: "anthropic" }), "Model: anthropic/claude-opus-4-5");
  assertEquals(modelTitle({ id: "local-llama", provider: "" }), "Model: local-llama");
});
