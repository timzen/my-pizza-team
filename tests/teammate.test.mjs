// Smoke test for TeammateLoop multi-transition ownership model
// Run with: node tests/teammate.test.mjs
//
// Verifies the teammate loop source implements the multi-transition
// ownership model correctly (claim → transition → transition → release).

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

console.log("TeammateLoop multi-transition model:");

// ─── Class structure ─────────────────────────────────────────────

test("exports TeammateLoop class", () => {
  assert.ok(src.includes("export class TeammateLoop"));
});

test("imports DaemonClient and AgentTransitionResponse", () => {
  assert.ok(src.includes('import type { DaemonClient, AgentTransitionResponse }'));
});

test("does NOT import WorkflowConfig (no local workflow assumptions)", () => {
  assert.ok(!src.includes("WorkflowConfig"));
});

// ─── Multi-transition ownership model ────────────────────────────

test("tracks availableTransitions as instance state", () => {
  assert.ok(src.includes("private availableTransitions: Array<{ state: string; permission: string }>"));
});

test("polls with getNextWork() (not getNextTask)", () => {
  assert.ok(src.includes("this.client.getNextWork()"));
  assert.ok(!src.includes("getNextTask"));
});

test("claims with claimTask (ownership only)", () => {
  assert.ok(src.includes("this.client.claimTask("));
});

test("uses availableTransitions from claim response", () => {
  assert.ok(src.includes("claim.availableTransitions || response.task.availableTransitions"));
});

test("immediately transitions to first working state after claim", () => {
  // After claiming, should find first transition and call transitionTask
  assert.ok(src.includes("const firstTransition = this.availableTransitions[0]"));
  assert.ok(src.includes("this.client.transitionTask(response.task.id, firstTransition.state)"));
});

test("transitions with transitionTask (not updateStatus)", () => {
  assert.ok(src.includes("this.client.transitionTask("));
  assert.ok(!src.includes("updateStatus"));
});

test("releases with releaseTask when no more transitions", () => {
  assert.ok(src.includes("this.client.releaseTask("));
});

test("handles auto-release (done state) from transition response", () => {
  assert.ok(src.includes("transRes.released"));
});

test("has autoAdvance method for pass-through states", () => {
  assert.ok(src.includes("private async autoAdvance("));
});

test("autoAdvance loops through transitions until instructions or empty", () => {
  assert.ok(src.includes("while (this.availableTransitions.length > 0)"));
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

test("does NOT have resolveTeammateTransition (old method)", () => {
  assert.ok(!src.includes("resolveTeammateTransition"));
});

test("does NOT have setWorkflow method (no local workflow)", () => {
  assert.ok(!src.includes("setWorkflow"));
});

// ─── NEEDS_INPUT handling ────────────────────────────────────────

test("detects NEEDS_INPUT in agent output", () => {
  assert.ok(src.includes('lastMessage.includes("NEEDS_INPUT:")'));
});

test("finds blocked transition by name heuristic (needs_input/blocked)", () => {
  assert.ok(src.includes('t.state.includes("needs_input") || t.state.includes("blocked")'));
});

test("releases task after NEEDS_INPUT", () => {
  // After NEEDS_INPUT, should release
  const needsInputSection = src.slice(src.indexOf("NEEDS_INPUT:"));
  assert.ok(needsInputSection.includes("releaseTask"));
});

// ─── Comment checking ────────────────────────────────────────────

test("uses getComments (not getMessages)", () => {
  assert.ok(src.includes("this.client.getComments("));
  assert.ok(!src.includes("getMessages"));
});

test("uses postComment (not postMessage)", () => {
  assert.ok(src.includes("this.client.postComment("));
  assert.ok(!src.includes("postMessage"));
});

test("checks for lead comments while working", () => {
  assert.ok(src.includes("startCommentChecking"));
  assert.ok(src.includes("stopCommentChecking"));
});

test("filters comments by 'lead' author", () => {
  assert.ok(src.includes('c.from === "lead"'));
});

// ─── Task prompt includes lead comments ──────────────────────────

test("includes lead comments in task prompt (rework context)", () => {
  assert.ok(src.includes("Comments from Team Lead"));
  assert.ok(src.includes("task.comments?.filter"));
});

// ─── Watch loop ──────────────────────────────────────────────────

test("has watch loop for released tasks", () => {
  assert.ok(src.includes("startWatchLoop"));
  assert.ok(src.includes("watchedTasks"));
});

test("watch loop triggers immediate poll on new lead comments", () => {
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

// ─── Transition instructions delivery ────────────────────────────

test("delivers transition instructions from initial transition", () => {
  assert.ok(src.includes("transRes.instructions"));
  assert.ok(src.includes("await this.executeTask(response.task, transRes.instructions)"));
});

test("delivers transition instructions for subsequent states", () => {
  assert.ok(src.includes("Transition Instructions"));
  assert.ok(src.includes("You've advanced the task to a new state"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
