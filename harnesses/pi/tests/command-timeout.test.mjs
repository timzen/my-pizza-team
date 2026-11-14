// The default timeout for a teammate's bash calls (src/command-timeout.ts,
// wired by src/index.ts; my-pizza-team docs/DESIGN.md "Stalled Teammates").
// Run: node --test --experimental-strip-types tests/command-timeout.test.mjs
//
// A bash call with no `timeout` gets the team's `commandTimeoutMinutes` (in
// seconds, as Pi's bash takes it); an explicit one is kept, shorter or longer;
// 0 = off leaves the call unchanged; other tools are never touched. When a
// defaulted command times out — checked against Pi's real bash tool and a real
// sleeping command — the error says it was MPT's default and how to ask for
// more. Plus the wiring: index.ts attaches it with the work loop's minutes, and
// the loop holds the claim's value for its item only.

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";

const { CommandTimeoutDefault, attachCommandTimeout, defaultTimeoutNote } = await import("../src/command-timeout.ts");
const { TeammateLoop } = await import("../src/teammate.ts");

/** A fake Pi that records pi.on handlers and emits events to them (last handler's return value). */
function fakePi() {
  const handlers = new Map();
  return {
    on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
    async emit(name, event) { let out; for (const fn of handlers.get(name) ?? []) out = await fn(event, {}); return out; },
  };
}

const bashCall = (input, toolCallId = "t1") => ({ toolName: "bash", toolCallId, input });

test("a bash call with no timeout gets the default, in seconds", async () => {
  const pi = fakePi();
  attachCommandTimeout(pi, new CommandTimeoutDefault(() => 60));
  const event = bashCall({ command: "node --test tests/persona-model.test.mjs | grep fail" });
  await pi.emit("tool_call", event);
  assert.deepEqual(event.input, { command: "node --test tests/persona-model.test.mjs | grep fail", timeout: 3600 });
});

test("an explicit timeout is kept, shorter or longer than the default", () => {
  const timeouts = new CommandTimeoutDefault(() => 60);
  for (const timeout of [5, 7200]) {
    const event = bashCall({ command: "make", timeout });
    assert.equal(timeouts.onToolCall(event), null);
    assert.equal(event.input.timeout, timeout);
  }
});

test("0 = off: the call is unchanged; other tools are never touched", () => {
  const off = new CommandTimeoutDefault(() => 0);
  const event = bashCall({ command: "make" });
  assert.equal(off.onToolCall(event), null);
  assert.deepEqual(event.input, { command: "make" });
  const on = new CommandTimeoutDefault(() => 60);
  const read = { toolName: "read", toolCallId: "r1", input: { path: "a.ts" } };
  assert.equal(on.onToolCall(read), null);
  assert.deepEqual(read.input, { path: "a.ts" });
});

test("the minutes are read at each call, so a new claim's value applies at once", () => {
  let minutes = 60;
  const timeouts = new CommandTimeoutDefault(() => minutes);
  assert.equal(timeouts.onToolCall(bashCall({ command: "a" }, "1")), 3600);
  minutes = 240;
  assert.equal(timeouts.onToolCall(bashCall({ command: "b" }, "2")), 14400);
});

test("a defaulted command that times out (Pi's real bash) says it was MPT's default", async () => {
  const pi = fakePi();
  // 1/60 minute = 1 second, so the real command times out quickly.
  attachCommandTimeout(pi, new CommandTimeoutDefault(() => 1 / 60));
  const call = bashCall({ command: "sleep 30" }, "slow");
  await pi.emit("tool_call", call);
  assert.equal(call.input.timeout, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-cmd-timeout-"));
  let message = "";
  try {
    await createBashTool(dir).execute("slow", call.input, new AbortController().signal, () => {});
    assert.fail("the command should have timed out");
  } catch (e) { message = e.message; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.match(message, /Command timed out after 1 seconds/);
  const content = [{ type: "text", text: message }];
  const patched = await pi.emit("tool_result", { toolName: "bash", toolCallId: "slow", isError: true, content, input: call.input });
  assert.ok(patched, "the result is patched");
  assert.equal(patched.content[0].text, message, "Pi's error stays first");
  assert.match(patched.content[1].text, /MPT's default command timeout/);
  assert.match(patched.content[1].text, /commandTimeoutMinutes/);
  assert.match(patched.content[1].text, /explicit, larger `timeout`/);
});

test("other results stand: a success, an explicit timeout's own timeout, another tool", () => {
  const timeouts = new CommandTimeoutDefault(() => 60);
  const timedOut = [{ type: "text", text: "Command timed out after 3600 seconds" }];
  timeouts.onToolCall(bashCall({ command: "ok" }, "ok"));
  assert.equal(timeouts.onToolResult({ toolName: "bash", toolCallId: "ok", isError: false, content: [{ type: "text", text: "done" }] }), undefined);
  timeouts.onToolCall(bashCall({ command: "x", timeout: 5 }, "explicit"));
  assert.equal(timeouts.onToolResult({ toolName: "bash", toolCallId: "explicit", isError: true, content: timedOut }), undefined);
  assert.equal(timeouts.onToolResult({ toolName: "read", toolCallId: "r", isError: true, content: timedOut }), undefined);
  assert.match(defaultTimeoutNote(60), /60 min/);
});

test("the loop's minutes: the claim's for the item in hand, else the team's", () => {
  const loop = new TeammateLoop({ on() {}, sendUserMessage() {} }, {});
  assert.equal(loop.commandTimeoutMinutes, 60, "default before any registration");
  loop.teamCommandTimeoutMinutes = 0;
  assert.equal(loop.commandTimeoutMinutes, 0);
  loop.heldCommandTimeout = { workItemId: "wi-1", minutes: 240 };
  assert.equal(loop.commandTimeoutMinutes, 0, "not the item in hand");
  loop.currentWorkItemId = "wi-1";
  assert.equal(loop.commandTimeoutMinutes, 240);
});

test("wiring: index.ts attaches the default with the loop's minutes; the claim sets the held value", () => {
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, "../src", f), "utf-8");
  assert.ok(src("index.ts").includes("attachCommandTimeout(pi, new CommandTimeoutDefault(() => loop.commandTimeoutMinutes))"));
  assert.ok(src("index.ts").includes("loop.teamCommandTimeoutMinutes = res.commandTimeoutMinutes"), "re-registration refreshes it");
  assert.ok(src("teammate.ts").includes("isCommandTimeoutMinutes(claim.commandTimeoutMinutes)"));
});
