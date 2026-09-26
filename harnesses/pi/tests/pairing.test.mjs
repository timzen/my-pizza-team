// Behavioral tests for web pairing (talk to a teammate from the browser)
// Run with: node --experimental-strip-types tests/pairing.test.mjs
//
// Covers the pairing poll (pair → messages → release, in order), the release
// semantics on a real TeammateLoop with fake Pi + daemon (complete / fail /
// resume, and deferral while a run is in flight), and how web-sent messages are
// tagged in the transcript. See src/pairing.ts, src/teammate.ts, and
// my-pizza-team docs/TEAMMATE_CHAT.md §4.

import * as assert from "node:assert";
import { WebPairing } from "../src/pairing.ts";
import { TeammateLoop } from "../src/teammate.ts";
import { TranscriptMirror } from "../src/transcript.ts";

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

// ─── WebPairing ─────────────────────────────────────────────────────

console.log("WebPairing:");

function pairingWith(polls) {
  const calls = [];
  const client = { async getPairing() { return polls.shift() ?? { paired: false, release: null, messages: [] }; } };
  const p = new WebPairing(client, {
    onPair: () => calls.push(["pair"]),
    onMessage: (t, m) => calls.push(["msg", t, m]),
    onRelease: (a) => calls.push(["release", a]),
  }, () => true);
  return { p, calls };
}

await test("applies pair, then messages, then release — in that order", async () => {
  const { p, calls } = pairingWith([{ paired: true, release: null, messages: [{ text: "hi", mode: "queue" }] }]);
  await p.tick();
  assert.deepStrictEqual(calls, [["pair"], ["msg", "hi", "queue"]]);
  assert.strictEqual(p.isPaired, true);
});

await test("onPair fires once per pairing, not per poll", async () => {
  const on = { paired: true, release: null, messages: [] };
  const { p, calls } = pairingWith([on, on, on]);
  await p.tick(); await p.tick(); await p.tick();
  assert.strictEqual(calls.filter((c) => c[0] === "pair").length, 1);
});

await test("a release ends the pairing locally", async () => {
  const { p, calls } = pairingWith([
    { paired: true, release: null, messages: [] },
    { paired: false, release: "complete", messages: [] },
  ]);
  await p.tick(); await p.tick();
  assert.deepStrictEqual(calls.at(-1), ["release", "complete"]);
  assert.strictEqual(p.isPaired, false);
});

await test("an unreachable daemon changes nothing", async () => {
  const calls = [];
  const p = new WebPairing({ async getPairing() { throw new Error("down"); } }, {
    onPair: () => calls.push("pair"), onMessage: () => calls.push("msg"), onRelease: () => calls.push("release"),
  }, () => true);
  await p.tick();
  assert.deepStrictEqual(calls, []);
});

// ─── TeammateLoop.releasePairing ────────────────────────────────────

console.log("TeammateLoop release:");

/** A loop holding work item wi-1, paused by a web pairing, with fakes recording calls. */
function pairedLoop() {
  const sent = [];
  const daemon = { comments: [], states: [] };
  const pi = { sendUserMessage: (text, opts) => sent.push({ text, opts }) };
  const client = {
    heartbeat: async () => ({}),
    postComment: async (id, c) => { daemon.comments.push([id, c]); return {}; },
    setWorkItemState: async (id, st) => { daemon.states.push([id, st]); return { success: true, completed: st === "COMPLETE" }; },
    reportTokenUsage: async () => ({}),
    getNextWork: async () => ({}),
  };
  const loop = new TeammateLoop(pi, client);
  // Simulate: claimed wi-1, its run started, then a web pairing paused us.
  loop["currentWorkItemId"] = "wi-1";
  loop["awaitingWorkRun"] = false;
  loop.pause();
  let freshSession = 0;
  loop.requestFreshSession = () => { freshSession++; };
  const perms = [];
  loop.setAutonomousPermissions = (a) => perms.push(a);
  return { loop, sent, daemon, perms, fresh: () => freshSession };
}

