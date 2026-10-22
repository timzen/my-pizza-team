// Parity tests: a teammate and the leader feed the live transcript identically
// Run with: node --experimental-strip-types tests/session-transcript.test.mjs
//
// The assistant's terminal mode (assistant.chatMode: "terminal") MUST be exactly
// the teammate watch/pair experience. Both roles wire their TranscriptMirror with
// the one `attachTranscriptMirror` and hand web messages to Pi with the one
// `deliverWebMessage` (src/session-transcript.ts). These tests drive the same
// session events through a "teammate" and a "leader" and require identical
// entries, and check from source that neither role wires the mirror any other way.
// See my-pizza-team docs/DESIGN.md "Assistant Chat Model" and "Watching and
// Pairing with a Teammate".

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { TranscriptMirror } from "../src/runtime/transcript.ts";
import { attachTranscriptMirror, deliverWebMessage } from "../src/session-transcript.ts";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake Pi: records pi.on handlers, emits events to them, and — like Pi —
 * turns sendUserMessage into an `input` event (source "extension", with the
 * streamingBehavior it was delivered as).
 */
function fakePi() {
  const handlers = new Map();
  const sent = [];
  const pi = {
    on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
    async emit(name, event = {}) { for (const fn of handlers.get(name) ?? []) await fn(event, {}); },
    sendUserMessage(text, opts) {
      sent.push({ text, opts });
      void pi.emit("input", { text, source: "extension", streamingBehavior: opts?.deliverAs });
    },
  };
  return { pi, sent, handlers };
}

/** A fake daemon for one agent id: always watched, records posted batches. */
function fakeClient(id) {
  const c = {
    id,
    entries: [],
    async isTranscriptWatched() { return true; },
    async postTranscript(entries) { c.entries.push(...entries.map((e) => ({ ...e }))); return { watched: true }; },
  };
  return c;
}

/** One agent wired the way its role wires it in production. */
async function agent(id) {
  const { pi, sent, handlers } = fakePi();
  const client = fakeClient(id);
  const transcript = attachTranscriptMirror(pi, new TranscriptMirror(client, { pollMs: 10_000, flushMs: 5, instance: "i1" }));
  await sleep(1); // start() polls the watch bit, then opens with a session divider
  return { pi, sent, handlers, client, transcript };
}

/**
 * The parity sequence: typed input, a web message (idle), a run with thinking +
 * prose + a tool call with a result + a failing tool, a mid-run web message (queue)
 * and a steer, then the run ends.
 */
async function drive(a) {
  const { pi, transcript } = a;
  await pi.emit("input", { text: "typed in tmux", source: "interactive" });
  deliverWebMessage(pi, transcript, "from the web", "queue", false);
  await pi.emit("agent_start");
  const msg = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Let me look" }] };
  await pi.emit("message_start", { message: msg });
  await pi.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "Let" }] } });
  await pi.emit("message_end", { message: msg });
  await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls", blob: "x".repeat(5000) } });
  await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt\n" + "y".repeat(9000) }] }, isError: false });
  await pi.emit("tool_execution_start", { toolCallId: "c2", toolName: "read", args: { path: "nope" } });
  await pi.emit("tool_execution_end", { toolCallId: "c2", toolName: "read", result: { content: [{ type: "text", text: "ENOENT" }] }, isError: true });
  deliverWebMessage(pi, transcript, "after this", "queue", true);
  deliverWebMessage(pi, transcript, "stop that", "steer", true);
  await pi.emit("agent_end");
  await sleep(20);
}

console.log("Teammate ↔ leader transcript parity:");

await test("the same session events produce identical transcript entries", async () => {
  const teammate = await agent("swift-ripley");
  const leader = await agent("leader");
  await drive(teammate);
  await drive(leader);
  teammate.pi.emit("session_shutdown");
  leader.pi.emit("session_shutdown");

  assert.ok(teammate.client.entries.length > 0, "teammate posted entries");
  assert.deepStrictEqual(leader.client.entries, teammate.client.entries);

  // And they're the entries the watch view expects.
  const e = teammate.client.entries;
  assert.deepStrictEqual(e.map((x) => x.kind), ["session", "user", "user", "run", "message", "tool", "tool", "user", "user", "run"]);
  assert.deepStrictEqual(e.filter((x) => x.kind === "user").map((x) => [x.origin, x.delivery]),
    [["tui", undefined], ["web", undefined], ["web", "followUp"], ["web", "steer"]]);
  const message = e.find((x) => x.kind === "message");
  assert.strictEqual(message.text, "Let me look");
  assert.strictEqual(message.thinking, "hmm");
  const [ok, err] = e.filter((x) => x.kind === "tool");
  assert.strictEqual(ok.state, "done");
  assert.ok(ok.args.blob.includes("more chars"), "args are clipped");
  assert.ok(ok.result.startsWith("a.txt") && ok.result.includes("more chars"), "results are clipped");
  assert.strictEqual(err.state, "error");
  assert.strictEqual(err.result, "ENOENT");
});

await test("both register the same Pi events", async () => {
  const teammate = await agent("t1");
  const leader = await agent("leader");
  assert.deepStrictEqual([...leader.handlers.keys()].sort(), [...teammate.handlers.keys()].sort());
  teammate.pi.emit("session_shutdown");
  leader.pi.emit("session_shutdown");
});

await test("deliverWebMessage: idle starts a run; mid-run queue = followUp, steer = steer", async () => {
  const a = await agent("t1");
  deliverWebMessage(a.pi, a.transcript, "one", "queue", false);
  deliverWebMessage(a.pi, a.transcript, "two", "queue", true);
  deliverWebMessage(a.pi, a.transcript, "three", "steer", true);
  assert.deepStrictEqual(a.sent.map((s) => s.opts), [undefined, { deliverAs: "followUp" }, { deliverAs: "steer" }]);
  a.pi.emit("session_shutdown");
});

// ─── One code path (source) ─────────────────────────────────────────

const read = (f) => fs.readFileSync(path.join(import.meta.dirname, "../src", f), "utf-8");
const indexSrc = read("index.ts");
const leaderSrc = read("leader.ts");
const chatSrc = read("chat.ts");

await test("teammate and leader both wire the mirror through attachTranscriptMirror", () => {
  for (const [name, src] of [["index.ts", indexSrc], ["leader.ts", leaderSrc]]) {
    assert.match(src, /attachTranscriptMirror\(pi, new TranscriptMirror\(client\)\)/, name);
    // No hand-rolled wiring: the mirror's event methods are only called from session-transcript.ts.
    assert.doesNotMatch(src, /transcript\.on(Input|AgentStart|AgentEnd|Message|Tool)/, name);
    assert.doesNotMatch(src, /expectWebInput/, name);
  }
});

await test("web messages reach Pi through deliverWebMessage for both roles", () => {
  assert.match(indexSrc, /onMessage: \(text, mode\) => \{ deliverWebMessage\(pi, transcript, text, mode, loop\.isAgentRunning\); \}/);
  assert.match(leaderSrc, /chat\.onDeliver = \(text, mode\) => \{ deliverWebMessage\(pi, transcript, text, mode, chat\.isAgentRunning\); \}/);
  // The chat inbox honours the composer's mode; chat-composer messages (no mode) steer as before.
  assert.match(chatSrc, /item\.mode === "queue" \? "queue" : "steer"/);
});

await test("the leader gets no teammate-only pairing side effects", () => {
  // No WebPairing poller (pair pauses a work loop; release settles a held item).
  assert.doesNotMatch(leaderSrc, /WebPairing/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
