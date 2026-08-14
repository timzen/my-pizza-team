// Source checks for the chat mirror (chat v2)
// Run with: node tests/chat.test.mjs
//
// The leader is the agent you chat with — there is no separate assistant process.
// The mirror keeps the daemon's chat and the leader's Pi session in sync:
//   inbound   inbox -> pi.sendUserMessage (steer while running) -> ack receipts
//   outbound  assistant prose -> bubbles, reasoning -> ephemeral thought peek,
//             terminal input -> user messages (tmux parity)
//
// See my-pizza-team/docs/ASSISTANT_CHAT_V2.md.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(path.join(import.meta.dirname, "../src/chat.ts"), "utf-8");
const leaderSrc = fs.readFileSync(path.join(import.meta.dirname, "../src/leader.ts"), "utf-8");
const indexSrc = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf-8");
const toolsSrc = fs.readFileSync(path.join(import.meta.dirname, "../src/tools.ts"), "utf-8");

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

console.log("ChatMirror source checks:");

// ─── Class structure ─────────────────────────────────────────────

test("exports ChatMirror class", () => {
  assert.ok(src.includes("export class ChatMirror"));
});

test("has no local store or filesystem state (pure daemon client)", () => {
  assert.ok(!src.includes("node:fs"));
  assert.ok(!src.includes("Store"));
  assert.ok(!src.includes("better-sqlite3"));
});

// ─── The turn model is gone ──────────────────────────────────────

test("no turn claiming, completing, or single-flight item state", () => {
  for (const gone of ["claimQueueItem", "completeQueueItem", "getNextQueueItem", "currentItemId", "isWorking"]) {
    assert.ok(!src.includes(gone), `${gone} should be gone`);
  }
});

test("no send_message tool anywhere (prose is mirrored instead)", () => {
  assert.ok(!toolsSrc.includes("send_message"));
  assert.ok(!toolsSrc.includes("sayAssistantMessage"));
  assert.ok(!indexSrc.includes("getActiveTurnId"));
});

// ─── One agent to talk to ────────────────────────────────────────

test("the retired --ppt-assistant role does not register a second chat agent", () => {
  // Two mirroring agents would answer every message twice.
  assert.ok(!indexSrc.includes("setupAssistant"));
  assert.ok(indexSrc.includes("RETIRED ASSISTANT ROLE"));
  assert.ok(indexSrc.includes("is retired"));
});

test("only the designated chat agent mirrors", () => {
  assert.ok(src.includes("isChatAgent"));
  assert.ok(src.includes("const { chat, messages } = await this.client.getInbox()"));
  // Every outbound path is gated.
  const gated = src.split("if (!this.isChatAgent) return;").length - 1;
  assert.ok(gated >= 5, `expected the outbound mirrors to be gated, found ${gated}`);
});

test("a chat-driven session roll skips deregistration (no offline flicker)", () => {
  assert.ok(src.includes("rollingSession"));
  assert.ok(src.includes("get isRollingSession"));
  assert.ok(leaderSrc.includes("if (chat.isRollingSession) return;"));
});

// ─── Inbound: daemon -> Pi ───────────────────────────────────────

test("pulls the inbox and hands messages to Pi", () => {
  assert.ok(src.includes("this.client.getInbox()"));
  assert.ok(src.includes("this.pi.sendUserMessage("));
});

test("mid-run messages are steered, idle ones sent plainly", () => {
  assert.ok(src.includes('this.agentRunning ? { deliverAs: "steer" } : undefined'));
});

test("quoted replies are passed to the agent as markdown quotes", () => {
  assert.ok(src.includes("item.quoted"));
  assert.ok(src.includes('"\\n> "') || src.includes('> ${item.quoted'));
});

test("acks 'delivered' on hand-off and 'read' when a run starts", () => {
  assert.ok(src.includes('"delivered"'));
  assert.ok(src.includes('ackInbox([...this.delivered], "read")'));
});

// ─── Outbound: Pi -> daemon ──────────────────────────────────────

test("splits assistant prose into bubbles via the shared splitter", () => {
  assert.ok(src.includes('from "./bubbles.js"'));
  assert.ok(src.includes("splitIntoBubbles(text)"));
  assert.ok(src.includes("this.client.postBubble("));
});

