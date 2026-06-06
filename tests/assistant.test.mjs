// Smoke test for AssistantLoop
// Run with: node tests/assistant.test.mjs
//
// Verifies the assistant loop source uses the daemon API correctly
// and doesn't have any local store/filesystem dependencies.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "../src/assistant.ts"),
  "utf-8"
);

const indexSrc = fs.readFileSync(
  path.join(import.meta.dirname, "../src/index.ts"),
  "utf-8"
);

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

console.log("AssistantLoop source checks:");

// ─── Class structure ─────────────────────────────────────────────

test("exports AssistantLoop class", () => {
  assert.ok(src.includes("export class AssistantLoop"));
});

test("imports only DaemonClient (no Store, no fs)", () => {
  assert.ok(src.includes('import type { DaemonClient }'));
  assert.ok(!src.includes("Store"));
  assert.ok(!src.includes("node:fs"));
  assert.ok(!src.includes("better-sqlite3"));
});

// ─── Daemon API usage ────────────────────────────────────────────

test("polls with getNextQueueItem()", () => {
  assert.ok(src.includes("this.client.getNextQueueItem()"));
});

test("claims with claimQueueItem()", () => {
  assert.ok(src.includes("this.client.claimQueueItem("));
});

test("completes with completeQueueItem()", () => {
  assert.ok(src.includes("this.client.completeQueueItem("));
});

test("sends heartbeat via client.heartbeat()", () => {
  assert.ok(src.includes("this.client.heartbeat("));
});

test("reports both success and failure states", () => {
  assert.ok(src.includes("completeQueueItem(itemId, summary, false)"));
  assert.ok(src.includes("completeQueueItem(itemId, error, true)"));
});

// ─── Execution ───────────────────────────────────────────────────

test("sends prompt via pi.sendUserMessage", () => {
  assert.ok(src.includes("this.pi.sendUserMessage("));
});

test("uses deliverAs: followUp", () => {
  assert.ok(src.includes('deliverAs: "followUp"'));
});

test("prompt includes 'team assistant' role context", () => {
  assert.ok(src.includes("You are the team assistant"));
});

// ─── Lifecycle methods ───────────────────────────────────────────

test("has start() method", () => {
  assert.ok(src.includes("async start()"));
});

test("has stop() method", () => {
  assert.ok(src.includes("stop(): void"));
});

test("has handleAgentComplete() method", () => {
  assert.ok(src.includes("async handleAgentComplete("));
});

test("has handleAgentError() method", () => {
  assert.ok(src.includes("async handleAgentError("));
});

test("has onItemComplete callback", () => {
  assert.ok(src.includes("onItemComplete"));
});

test("has isWorking getter", () => {
  assert.ok(src.includes("get isWorking()"));
});

// ─── Integration in index.ts ─────────────────────────────────────

console.log("\nAssistant setup in index.ts:");

test("registers with daemon on startup", () => {
  assert.ok(indexSrc.includes('client.register({ name: "assistant"'));
});

test("deregisters on session_shutdown", () => {
  assert.ok(indexSrc.includes("client.deregister()"));
});

test("fetches categories from daemon config", () => {
  assert.ok(indexSrc.includes("client.getConfig()"));
  assert.ok(indexSrc.includes("config.categories"));
});

test("registers assistant tools with categories", () => {
  assert.ok(indexSrc.includes("registerAssistantTools(pi, client, categories)"));
});

test("does NOT import Store for assistant", () => {
  // The assistant setup function itself should not reference Store
  const startIdx = indexSrc.indexOf("async function setupAssistant");
  const assistantFn = indexSrc.slice(startIdx);
  assert.ok(!assistantFn.includes("Store"));
  assert.ok(!assistantFn.includes("loadFromDisk"));
});

test("does NOT read local config.json for assistant", () => {
  const startIdx = indexSrc.indexOf("async function setupAssistant");
  const assistantFn = indexSrc.slice(startIdx);
  assert.ok(!assistantFn.includes("config.json"));
  assert.ok(!assistantFn.includes("readFileSync"));
});

test("listens for agent_end event", () => {
  const assistantSection = indexSrc.slice(indexSrc.indexOf("setupAssistant"));
  assert.ok(assistantSection.includes('pi.on("agent_end"'));
});

test("tracks completed items for widget", () => {
  const assistantSection = indexSrc.slice(indexSrc.indexOf("setupAssistant"));
  assert.ok(assistantSection.includes("completedItems"));
  assert.ok(assistantSection.includes("onItemComplete"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
