// Behavioral tests for session stats (context fill + session cost)
// Run with: node --experimental-strip-types tests/session-stats.test.mjs
//
// The Team tab shows each teammate's context-window fill and session cost —
// Pi's footer numbers. This checks the arithmetic: the cost walks every entry
// Pi's footer counts (so compaction never lowers it), and unknown context stays
// unknown rather than becoming 0%. See src/runtime/session-stats.ts.

import * as assert from "node:assert";
import { sessionCost, sessionStats, readSessionStats, sameStats, modelInfo } from "../src/runtime/session-stats.ts";

let passed = 0;
let failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}: ${e.message}`); failed++; }
}

const msg = (role, cost) => ({ type: "message", message: { role, usage: cost === undefined ? undefined : { cost: { total: cost } } } });

console.log("sessionCost:");

test("sums assistant messages, tool results, and usage/compaction/branch entries", () => {
  const cost = sessionCost([
    msg("user"),
    msg("assistant", 0.25),
    msg("toolResult", 0.01),
    { type: "usage", usage: { cost: { total: 0.1 } } },
    { type: "compaction", usage: { cost: { total: 0.05 } } },
    { type: "branch_summary", usage: { cost: { total: 0.02 } } },
    { type: "model_change" },
  ]);
  assert.ok(Math.abs(cost - 0.43) < 1e-9, `got ${cost}`);
});

test("ignores entries without a usable cost, and an empty session is $0", () => {
  assert.strictEqual(sessionCost([msg("assistant"), msg("assistant", NaN), { type: "compaction" }]), 0);
  assert.strictEqual(sessionCost(undefined), 0);
});

console.log("\nsessionStats:");

test("passes Pi's context usage through", () => {
  const s = sessionStats({ tokens: 84000, contextWindow: 200000, percent: 42 }, [msg("assistant", 1.5)]);
  assert.deepStrictEqual(s, { contextTokens: 84000, contextWindow: 200000, contextPercent: 42, costUsd: 1.5, model: null });
});

test("unknown context (just after compaction, or no model) stays null — never 0%", () => {
  assert.deepStrictEqual(
    sessionStats({ tokens: null, contextWindow: 200000, percent: null }, []),
    { contextTokens: null, contextWindow: 200000, contextPercent: null, costUsd: 0, model: null },
  );
  assert.deepStrictEqual(sessionStats(undefined, undefined), { contextTokens: null, contextWindow: null, contextPercent: null, costUsd: 0, model: null });
});

test("readSessionStats never throws on a torn-down context", () => {
  const broken = { getContextUsage: () => { throw new Error("stale ctx"); }, sessionManager: { getEntries: () => { throw new Error("stale"); } } };
  assert.deepStrictEqual(readSessionStats(broken), { contextTokens: null, contextWindow: null, contextPercent: null, costUsd: 0, model: null });
  assert.deepStrictEqual(readSessionStats({}), { contextTokens: null, contextWindow: null, contextPercent: null, costUsd: 0, model: null });
});

test("sameStats spots an unchanged report (a model switch is a change)", () => {
  const opus = { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" };
  const a = { contextTokens: 1, contextWindow: 2, contextPercent: 50, costUsd: 0.1, model: opus };
  assert.strictEqual(sameStats(null, a), false);
  assert.strictEqual(sameStats(a, { ...a, model: { ...opus } }), true);
  assert.strictEqual(sameStats(a, { ...a, costUsd: 0.2 }), false);
  assert.strictEqual(sameStats(a, { ...a, model: { ...opus, id: "claude-sonnet-4-5" } }), false);
  assert.strictEqual(sameStats(a, { ...a, model: null }), false);
});

console.log("\nmodel:");

test("the model comes from ctx.model, or the override a model_select carries", () => {
  const ctx = { model: { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic", reasoning: true } };
  assert.deepStrictEqual(readSessionStats(ctx).model, { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" });
  assert.deepStrictEqual(readSessionStats(ctx, { id: "gpt-5", name: "GPT-5", provider: "openai" }).model, { id: "gpt-5", name: "GPT-5", provider: "openai" });
});

test("modelInfo: name falls back to the id; no id means no model", () => {
  assert.deepStrictEqual(modelInfo({ id: "local-llama" }), { id: "local-llama", name: "local-llama", provider: "" });
  assert.strictEqual(modelInfo({ name: "Nameless" }), null);
  assert.strictEqual(modelInfo(undefined), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
