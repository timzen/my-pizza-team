// Behavioral tests for run usage summarization
// Run with: node --experimental-strip-types tests/usage.test.mjs
//
// Every agent run's usage is reported to the daemon's ledger; this checks the
// arithmetic — above all that cache tokens are counted (they were dropped, so a
// real Opus run showed "3 input tokens"). See src/usage.ts.

import * as assert from "node:assert";
import { summarizeRun, hasUsage } from "../src/usage.ts";

let passed = 0;
let failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}: ${e.message}`); failed++; }
}

const assistant = (usage, text, model = "opus") => ({ role: "assistant", model, usage, content: text ? [{ type: "text", text }] : [] });

console.log("summarizeRun:");

test("sums every assistant message, cache tokens included", () => {
  const u = summarizeRun([
    { role: "user", content: "go" },
    assistant({ input: 3, output: 100, cacheRead: 40000, cacheWrite: 2000, cost: { total: 0.2 } }),
    { role: "toolResult", content: "..." },
    assistant({ input: 5, output: 50, cacheRead: 41000, cacheWrite: 0, cost: { total: 0.05 } }, "Done."),
  ]);
  assert.strictEqual(u.inputTokens, 8);
  assert.strictEqual(u.outputTokens, 150);
  assert.strictEqual(u.cacheReadTokens, 81000);
  assert.strictEqual(u.cacheWriteTokens, 2000);
  assert.ok(Math.abs(u.costUsd - 0.25) < 1e-9);
});

test("lastText is the last assistant prose; model is the latest seen", () => {
  const u = summarizeRun([
    assistant({ input: 1, output: 1 }, "first", "m-old"),
    assistant({ input: 1, output: 1 }, "", "m-new"),
    assistant({ input: 1, output: 1 }, "final summary", "m-new"),
  ]);
  assert.strictEqual(u.lastText, "final summary");
  assert.strictEqual(u.model, "m-new");
});

test("missing usage fields and empty runs are zeros, not NaN", () => {
  const u = summarizeRun([assistant({ output: 7 }), assistant(undefined, "hi")]);
  assert.strictEqual(u.inputTokens, 0);
  assert.strictEqual(u.outputTokens, 7);
  assert.strictEqual(u.cacheReadTokens, 0);
  const empty = summarizeRun(undefined);
  assert.strictEqual(hasUsage(empty), false);
  assert.strictEqual(hasUsage(u), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