test("does not re-mirror paragraphs already sent this run", () => {
  assert.ok(src.includes("mirroredParagraphs"));
});

test("streams only the new tail of reasoning, throttled", () => {
  assert.ok(src.includes("thoughtSent"));
  assert.ok(src.includes("fullText.slice(this.thoughtSent)"));
  assert.ok(src.includes("THOUGHT_FLUSH_MS"));
});

test("toggles the thinking indicator around a run", () => {
  assert.ok(src.includes("postThought({ clear: true, thinking: true })"));
  assert.ok(src.includes("postThought({ thinking: false })"));
});

test("mirrors terminal input but ignores slash commands", () => {
  assert.ok(src.includes("mirrorTerminalInput"));
  assert.ok(src.includes('trimmed.startsWith("/")'));
  assert.ok(src.includes("client.mirrorUserMessage"));
});

// ─── Sessions ────────────────────────────────────────────────────

test("reports its Pi session file so chats can be resumed", () => {
  assert.ok(src.includes("reportSession"));
  assert.ok(src.includes("client.reportPiSession"));
});

test("realizes session directives it polls for itself", () => {
  assert.ok(src.includes("getSelfDirectives()"));
  assert.ok(src.includes("onSessionDirective"));
  assert.ok(src.includes("completeSelfDirective"));
});

// ─── Heartbeat / registration ────────────────────────────────────

test("the mirror does not heartbeat (the leader owns registration)", () => {
  // One registration per process: the leader already heartbeats and handles
  // re-registration, so the mirror must not run a second loop.
  assert.ok(!src.includes("heartbeat("));
  assert.ok(leaderSrc.includes("heartbeatTimer"));
});

console.log("\nleader.ts chat wiring:");

test("the leader registers as the chat agent's identity", () => {
  assert.ok(leaderSrc.includes('client.register({ name: "leader"'));
  assert.ok(leaderSrc.includes("new ChatMirror(pi, client)"));
});

test("injects the persona via before_agent_start", () => {
  assert.ok(leaderSrc.includes('pi.on("before_agent_start"'));
  assert.ok(leaderSrc.includes("chat.persona"));
});

test("mirrors interactive terminal input into the chat", () => {
  assert.ok(leaderSrc.includes('pi.on("input"'));
  assert.ok(leaderSrc.includes('event.source !== "interactive"'));
  assert.ok(leaderSrc.includes("chat.mirrorTerminalInput"));
});

test("mirrors reasoning from message_update and prose from message_end", () => {
  assert.ok(leaderSrc.includes('pi.on("message_update"'));
  assert.ok(leaderSrc.includes("chat.handleReasoning"));
  assert.ok(leaderSrc.includes('pi.on("message_end"'));
  assert.ok(leaderSrc.includes("chat.mirrorAssistantText"));
});

test("tracks run boundaries with agent_start / agent_settled", () => {
  assert.ok(leaderSrc.includes('pi.on("agent_start"'));
  assert.ok(leaderSrc.includes("chat.handleAgentStart"));
  assert.ok(leaderSrc.includes('pi.on("agent_settled"'));
  assert.ok(leaderSrc.includes("chat.handleAgentSettled"));
});

test("realizes session directives through commands (session APIs are command-only)", () => {
  assert.ok(leaderSrc.includes('action === "new-session"'));
  assert.ok(leaderSrc.includes('action === "resume-session"'));
  // Same pattern as the teammate's /ppt-fresh-session: queue a command, because
  // newSession/switchSession only exist on command contexts.
  assert.ok(leaderSrc.includes('pi.registerCommand("ppt-chat-new-session"'));
  assert.ok(leaderSrc.includes('pi.registerCommand("ppt-chat-resume"'));
  assert.ok(leaderSrc.includes('sendUserMessage("/ppt-chat-new-session", { deliverAs: "followUp" })'));
  assert.ok(leaderSrc.includes("cmdCtx.newSession({"));
  assert.ok(leaderSrc.includes("cmdCtx.switchSession(file"));
  // Post-switch work must use the replacement ctx (pi's documented footgun).
  assert.ok(leaderSrc.includes("withSession: reportReplacement"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
