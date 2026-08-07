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

test("claims with claimWorkItem (daemon leases the WorkItem → IN_PROGRESS)", () => {
  assert.ok(src.includes("this.client.claimWorkItem("));
});

test("does NOT call transitionTask (removed from model)", () => {
  assert.ok(!src.includes("transitionTask"));
});

test("does NOT track availableTransitions (daemon handles transitions)", () => {
  assert.ok(!src.includes("availableTransitions"));
});

test("completes with setWorkItemState(COMPLETE) and posts its own [done] comment", () => {
  assert.ok(src.includes('this.client.setWorkItemState(workItemId, "COMPLETE")'));
  // The agent owns its completion comment; the daemon posts nothing.
  assert.ok(src.includes('[done] Work complete. Summary:'));
});

test("posts the full completion message as a comment (not a truncated slice)", () => {
  // The [done] comment is for humans; it must not be cut off mid-sentence.
  assert.ok(!src.includes("lastMessage.slice(0, 500)"));
  assert.ok(src.includes("const fullMessage = lastMessage.trim()"));
});

test("checks doneRes.completed for task completion", () => {
  assert.ok(src.includes("doneRes?.completed"));
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

// ─── Completion → done ───────────────────────────────────────

test("marks the item COMPLETE on agent completion (no NEEDS_INPUT protocol)", () => {
  // The teammate never parses agent output for a NEEDS_INPUT sentinel. It
  // sets the item COMPLETE (daemon advances state); rework arrives as an
  // ordinary judgment move.
  assert.ok(!src.includes("NEEDS_INPUT"));
  assert.ok(src.includes("handleAgentComplete"));
  const completeSection = src.slice(src.indexOf("handleAgentComplete"));
  assert.ok(completeSection.includes('setWorkItemState(workItemId, "COMPLETE"'));
  // Returned items skip the COMPLETE call.
  assert.ok(src.includes("markReturned"));
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

test("dismisses itself when the daemon reports dismissal via heartbeat", () => {
  // Dismissal is delivered on the heartbeat response (res.dismissed), which
  // stops the loop and fires the onDismissed hook.
  assert.ok(src.includes("res.dismissed"));
  assert.ok(src.match(/res\.dismissed[\s\S]*?onDismissed/));
});

test("re-registers (not exit) when the daemon reports it's unknown (restart)", () => {
  // A daemon restart/upgrade wipes the members table; the heartbeat then
  // reports res.reregister, and the loop re-registers instead of shutting down.
  assert.ok(src.includes("res.reregister"));
  assert.ok(src.includes("this.reregister"));
});

// ─── Fresh session per work item (context hygiene) ────────────────

test("exposes a requestFreshSession hook", () => {
  assert.ok(src.includes("public requestFreshSession:"));
});

test("finishWorkItem requests a fresh session AND schedules a poll (safety net)", () => {
  const section = src.slice(src.indexOf("private finishWorkItem()"));
  assert.ok(section.includes("this.requestFreshSession?.()"));
  assert.ok(section.includes("this.schedulePoll()"));
});

test("both completion and return paths finish via finishWorkItem", () => {
  const matches = src.match(/this\.finishWorkItem\(\)/g) || [];
  assert.ok(matches.length >= 2, `expected >=2 finishWorkItem calls, got ${matches.length}`);
  // Neither end-of-work path should schedule a poll directly anymore.
  const handleSection = src.slice(src.indexOf("async handleAgentComplete"), src.indexOf("private finishWorkItem"));
  assert.ok(!handleSection.includes("this.schedulePoll()"));
});

// The wiring lives in index.ts: a command owns ctx.newSession() (session
// control only exists on command contexts) and the loop queues it.
const indexSrc = fs.readFileSync(
  path.join(import.meta.dirname, "../src/index.ts"),
  "utf-8"
);

test("index registers ppt-fresh-session command that calls newSession", () => {
  const cmd = indexSrc.slice(indexSrc.indexOf('registerCommand("ppt-fresh-session"'));
  assert.ok(cmd.includes(".newSession()"));
});

test("index wires requestFreshSession to queue the command as a followUp", () => {
  const wiring = indexSrc.slice(indexSrc.indexOf("loop.requestFreshSession ="));
  assert.ok(wiring.includes('"/ppt-fresh-session"'));
  assert.ok(wiring.includes('deliverAs: "followUp"'));
});

test("self-reset skips deregistration (no offline blip between work items)", () => {
  // The teammate's session_shutdown must early-return before deregister when
  // shutting down for a fresh-session reset.
  assert.ok(indexSrc.includes("resettingForFreshSession = true"));
  const shutdown = indexSrc.slice(indexSrc.indexOf("clearInterval(widgetInterval)"));
  const returnIdx = shutdown.indexOf("if (resettingForFreshSession) return");
  const deregisterIdx = shutdown.indexOf("client.deregister()");
  assert.ok(returnIdx > -1 && deregisterIdx > -1 && returnIdx < deregisterIdx);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
