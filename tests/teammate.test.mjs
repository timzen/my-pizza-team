// Smoke test for TeammateLoop simplified claim/release model
// Run with: node tests/teammate.test.mjs
//
// Verifies the teammate loop source implements the simplified
// claim/release model correctly (poll → claim → work → release → repeat).

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "../src/teammate.ts"),
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

console.log("TeammateLoop claim/release model:");

// ─── Class structure ─────────────────────────────────────────────

test("exports TeammateLoop class", () => {
  assert.ok(src.includes("export class TeammateLoop"));
});

test("imports DaemonClient", () => {
  assert.ok(src.includes('import type { DaemonClient }'));
});

test("does NOT import AgentTransitionResponse (removed)", () => {
  assert.ok(!src.includes("AgentTransitionResponse"));
});

test("does NOT import WorkflowConfig (no local workflow assumptions)", () => {
  assert.ok(!src.includes("WorkflowConfig"));
});

// ─── Simplified claim/release model ─────────────────────────────

test("polls with getNextWork() (not getNextTask)", () => {
  assert.ok(src.includes("this.client.getNextWork()"));
  assert.ok(!src.includes("getNextTask"));
});

test("claims with claimTask (daemon transitions to working state)", () => {
  assert.ok(src.includes("this.client.claimTask("));
});

test("does NOT call transitionTask (removed from model)", () => {
  assert.ok(!src.includes("transitionTask"));
});

test("does NOT track availableTransitions (daemon handles transitions)", () => {
  assert.ok(!src.includes("availableTransitions"));
});

test("releases with releaseTask and passes result", () => {
  assert.ok(src.includes("this.client.releaseTask(taskId, summary)"));
});

test("checks releaseRes.completed for task completion", () => {
  assert.ok(src.includes("releaseRes?.completed"));
});

test("does NOT have autoAdvance method (removed)", () => {
  assert.ok(!src.includes("autoAdvance"));
});

// ─── No workflow state name assumptions ──────────────────────────

test("does NOT hardcode 'in_progress' state name", () => {
  assert.ok(!src.includes('"in_progress"'));
});

test("does NOT hardcode 'review' state name", () => {
  assert.ok(!src.includes('"review"'));
});

test("does NOT hardcode 'todo' state name", () => {
  assert.ok(!src.includes('"todo"'));
});

test("does NOT hardcode 'done' state name", () => {
  assert.ok(!src.includes('"done"'));
});

// ─── NEEDS_INPUT handling ────────────────────────────────────────

test("detects NEEDS_INPUT in agent output", () => {
  assert.ok(src.includes('lastMessage.includes("NEEDS_INPUT:")'));
});

test("releases task after NEEDS_INPUT (no specific transition)", () => {
  const needsInputSection = src.slice(src.indexOf("NEEDS_INPUT:"));
  assert.ok(needsInputSection.includes("releaseTask"));
});

// ─── Comment handling ────────────────────────────────────────────

test("uses postComment (not postMessage)", () => {
  assert.ok(src.includes("this.client.postComment("));
  assert.ok(!src.includes("postMessage"));
});

test("filters comments by 'lead' author", () => {
  assert.ok(src.includes('c.from === "lead"'));
});

// ─── Task prompt includes lead comments ──────────────────────────

test("includes lead comments in task prompt (rework context)", () => {
  assert.ok(src.includes("Comments from Team Lead"));
  assert.ok(src.includes("task.comments?.filter"));
});

// ─── No comment watching or watch loop (removed) ─────────────────

test("does NOT have mid-task comment watching", () => {
  assert.ok(!src.includes("startCommentChecking"));
  assert.ok(!src.includes("stopCommentChecking"));
});

test("relies on normal poll cycle for rediscovery", () => {
  assert.ok(src.includes("this.pollForWork()"));
});

// ─── Pause/resume for pairing ────────────────────────────────────

test("has pause() method", () => {
  assert.ok(src.includes("pause(): void"));
});

test("has resume() method", () => {
  assert.ok(src.includes("resume(): void"));
});

test("pause sends pairing heartbeat", () => {
  const pauseSection = src.slice(src.indexOf("pause(): void"), src.indexOf("pause(): void") + 200);
  assert.ok(pauseSection.includes('"pairing"'));
});

// ─── Token usage reporting ───────────────────────────────────────

test("reports token usage via reportTokenUsage", () => {
  assert.ok(src.includes("this.client.reportTokenUsage("));
});

// ─── Instructions from claim ─────────────────────────────────────

test("uses instructions from claim response", () => {
  assert.ok(src.includes("claim.instructions"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
