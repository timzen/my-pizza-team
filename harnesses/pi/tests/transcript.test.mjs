// Behavioral tests for the transcript mirror (web UI watch view)
// Run with: node --experimental-strip-types tests/transcript.test.mjs
//
// The mirror forwards this teammate's Pi events to the daemon only while
// someone is watching, coalescing streaming updates per key. See
// src/runtime/transcript.ts and my-pizza-team docs/DESIGN.md "Watching and Pairing with a Teammate".

import * as assert from "node:assert";
import {
  TranscriptMirror, splitContent, resultText, clipArgs, capBackfill, userText, MAX_BACKFILL_ENTRIES,
} from "../src/runtime/transcript.ts";

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
 * A fake daemon: a settable watch bit (and whether it takes a backfill — an
 * older daemon doesn't say), a log of posted batches, and the backfill batches.
 */
function fakeClient(watched, { backfill = true } = {}) {
  const c = {
    watched,
    backfill,
    batches: [],
    backfills: [],
    async getTranscriptWatch() { return c.backfill ? { watched: c.watched, backfill: true } : { watched: c.watched }; },
    async postTranscript(entries, bf) {
      const copy = entries.map((e) => ({ ...e }));
      if (bf) c.backfills.push({ entries: copy, omitted: bf.omitted });
      else c.batches.push(copy);
      return { watched: c.watched };
    },
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

// ─── Backfill ───────────────────────────────────────────────────────

/** What the daemon's buffer ends up holding: a backfill replaces it, then keyed entries upsert. */
function daemonView(client) {
  const list = [];
  const byKey = new Map();
  const add = (e) => {
    const existing = e.key ? byKey.get(e.key) : undefined;
    if (existing) Object.assign(existing, e);
    else { const copy = { ...e }; list.push(copy); if (e.key) byKey.set(e.key, copy); }
  };
  for (const e of client.backfills.at(-1)?.entries ?? []) add(e);
  for (const batch of client.batches) for (const e of batch) add(e);
  return list;
}

/** A Pi-shaped session: assistant messages carry the timestamp their request started at. */
const userMsg = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const asstMsg = (text, ts, calls = [], thinking) => ({
  role: "assistant",
  timestamp: ts,
  content: [
    ...(thinking ? [{ type: "thinking", thinking }] : []),
    ...(text ? [{ type: "text", text }] : []),
    ...calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
  ],
});
const toolMsg = (id, name, text, isError = false) => ({
  role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0,
});

/** Drive one turn through the live events, persisting each message the way Pi does (after the event). */
function liveTurn(m, session, { input, reply, ts, calls = [], results = [] }) {
  m.onInput(input, "extension");
  session.push(userMsg(input, ts - 1));
  m.onAgentStart();
  const msg = asstMsg(reply, ts, calls, "hmm");
  m.onMessageStart(msg);
  m.onMessageUpdate(msg);
  m.onMessageEnd(msg);
  session.push(msg);
  for (const [id, name, args] of calls) m.onToolStart(id, name, args);
  for (const [id, name, text, isError] of results) {
    m.onToolEnd(id, name, { content: [{ type: "text", text }] }, !!isError);
    session.push(toolMsg(id, name, text, !!isError));
  }
  m.onAgentEnd();
}

await test("session history converts with the live mapping: the same turn, read back, gives the same entries", async () => {
  const session = [];
  const client = fakeClient(true);
  const live = new TranscriptMirror(client, opts);
  await live.start();
  liveTurn(live, session, {
    input: "fix it", reply: "Looking", ts: 100,
    calls: [["c1", "bash", { command: "ls", blob: "x".repeat(5000) }], ["c2", "read", { path: "nope" }]],
    results: [["c1", "bash", "a.txt"], ["c2", "read", "ENOENT", true]],
  });
  await sleep(15);
  live.stop();
  const fromLive = daemonView(client).filter((e) => e.kind !== "run" && e.kind !== "session");
  const fromHistory = new TranscriptMirror(fakeClient(false), opts).historyEntries([
    { role: "system", content: "prompt", timestamp: 1 }, // no live counterpart: skipped
    { role: "custom", content: "x", timestamp: 2 },
    ...session,
  ]);
  assert.deepStrictEqual(fromHistory, fromLive);
  assert.deepStrictEqual(fromHistory.map((e) => e.kind), ["user", "message", "tool", "tool"]);
  assert.strictEqual(fromHistory[1].key, "msg:i1:t100");
  assert.strictEqual(fromHistory[1].thinking, "hmm");
  assert.ok(fromHistory[2].args.blob.includes("more chars"), "args clipped the same way");
  assert.strictEqual(fromHistory[3].state, "error");
});

await test("watch starts mid-run: backfill, then live, with no gap and no duplicates", async () => {
  const session = [];
  const client = fakeClient(false);
  const m = new TranscriptMirror(client, opts);
  m.setHistory(() => session);
  await m.start();
  liveTurn(m, session, { input: "first", reply: "done one", ts: 100, calls: [["c1", "bash", { command: "ls" }]], results: [["c1", "bash", "a.txt"]] });
  // Second turn, in flight when the watch starts: a tool call running, then a reply streaming.
  m.onInput("second", "extension");
  session.push(userMsg("second", 199));
  m.onAgentStart();
  const call = asstMsg("", 200, [["c2", "bash", { command: "make" }]]);
  m.onMessageStart(call); m.onMessageEnd(call); session.push(call);
  m.onToolStart("c2", "bash", { command: "make" });
  assert.strictEqual(client.batches.length + client.backfills.length, 0, "unwatched: nothing sent");

  client.watched = true;
  await sleep(40); // a poll flips the bit → backfill
  m.onToolEnd("c2", "bash", { content: [{ type: "text", text: "built" }] }, false);
  session.push(toolMsg("c2", "bash", "built"));
  const reply = asstMsg("All good", 300);
  m.onMessageStart(reply);
  m.onMessageUpdate(asstMsg("All", 300));
  m.onMessageEnd(reply);
  m.onAgentEnd();
  await sleep(15);
  m.stop();

  assert.strictEqual(client.backfills.length, 1);
  assert.strictEqual(client.backfills[0].omitted, 0);
  assert.strictEqual(client.backfills[0].entries.at(-1).kind, "run", "a run in flight is marked");
  const view = daemonView(client).filter((e) => e.kind !== "run");
  assert.deepStrictEqual(view.map((e) => e.kind === "user" ? `user:${e.text}` : e.kind === "tool" ? `tool:${e.state}` : `msg:${e.text}`), [
    "user:first", "msg:done one", "tool:done", "user:second", "tool:done", "msg:All good",
  ]);
  assert.deepStrictEqual(view[4].args, { command: "make" }, "the backfilled call keeps its args when live completes it");
});

await test("the seam: events Pi fired before the session recorded them are not lost", async () => {
  const session = [];
  const client = fakeClient(false);
  const m = new TranscriptMirror(client, opts);
  m.setHistory(() => session);
  await m.start();
  liveTurn(m, session, { input: "earlier", reply: "ok", ts: 100 });
  // Fired, but not yet persisted when the watch starts:
  m.onInput("now", "interactive");                    // input before its user message lands
  m.onAgentStart();
  const msg = asstMsg("Replying", 200, [["c9", "read", { path: "a" }]]);
  m.onMessageStart(msg); m.onMessageEnd(msg);          // message_end before it's appended
  m.onToolStart("c9", "read", { path: "a" });
  m.onToolEnd("c9", "read", { content: [{ type: "text", text: "A" }] }, false); // before its toolResult
  client.watched = true;
  await sleep(40);
  m.stop();
  const bf = client.backfills[0].entries.filter((e) => e.kind !== "run");
  assert.deepStrictEqual(bf.map((e) => e.kind), ["user", "message", "user", "message", "tool"]);
  assert.strictEqual(bf[2].origin, "tui", "the live input keeps its origin");
  assert.strictEqual(bf[4].state, "done");
});

await test("the seam: input already in the session isn't sent twice (the live tag wins)", async () => {
  const session = [];
  const client = fakeClient(false);
  const m = new TranscriptMirror(client, opts);
  m.setHistory(() => session);
  await m.start();
  m.onInput("typed", "interactive");
  session.push(userMsg("typed", 1));
  client.watched = true;
  await sleep(40);
  m.stop();
  const users = client.backfills[0].entries.filter((e) => e.kind === "user");
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].origin, "tui");
});

await test("a long session is capped to the newest entries and says how many were left out", async () => {
  const session = [];
  for (let i = 0; i < MAX_BACKFILL_ENTRIES + 30; i++) session.push(userMsg(`m${i}`, i));
  const client = fakeClient(false);
  const m = new TranscriptMirror(client, opts);
  m.setHistory(() => session);
  await m.start();
  client.watched = true;
  await sleep(40);
  m.stop();
  const { entries, omitted } = client.backfills[0];
  assert.strictEqual(entries.length, MAX_BACKFILL_ENTRIES);
  assert.strictEqual(omitted, 30);
  assert.strictEqual(entries[0].text, "m30");
  assert.strictEqual(entries.at(-1).text, `m${MAX_BACKFILL_ENTRIES + 29}`);
});

await test("capBackfill: an entry cap and a size cap; the newest entry always goes", () => {
  const e = (n) => ({ kind: "user", text: "x".repeat(n) });
  assert.deepStrictEqual(capBackfill([e(1), e(1), e(1)], 2, 1e9).omitted, 1);
  const bySize = capBackfill([e(100), e(100), e(100)], 10, 250);
  assert.strictEqual(bySize.entries.length, 2);
  assert.strictEqual(bySize.omitted, 1);
  assert.strictEqual(capBackfill([e(1000)], 10, 10).entries.length, 1);
});

await test("an older daemon (no `backfill` in the watch poll) gets the live-only stream", async () => {
  const session = [userMsg("history", 1)];
  const client = fakeClient(false, { backfill: false });
  const m = new TranscriptMirror(client, opts);
  m.setHistory(() => session);
  await m.start();
  client.watched = true;
  await sleep(40);
  m.onInput("live", "extension");
  await sleep(15);
  m.stop();
  assert.strictEqual(client.backfills.length, 0);
  assert.deepStrictEqual(client.batches.flat().map((e) => e.text), ["live"]);
});

await test("no history source (a harness without one): live-only, as before", async () => {
  const client = fakeClient(false);
  const m = new TranscriptMirror(client, opts);
  await m.start();
  client.watched = true;
  await sleep(40);
  m.stop();
  assert.strictEqual(client.backfills.length, 0);
});

await test("watched at start: an empty session opens with a divider, not an empty backfill", async () => {
  const client = fakeClient(true);
  const m = new TranscriptMirror(client, opts);
  m.setHistory(() => [{ role: "system", content: "prompt" }]);
  await m.start();
  await sleep(15);
  m.stop();
  assert.strictEqual(client.backfills.length, 0);
  assert.deepStrictEqual(client.batches.flat().map((e) => e.kind), ["session"]);
});

await test("the history is read only when a watch starts", async () => {
  let reads = 0;
  const client = fakeClient(false);
  const m = new TranscriptMirror(client, opts);
  m.setHistory(() => { reads++; return []; });
  await m.start();
  m.onInput("x", "extension");
  await sleep(60);
  assert.strictEqual(reads, 0, "unwatched: never read");
  client.watched = true;
  await sleep(60);
  m.stop();
  assert.strictEqual(reads, 1, "once per watching period");
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

await test("userText joins a user message's text parts", () => {
  assert.strictEqual(userText({ content: "plain" }), "plain");
  assert.strictEqual(userText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\n[image]\nb");
});

await test("clipArgs clips long string args only", () => {
  const out = clipArgs({ path: "a.ts", content: "x".repeat(5000), n: 3 });
  assert.strictEqual(out.path, "a.ts");
  assert.strictEqual(out.n, 3);
  assert.ok(out.content.length < 1100 && out.content.includes("more chars"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
