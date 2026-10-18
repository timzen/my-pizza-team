/**
 * tests/fixtures/fake-acp-agent.ts — A stand-in ACP agent for testing `mpt agent`.
 *
 * Speaks the same JSON-RPC over stdio that Kiro and Claude Code's adapter do (see
 * TODO.md "Next: other harnesses" for what was verified against the real ones), so
 * the supervisor is tested end to end without spending credits. What it does with a
 * prompt depends on a keyword in it:
 *
 *   (default)   says something, makes one tool call that needs permission, asks the
 *               client for it, reports usage + cost, and ends the turn with a summary
 *               naming the permission outcome, the session mode, and the session count.
 *   FAKE-FAIL   runs the "give up" command the supervisor put in the prompt (the text
 *               in backticks with a "<reason>" placeholder), then ends the turn.
 *   FAKE-EXIT   exits mid-turn, like a crash.
 *
 * It also sends an agent-specific notification and an agent-specific request the
 * client doesn't know, as Kiro does, so tolerating those is part of every test.
 */

import { spawn } from "node:child_process";

/** Run `sh -c cmd` without blocking the stdio loop; resolves with its exit code and combined output. */
function sh(cmd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => output += d);
    child.stderr.on("data", (d) => output += d);
    child.on("error", (err) => resolve({ code: null, output: String(err) }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** Write one JSON-RPC message; resolves once it's flushed, so an exit right after loses nothing. */
const send = (msg: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(msg) + "\n", (err) => err ? reject(err) : resolve()));

let nextId = 1000;
const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
/** Ask the client something and wait for the answer. */
function ask(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  const p = new Promise<Record<string, unknown>>((r) => waiting.set(id, r));
  void send({ jsonrpc: "2.0", id, method, params });
  return p;
}
const update = (sessionId: string, u: Record<string, unknown>) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

let sessions = 0;
/** Whether the client accepts `notice` updates (else notices go into the reply, as Claude's adapter does). */
let clientNotices = false;
const modes = new Map<string, string>();

async function runPrompt(sessionId: string, text: string): Promise<Record<string, unknown>> {
  await send({ jsonrpc: "2.0", method: "_fake.dev/metadata", params: { sessionId, contextUsagePercentage: 1 } });

  if (text.includes("FAKE-EXIT")) {
    await update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "About to crash." } });
    process.exit(3);
  }

  if (text.includes("FAKE-FAIL")) {
    // The supervisor tells the agent how to give up — a backticked command ending in a
    // "<reason>" placeholder; run exactly that, as an agent with a shell tool would.
    const cmd = [...text.matchAll(/`([^`]*"<[^"`]*>"[^`]*)`/g)][0]?.[1];
    if (!cmd) {
      await update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "No fail command in the prompt!" } });
      return { stopReason: "end_turn" };
    }
    const concrete = cmd.replace(/"<[^"]*>"/, '"blocked: the fake agent has no credentials"');
    await update(sessionId, { sessionUpdate: "tool_call", toolCallId: "fail-1", title: concrete, kind: "execute", status: "pending" });
    const r = await sh(concrete);
    const output = r.output;
    await update(sessionId, {
      sessionUpdate: "tool_call_update", toolCallId: "fail-1", status: r.code === 0 ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: output } }],
    });
    await update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I gave up on this one." } });
    return { stopReason: "end_turn" };
  }

  // The default: a turn with one permission-gated tool call.
  await update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it." } });
  await update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t-1", title: "echo hi", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
  const permission = await ask("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "t-1", title: "echo hi" },
    options: [
      { optionId: "opt-allow", name: "Yes", kind: "allow_once" },
      { optionId: "opt-always", name: "Always", kind: "allow_always" },
      { optionId: "opt-reject", name: "No", kind: "reject_once" },
    ],
  });
  const outcome = (permission.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
  const chosen = outcome?.optionId ?? outcome?.outcome ?? "none";
  await update(sessionId, {
    sessionUpdate: "tool_call_update", toolCallId: "t-1", status: chosen === "opt-allow" ? "completed" : "failed",
    content: [{ type: "content", content: { type: "text", text: chosen === "opt-allow" ? "hi" : "denied" } }],
  });
  // An agent-specific request the client can't know: it must answer "not supported".
  const vendor = await ask("_fake.dev/ask", { sessionId });
  await update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.0123, currency: "USD" } });
  // A notice right before the summary, the way Claude's adapter emits one: as a
  // `notice` for a client that accepts them, otherwise as reply text.
  await update(sessionId, clientNotices
    ? { sessionUpdate: "notice", severity: "warning", title: "Fake notice", description: "Something the user should know." }
    : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "**Fake notice:** Something the user should know.\n" } });
  await update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `Summary: did the work (permission=${chosen}, mode=${modes.get(sessionId) ?? "none"}, session=${sessions}, vendor=${vendor.error ? "refused" : "answered"}).`,
    },
  });
  return {
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 300, cachedWriteTokens: 40, totalTokens: 370 },
  };
}

async function handle(msg: Record<string, unknown>): Promise<void> {
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize":
      clientNotices = typeof ((params.clientCapabilities as { session?: { notices?: unknown } } | undefined)?.session?.notices) === "object";
      return void reply({ protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "fake", version: "0.0.1" } });
    case "session/new":
      sessions++;
      return void reply({ sessionId: `fake-session-${sessions}`, modes: { currentModeId: "ask", availableModes: [{ id: "ask" }, { id: "autonomous" }] } });
    case "session/set_mode":
      modes.set(params.sessionId as string, params.modeId as string);
      return void reply({});
    case "session/prompt": {
      const text = ((params.prompt as Array<{ text?: string }>) ?? []).map((p) => p.text ?? "").join("\n");
      return void reply(await runPrompt(params.sessionId as string, text));
    }
    case "session/cancel":
      return;
    default:
      if (id !== undefined) void send({ jsonrpc: "2.0", id, error: { code: -32601, message: "not supported" } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  buf += chunk as string;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as Record<string, unknown>;
    // A response to something we asked.
    if (typeof msg.id === "number" && !msg.method && waiting.has(msg.id)) {
      waiting.get(msg.id)!(msg);
      waiting.delete(msg.id);
      continue;
    }
    void handle(msg);
  }
}