await test("complete: posts the last reply as the summary, sets COMPLETE, takes a fresh session", async () => {
  const { loop, daemon, perms, fresh } = pairedLoop();
  await loop.releasePairing("complete", "Added retry with backoff.");
  assert.deepStrictEqual(daemon.states, [["wi-1", "COMPLETE"]]);
  assert.ok(daemon.comments.some(([, c]) => c.includes("Added retry with backoff.")));
  assert.strictEqual(loop.isAutonomous, true);
  assert.deepStrictEqual(perms, [true]);
  assert.strictEqual(fresh(), 1);
  assert.strictEqual(loop.currentTask, null);
  loop.stop();
});

await test("complete with no prose falls back to a stock summary", async () => {
  const { loop, daemon } = pairedLoop();
  await loop.releasePairing("complete", "   ");
  assert.ok(daemon.comments.some(([, c]) => c.includes("Marked complete by a human")));
  loop.stop();
});

await test("fail: comments, sets FAILED, takes a fresh session", async () => {
  const { loop, daemon, fresh } = pairedLoop();
  await loop.releasePairing("fail", "whatever");
  assert.deepStrictEqual(daemon.states, [["wi-1", "FAILED"]]);
  assert.ok(daemon.comments.some(([, c]) => c.startsWith("[failed]")));
  assert.strictEqual(fresh(), 1);
  assert.strictEqual(loop.currentTask, null);
  loop.stop();
});

await test("resume (idle): nudges a new run and does NOT complete yet", async () => {
  const { loop, daemon, sent } = pairedLoop();
  await loop.releasePairing("resume", "a reply to your question");
  assert.deepStrictEqual(daemon.states, []);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].opts.deliverAs, "followUp");
  assert.strictEqual(loop.isAutonomous, true);
  assert.strictEqual(loop.currentTask, "wi-1");
  // A foreign agent_end before the nudge's run starts must not complete it.
  await loop.handleAgentComplete("stale");
  assert.deepStrictEqual(daemon.states, []);
  loop.stop();
});

await test("mid-run: any release waits for the run to end (a chat reply isn't a completion)", async () => {
  const { loop, daemon } = pairedLoop();
  loop.handleAgentStart();
  await loop.releasePairing("complete", "");
  assert.strictEqual(loop.hasPendingRelease, true);
  assert.deepStrictEqual(daemon.states, []);
  assert.strictEqual(loop.isAutonomous, false);
  loop.handleAgentEnd();
  await loop.applyPendingRelease("Done: retry added.");
  assert.strictEqual(loop.hasPendingRelease, false);
  assert.deepStrictEqual(daemon.states, [["wi-1", "COMPLETE"]]);
  loop.stop();
});

await test("no held item: every release just resumes", async () => {
  const { loop, daemon, sent } = pairedLoop();
  loop["currentWorkItemId"] = null;
  await loop.releasePairing("fail", "");
  assert.deepStrictEqual(daemon.states, []);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(loop.isAutonomous, true);
  loop.stop();
});

// ─── Transcript tagging ─────────────────────────────────────────────

console.log("Transcript tagging:");

await test("web-sent messages are tagged `web`; delivery mode is kept", async () => {
  const batches = [];
  const m = new TranscriptMirror(
    { async isTranscriptWatched() { return true; }, async postTranscript(e) { batches.push(...e); return { watched: true }; } },
    { pollMs: 10_000, flushMs: 5 },
  );
  await m.start();
  m.expectWebInput("look at auth.ts");
  m.onInput("look at auth.ts", "extension", "followUp");
  m.onInput("## Task\nDo the thing", "extension");
  await new Promise((r) => setTimeout(r, 15));
  m.stop();
  const users = batches.filter((e) => e.kind === "user");
  assert.strictEqual(users[0].origin, "web");
  assert.strictEqual(users[0].delivery, "followUp");
  assert.strictEqual(users[1].origin, "extension");
  assert.strictEqual(users[1].delivery, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
