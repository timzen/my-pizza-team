// The Pi harness's reading of a failed model call's error kind
// (src/model-error.ts; my-pizza-team docs/DESIGN.md "Model Failover"), and the
// teammate loop sending it with the session error.
//
// Run: node --test --experimental-strip-types tests/model-error.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";

const { classifyPiModelError } = await import("../src/model-error.ts");
const { summarizeRun } = await import("../src/runtime/usage.ts");
const { TeammateLoop } = await import("../src/teammate.ts");

test("Bedrock's formatted errors (the real messages) and SDK exception names", () => {
  assert.strictEqual(classifyPiModelError("Throttling error: Too many requests, please wait before trying again."), "throttle");
  assert.strictEqual(classifyPiModelError("Throttling error: Too many tokens, please wait before trying again."), "throttle");
  assert.strictEqual(classifyPiModelError("Service unavailable: Bedrock is unable to process your request."), "5xx");
  assert.strictEqual(classifyPiModelError("Internal server error: something broke"), "5xx");
  assert.strictEqual(classifyPiModelError("ThrottlingException: Rate exceeded"), "throttle");
  assert.strictEqual(classifyPiModelError("ExpiredTokenException: The security token included in the request is expired"), "auth");
  assert.strictEqual(classifyPiModelError("Could not load credentials from any providers"), "auth");
});

test("provider HTTP statuses, context overflow, and the rest", () => {
  assert.strictEqual(classifyPiModelError('anthropic API error (429): {"type":"rate_limit_error"}'), "throttle");
  assert.strictEqual(classifyPiModelError("openai API error (503): upstream"), "5xx");
  assert.strictEqual(classifyPiModelError("acme API error (401): bad key"), "auth");
  assert.strictEqual(classifyPiModelError("prompt is too long: 210000 tokens > 200000 maximum"), "context");
  assert.strictEqual(classifyPiModelError("", "length"), "context");
  assert.strictEqual(classifyPiModelError("The model call failed (no error message)"), "other");
});

test("summarizeRun keeps the failed message's stopReason and model ref", () => {
  const u = summarizeRun([{ role: "assistant", provider: "acme", model: "strong", stopReason: "error", errorMessage: "Throttling error: Too many requests" }]);
  assert.strictEqual(u.sessionErrorModel, "acme/strong");
  assert.strictEqual(u.sessionErrorStopReason, "error");
  assert.strictEqual(summarizeRun([{ role: "assistant", model: "m", stopReason: "stop", content: [] }]).sessionErrorModel, undefined);
});

test("the teammate loop sends the kind and model with the session error", async () => {
  const sent = [];
  const client = {
    heartbeat: async () => ({}),
    postComment: async () => ({}),
    failWorkItemForSessionError: async (id, err, detail) => { sent.push([id, err, detail]); return { success: true }; },
    getNextWork: async () => ({}),
  };
  const loop = new TeammateLoop({ sendUserMessage: () => {} }, client);
  loop["currentWorkItemId"] = "wi-1";
  loop["awaitingWorkRun"] = false;
  loop["autonomous"] = true;
  loop.requestFreshSession = () => {};
  await loop.handleAgentComplete("", "Throttling error: x", { errorKind: "throttle", model: "acme/strong" });
  loop.stop?.();
  assert.deepStrictEqual(sent, [["wi-1", "Throttling error: x", { errorKind: "throttle", model: "acme/strong" }]]);
});
