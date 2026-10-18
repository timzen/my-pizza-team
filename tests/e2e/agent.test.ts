/**
 * tests/e2e/agent.test.ts — `mpt agent` end to end, with a stand-in ACP agent.
 *
 * A real daemon and the real `mpt agent` supervisor, but tests/fixtures/fake-acp-agent.ts
 * in place of Kiro or Claude Code (`--acp-command`), so it costs nothing and is
 * deterministic. Covers: the experimental gate, a work item completed with its
 * summary, a fresh ACP session per item, permission requests answered, usage and
 * USD cost recorded, the agent giving up through `mpt agent fail`, and the agent
 * crashing mid-item.
 */

import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox, type Sandbox } from "./_sandbox.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "cli", "main.ts");
const FAKE = path.join(REPO, "tests", "fixtures", "fake-acp-agent.ts");
const FAKE_CMD = JSON.stringify([process.execPath, FAKE]);

const api = (sb: Sandbox) => `http://127.0.0.1:${sb.port}`;
async function get<T>(sb: Sandbox, p: string): Promise<T> {
  return await (await fetch(`${api(sb)}${p}`)).json() as T;
}
async function post<T>(sb: Sandbox, p: string, body: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${api(sb)}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as T };
}

/** A Solitary WorkDef, enqueued; returns its id. */
async function work(sb: Sandbox, title: string, goal: string): Promise<string> {
  const r = await post<{ workDef: { id: string } }>(sb, "/api/work-defs", { title, goal, acceptanceCriteria: "- MUST be done" });
  return r.body.workDef.id;
}
const items = (sb: Sandbox) => get<{ items: Array<{ id: string; ref: { workDefId: string }; state: string }> }>(sb, "/api/work-items");
const itemFor = async (sb: Sandbox, defId: string) => (await items(sb)).items.find((i) => i.ref.workDefId === defId);
const comments = async (sb: Sandbox, defId: string) =>
  (await get<{ comments: Array<{ body: string }> }>(sb, `/api/work-defs/${defId}/comments`)).comments.map((c) => c.body);

/** Start `mpt agent` in the background; returns it and a way to read its output. */
function startAgent(sb: Sandbox, harness: string, name: string) {
  const child = spawn(
    process.execPath,
    [CLI, "agent", "--harness", harness, "--acp-command", FAKE_CMD, "--name", name, "--daemon", api(sb)],
    { env: { ...sb.env, MPT_AGENT_POLL_MS: "200" }, cwd: sb.projectDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => stdout += d);
  child.stderr.setEncoding("utf8").on("data", (d: string) => stderr += d);
  const output = new Promise<{ code: number; text: string }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1), text: stdout + stderr }));
  });
  return { child, output };
}

test("without experimental.harnesses the daemon refuses an ACP teammate, loudly", async () => {
  await using sb = await sandbox("agent-gate");
  sb.writeTeamConfig({});
  await sb.startDaemon();
  const agent = startAgent(sb, "kiro", "gated");
  // Bounded: an agent the daemon wrongly accepts would otherwise run forever.
  const timer = setTimeout(() => { try { agent.child.kill("SIGTERM"); } catch { /* exited */ } }, 15_000);
  const { code, text } = await agent.output;
  clearTimeout(timer);
  assertEquals(code, 2, `refused at registration, not left running:\n${text}`);
  assertStringIncludes(text, "experimental");
  // …and won't spawn one either.
  const spawn = await post<{ error?: string }>(sb, "/api/leader/directives", { action: "spawn", params: { harness: "kiro" } });
  assertEquals(spawn.status, 400);
  assertStringIncludes(spawn.body.error ?? "", "experimental");
});

test("an ACP teammate completes work, gives up when told, and is recorded like a Pi one", async () => {
  await using sb = await sandbox("agent-work");
  sb.writeTeamConfig({ experimental: { harnesses: true } });
  await sb.startDaemon();
  // claude's harness sets a session mode, so the fake reports it back.
  const agent = startAgent(sb, "claude", "fake-claude");
  try {
    // Registered under its harness.
    assert(await sb.waitFor(async () => (await get<{ agents: Array<{ id: string; harness?: string }> }>(sb, "/api/agents")).agents.some((a) => a.id === "fake-claude" && a.harness === "claude")));

    // 1. Completes, with its summary as the done comment.
    const one = await work(sb, "First job", "Do the first thing.");
    assert(await sb.waitFor(async () => (await itemFor(sb, one))?.state === "COMPLETE", 20_000), "first item completes");
    const c1 = await comments(sb, one);
    assert(c1.some((c) => c.startsWith("[status] Started")), c1.join("\n"));
    const done = c1.find((c) => c.startsWith("[done]")) ?? "";
    assertStringIncludes(done, "permission=opt-allow"); // answered "allow once", never "always"
    assertStringIncludes(done, "mode=default");         // the harness's mode, not the user's default
    assertStringIncludes(done, "session=1");
    assertStringIncludes(done, "vendor=refused");       // an unknown agent request didn't break anything
    assert(!done.includes("Working on it."), "the summary is the reply after the last tool call");
    assert(!done.includes("Fake notice"), "notices arrive as `notice` updates, not in the reply");

    // 2. A fresh session for the next item.
    const two = await work(sb, "Second job", "Do the second thing.");
    assert(await sb.waitFor(async () => (await itemFor(sb, two))?.state === "COMPLETE", 20_000));
    assert((await comments(sb, two)).some((c) => c.includes("session=2")), "a fresh ACP session per work item");

    // 3. Usage: tokens (incl. cache) and USD cost, on the ledger.
    const today = new Date().toISOString().slice(0, 10);
    const day = await get<{ runs: Array<{ kind: string; costUsd: number; cacheReadTokens?: number }> }>(sb, `/api/usage/day?date=${today}&tzOffset=0`);
    const runs = day.runs.filter((r) => r.kind === "work");
    assertEquals(runs.length, 2, JSON.stringify(day.runs));
    assertEquals(runs[0]!.costUsd, 0.0123);

    // 4. Giving up: the agent runs `mpt agent fail`, and the item is FAILED, not completed.
    const three = await work(sb, "Impossible job", "FAKE-FAIL please.");
    assert(await sb.waitFor(async () => (await itemFor(sb, three))?.state === "FAILED", 30_000), "failed by the agent");
    const c3 = await comments(sb, three);
    assert(c3.some((c) => c === "[failed] blocked: the fake agent has no credentials"), c3.join("\n"));
    assert(!c3.some((c) => c.startsWith("[done]")), "no completion comment on a failed item");
  } finally {
    try { agent.child.kill("SIGTERM"); } catch { /* already exited */ }
    await agent.output;
  }
});

test("an agent that crashes mid-item fails the item with the reason, and the supervisor exits", async () => {
  await using sb = await sandbox("agent-crash");
  sb.writeTeamConfig({ experimental: { harnesses: true } });
  await sb.startDaemon();
  const agent = startAgent(sb, "kiro", "fake-kiro");
  const id = await work(sb, "Crashy job", "FAKE-EXIT now.");
  const { code, text } = await agent.output;
  assertEquals(code, 1, text);
  assertEquals((await itemFor(sb, id))?.state, "FAILED");
  assert((await comments(sb, id)).some((c) => c.includes("agent process exited")));
  // Deregistered, so the pool can replace it.
  assert(!(await get<{ agents: Array<{ id: string }> }>(sb, "/api/agents")).agents.some((a) => a.id === "fake-kiro"));
});
