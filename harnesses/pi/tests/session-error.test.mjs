// Behavioral tests: a teammate run whose model call errored is not a completion
// Run with: node --experimental-strip-types tests/session-error.test.mjs
//
// When a work item's own run ends with stopReason "error" (a Bedrock 503,
// "Could not load credentials from any providers"), the loop must NOT post
// "[done]" or set COMPLETE — it fails the item with the error so the daemon
// retries it with backoff (my-pizza-team docs/DESIGN.md "Errored Sessions
// Retry"). A normal completion, even an empty one, is unaffected.
// See src/teammate.ts handleAgentComplete and src/runtime/usage.ts.

import * as assert from "node:assert";
import { TeammateLoop } from "../src/teammate.ts";

let passed = 0;
let failed = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}: ${e.message}`); failed++; }
}

/** A loop holding wi-1 whose own run just ended, with fakes recording daemon calls. */
function workingLoop() {
  const daemon = { comments: [], states: [], sessionErrors: [] };
  const pi = { sendUserMessage: () => {} };
  const client = {
    heartbeat: async () => ({}),
    postComment: async (id, c) => { daemon.comments.push([id, c]); return {}; },
    setWorkItemState: async (id, st) => { daemon.states.push([id, st]); return { success: true, completed: st === "COMPLETE" }; },
    failWorkItemForSessionError: async (id, err) => {
      daemon.sessionErrors.push([id, err]);
      return { success: true, retry: { workItemId: "wi-2", attempt: 2, maxAttempts: 4, retryAt: new Date().toISOString() } };
    },
    getNextWork: async () => ({}),
  };
  const loop = new TeammateLoop(pi, client);
  loop["currentWorkItemId"] = "wi-1";
  loop["awaitingWorkRun"] = false;
  loop["autonomous"] = true;
  let fresh = 0;
  loop.requestFreshSession = () => { fresh++; };
  const completed = [];
  loop.onTaskComplete = (id) => completed.push(id);
  return { loop, daemon, fresh: () => fresh, completed };
}

console.log("TeammateLoop: errored sessions");

await test("stopReason error → fails for retry; no [done], no COMPLETE", async () => {
  const { loop, daemon, fresh, completed } = workingLoop();
  await loop.handleAgentComplete("", "Service unavailable: Bedrock is unable to process your request.");
  assert.deepStrictEqual(daemon.sessionErrors, [["wi-1", "Service unavailable: Bedrock is unable to process your request."]]);
  assert.deepStrictEqual(daemon.states, [], "must not set COMPLETE (the daemon sets FAILED + retries)");
  assert.ok(!daemon.comments.some(([, c]) => c.startsWith("[done]")), "must not post [done]");
  assert.deepStrictEqual(completed, []);
  assert.strictEqual(loop.currentTask, null, "the item is released so the retry can be claimed");
  assert.strictEqual(fresh(), 1, "a fresh session for the retry");
  loop.stop();
});

await test("an unreachable daemon on the error path still releases the item, never completes", async () => {
  const { loop, daemon } = workingLoop();
  loop["client"].failWorkItemForSessionError = async () => { throw new Error("down"); };
  await loop.handleAgentComplete("", "Could not load credentials from any providers");
  assert.deepStrictEqual(daemon.states, []);
  assert.strictEqual(loop.currentTask, null);
  loop.stop();
});

await test("a normal empty-but-successful completion still posts [done] and COMPLETE", async () => {
  const { loop, daemon, completed } = workingLoop();
  await loop.handleAgentComplete("");
  assert.deepStrictEqual(daemon.sessionErrors, []);
  assert.deepStrictEqual(daemon.states, [["wi-1", "COMPLETE"]]);
  assert.ok(daemon.comments.some(([, c]) => c.startsWith("[done] Work complete.")));
  assert.deepStrictEqual(completed, ["wi-1"]);
  loop.stop();
});

await test("a foreign run's error (work prompt not picked up yet) is ignored", async () => {
  const { loop, daemon } = workingLoop();
  loop["awaitingWorkRun"] = true;
  await loop.handleAgentComplete("", "Service unavailable");
  assert.deepStrictEqual(daemon.sessionErrors, []);
  assert.strictEqual(loop.currentTask, "wi-1");
  loop.stop();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
