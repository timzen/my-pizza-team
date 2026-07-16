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
  assert.ok(src.includes("this.client.releaseTask(taskId, fullMessage)"));
});

test("posts the full completion message as a comment (not a truncated slice)", () => {
  // The [done] comment is for humans; it must not be cut off mid-sentence.
  assert.ok(!src.includes("lastMessage.slice(0, 500)"));
  assert.ok(src.includes("const fullMessage = lastMessage.trim()"));
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

// ─── Completion → release ───────────────────────────────────

test("releases the task on agent completion (no NEEDS_INPUT protocol)", () => {
  // The teammate no longer parses agent output for a NEEDS_INPUT sentinel.
  // It always releases on completion; the daemon advances state and the lead
  // requests rework by re-adding comments and moving the task back.
  assert.ok(!src.includes("NEEDS_INPUT"));
  assert.ok(src.includes("handleAgentComplete"));
  const completeSection = src.slice(src.indexOf("handleAgentComplete"));
  assert.ok(completeSection.includes("releaseTask"));
});

// ─── Comment handling ────────────────────────────────────────────

test("uses postComment (not postMessage)", () => {
  assert.ok(src.includes("this.client.postComment("));
  assert.ok(!src.includes("postMessage"));
});

test("does not filter or assemble lead comments itself (daemon owns the prompt)", () => {
  // Lead comments are now folded into the daemon-assembled prompt; the
  // teammate never inspects comment authors or builds rework context locally.
  assert.ok(!src.includes('c.from === "lead"'));
  assert.ok(!src.includes("Comments from Team Lead"));
  assert.ok(!src.includes("task.comments?.filter"));
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

// ─── Prompt from claim ───────────────────────────────────────────

test("executes the daemon-assembled prompt from the claim response", () => {
  // The daemon owns the full prompt; the teammate delivers claim.prompt
  // verbatim rather than augmenting local instructions.
  assert.ok(src.includes("claim.prompt"));
});

test("dismisses itself when next-work returns dismiss (assigned-story exhausted)", () => {
  assert.ok(src.includes("response.dismiss"));
  assert.ok(src.match(/response\.dismiss[\s\S]*?onDismissed/));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
