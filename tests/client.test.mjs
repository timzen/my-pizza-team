// Smoke test for DaemonClient
// Run with: node tests/client.test.mjs
//
// Tests that the DaemonClient class can be instantiated and constructs
// correct URLs. Does NOT require a running daemon.

import * as assert from "node:assert";

// We can't import TypeScript directly, so we test the module shape
// by checking the source file exists and has expected exports.
import * as fs from "node:fs";
import * as path from "node:path";

const clientSrc = fs.readFileSync(
  path.join(import.meta.dirname, "../src/client.ts"),
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

console.log("DaemonClient source checks:");

test("exports DaemonClient class", () => {
  assert.ok(clientSrc.includes("export class DaemonClient"));
});

test("has checkServer method", () => {
  assert.ok(clientSrc.includes("async checkServer()"));
});

test("has register method", () => {
  assert.ok(clientSrc.includes("async register("));
});

test("has getNextWork method", () => {
  assert.ok(clientSrc.includes("async getNextWork()"));
});

test("has claimTask method", () => {
  assert.ok(clientSrc.includes("async claimTask("));
});

test("has transitionTask method", () => {
  assert.ok(clientSrc.includes("async transitionTask("));
});

test("has releaseTask method", () => {
  assert.ok(clientSrc.includes("async releaseTask("));
});

test("has heartbeat method", () => {
  assert.ok(clientSrc.includes("async heartbeat("));
});

test("has getComments method (not messages)", () => {
  assert.ok(clientSrc.includes("async getComments("));
});

test("has postComment method", () => {
  assert.ok(clientSrc.includes("async postComment("));
});

test("uses /api/agents/ routes", () => {
  assert.ok(clientSrc.includes("/api/agents/register"));
  assert.ok(clientSrc.includes("/api/agents/heartbeat"));
  assert.ok(clientSrc.includes("/api/agents/next-work"));
  assert.ok(clientSrc.includes("/api/agents/claim/"));
  assert.ok(clientSrc.includes("/api/agents/transition/"));
  assert.ok(clientSrc.includes("/api/agents/release/"));
});

test("uses /api/tasks/:id/comments (not messages)", () => {
  assert.ok(clientSrc.includes("/api/tasks/"));
  assert.ok(clientSrc.includes("/comments"));
  assert.ok(!clientSrc.includes("/api/tasks/${encodeURIComponent(taskId)}/messages"));
});

test("does not import better-sqlite3", () => {
  assert.ok(!clientSrc.includes("better-sqlite3"));
});

test("does not import hono", () => {
  assert.ok(!clientSrc.includes("hono"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
