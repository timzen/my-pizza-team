// Behavioral tests for the transcript mirror (web UI watch view)
// Run with: node --experimental-strip-types tests/transcript.test.mjs
//
// The mirror forwards this teammate's Pi events to the daemon only while
// someone is watching, coalescing streaming updates per key. See
// src/transcript.ts and my-pizza-team docs/TEAMMATE_CHAT.md §3.

import * as assert from "node:assert";
import { TranscriptMirror, splitContent, resultText, clipArgs } from "../src/transcript.ts";

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

/** A fake daemon: a settable watch bit + a log of posted batches. */
function fakeClient(watched) {
  const c = {
    watched,
    batches: [],
    async isTranscriptWatched() { return c.watched; },
    async postTranscript(entries) { c.batches.push(entries.map((e) => ({ ...e }))); return { watched: c.watched }; },
  };
  return c;
}

const opts = { pollMs: 20, flushMs: 5, instance: "i1" };
const assistant = (text, thinking) => ({
  role: "assistant",
  content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }],
});

console.log("TranscriptMirror:");

await test("unwatched: nothing is posted", async () => {
  const client = fakeClient(false);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  m.onAgentStart();
  m.onInput("hello", "extension");
  await sleep(20);
  m.stop();
  assert.strictEqual(client.batches.length, 0);
});

await test("watched at start: a session divider opens the stream", async () => {
  const client = fakeClient(true);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  await sleep(15);
  m.stop();
  assert.deepStrictEqual(client.batches.flat().map((e) => e.kind), ["session"]);
});

await test("token updates coalesce into one keyed message entry with the latest text", async () => {
  const client = fakeClient(true);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  m.onMessageStart({ role: "assistant" });
  m.onMessageUpdate(assistant("He"));
  m.onMessageUpdate(assistant("Hell"));
  m.onMessageUpdate(assistant("Hello", "hmm"));
  await sleep(15);
  m.stop();
  const msgs = client.batches.flat().filter((e) => e.kind === "message");
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].text, "Hello");
  assert.strictEqual(msgs[0].thinking, "hmm");
  assert.strictEqual(msgs[0].key, "msg:i1:1");
});

await test("each assistant message gets its own key", async () => {
  const client = fakeClient(true);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  m.onMessageStart({ role: "assistant" }); m.onMessageEnd(assistant("one"));
  m.onMessageStart({ role: "assistant" }); m.onMessageEnd(assistant("two"));
  await sleep(15);
  m.stop();
  const keys = client.batches.flat().filter((e) => e.kind === "message").map((e) => e.key);
  assert.deepStrictEqual(keys, ["msg:i1:1", "msg:i1:2"]);
});

await test("non-assistant messages are ignored (the user entry comes from `input`)", async () => {
  const client = fakeClient(true);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  m.onMessageStart({ role: "user" });
  m.onMessageUpdate({ role: "user", content: "x" });
  m.onMessageEnd({ role: "toolResult", content: "x" });
  await sleep(15);
  m.stop();
  assert.strictEqual(client.batches.flat().filter((e) => e.kind === "message").length, 0);
});

await test("tool start + end in one window merge and keep the args", async () => {
  const client = fakeClient(true);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  m.onToolStart("c1", "bash", { command: "ls" });
  m.onToolEnd("c1", "bash", { content: [{ type: "text", text: "a.txt" }] }, false);
  await sleep(15);
  m.stop();
  const tools = client.batches.flat().filter((e) => e.kind === "tool");
  assert.strictEqual(tools.length, 1);
  assert.deepStrictEqual(tools[0].args, { command: "ls" });
  assert.strictEqual(tools[0].state, "done");
  assert.strictEqual(tools[0].result, "a.txt");
});

await test("input origin: interactive → tui, everything else → extension", async () => {
  const client = fakeClient(true);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  m.onInput("typed", "interactive");
  m.onInput("prompt", "extension");
  await sleep(15);
  m.stop();
  const users = client.batches.flat().filter((e) => e.kind === "user");
  assert.deepStrictEqual(users.map((u) => u.origin), ["tui", "extension"]);
});

await test("becoming watched mid-stream: the next update carries the whole message", async () => {
  const client = fakeClient(false);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  m.onMessageStart({ role: "assistant" });
  m.onMessageUpdate(assistant("The first half"));
  client.watched = true;
  await sleep(40); // a poll flips the bit
  m.onMessageUpdate(assistant("The first half and the rest"));
  await sleep(15);
  m.stop();
  const msgs = client.batches.flat().filter((e) => e.kind === "message");
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].text, "The first half and the rest");
});

await test("stops forwarding when the daemon says nobody's watching anymore", async () => {
  const client = fakeClient(true);
  const m = new TranscriptMirror(client, { ...opts, pollMs: 10_000 });
  await m.start();
  client.watched = false; // the POST response will carry this
  m.onAgentStart();
  await sleep(15);
  const before = client.batches.length;
  m.onAgentEnd();
  await sleep(15);
  m.stop();
  assert.strictEqual(client.batches.length, before);
});

console.log("helpers:");

await test("splitContent separates prose from reasoning", () => {
  assert.deepStrictEqual(splitContent(assistant("hi", "think")), { text: "hi", thinking: "think" });
  assert.deepStrictEqual(splitContent({ content: "plain" }), { text: "plain", thinking: "" });
});

await test("resultText reads Pi tool results and labels non-text parts", () => {
  assert.strictEqual(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }] }), "a\n[image]");
  assert.strictEqual(resultText("raw"), "raw");
  assert.strictEqual(resultText(null), "");
});

await test("clipArgs clips long string args only", () => {
  const out = clipArgs({ path: "a.ts", content: "x".repeat(5000), n: 3 });
  assert.strictEqual(out.path, "a.ts");
  assert.strictEqual(out.n, 3);
  assert.ok(out.content.length < 1100 && out.content.includes("more chars"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
