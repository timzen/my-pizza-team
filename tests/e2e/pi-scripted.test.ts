/**
 * tests/e2e/pi-scripted.test.ts — a real Pi, with the real MPT extension, on no model.
 *
 * The daemon opens the leader's and a teammate's windows on the sandbox's private
 * tmux server, as it would for a user; the commands are the built-in Pi templates,
 * but each Pi also loads tests/fixtures/pi-scripted-provider.ts and runs its
 * `mpt-mock/scripted` model (tests/e2e/_pi.ts). So everything between the daemon
 * and the model is real — spawning, registration, the chat inbox and bubbles, the
 * claim protocol, the work prompt, tool calls, completion, usage reporting — and
 * nothing calls an LLM or the network.
 *
 * Covers:
 *   - the leader starting from the web UI's Start, registering, and answering a
 *     chat message with scripted text;
 *   - a teammate spawning, claiming a board task, calling an MPT tool for it, and the
 *     task advancing to the workflow's next state when the run ends;
 *   - usage (tokens and the fake cost) landing on the ledger for both runs;
 *   - the teammate's request carrying the state framing and the persona, and MPT's
 *     teammate tools.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";
import { hasTmux, sandbox, type Sandbox } from "./_sandbox.ts";
import { hasPi, readRequestLog, scriptedPiHarness } from "./_pi.ts";

const api = (sb: Sandbox) => `http://127.0.0.1:${sb.port}`;
async function get<T>(sb: Sandbox, p: string): Promise<T> {
  return await (await fetch(`${api(sb)}${p}`)).json() as T;
}
async function send<T>(sb: Sandbox, p: string, body: unknown, method = "POST"): Promise<{ status: number; body: T }> {
  const r = await fetch(`${api(sb)}${p}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as T };
}

/** A window's contents, for failure messages. */
const pane = async (sb: Sandbox, window: string) =>
  (await sb.tmux("capture-pane", "-p", "-J", "-t", `${sb.session}:${window}`)).stdout;

const PERSONA = "You are the scripted implementer. PERSONA-MARKER-7f3a: do exactly what the script says.";

/** The script both Pis play (format: tests/fixtures/pi-scripted-provider.ts). */
const SCRIPT = {
  leader: [
    { name: "chat", contains: "ping from the web", turns: [{ text: "pong from the scripted leader" }] },
  ],
  teammate: [
    {
      name: "work",
      // The task title, from the work prompt the daemon built, fills the tool call.
      regex: "^## Task: (?<title>.+)$",
      turns: [
        { toolCalls: [{ name: "upload_attachment", arguments: { filename: "result.txt", content: "did {{match.title}} as {{role}}" } }] },
        { text: "Finished {{match.title}}: attached result.txt." },
      ],
    },
  ],
  default: [{ name: "fallback", turns: [{ text: "nothing scripted for this" }] }],
};

test("a scripted Pi leads and works a board task end to end, with no model", { skip: !hasTmux() || !hasPi() }, async () => {
  const started = Date.now();
  await using sb = await sandbox("pi-scripted");
  const script = path.join(sb.root, "script.json");
  const log = path.join(sb.root, "requests.jsonl");
  fs.writeFileSync(script, JSON.stringify(SCRIPT, null, 2));
  sb.writeTeamConfig({ minTeammates: 0, harnesses: { pi: scriptedPiHarness({ script, log }) } });
  await sb.startDaemon();

  // ─── The leader: started from the web UI, answers the chat ─────────
  const start = await fetch(`${api(sb)}/api/assistant/start`, { method: "POST" });
  assertEquals(start.status, 201);
  const leaderUp = await sb.waitFor(async () => (await get<{ chatAgent: unknown }>(sb, "/api/assistant/messages")).chatAgent !== null, 20_000);
  assert(leaderUp, `the leader never registered:\n${await pane(sb, "leader")}`);

  const sent = await send(sb, "/api/assistant/messages", { content: "ping from the web" });
  assertEquals(sent.status, 201);
  type Msg = { role?: string; from?: string; content: string };
  const chat = () => get<{ messages: Msg[] }>(sb, "/api/assistant/messages");
  const answered = await sb.waitFor(async () => (await chat()).messages.some((m) => m.content.includes("pong from the scripted leader")), 15_000);
  assert(answered, `no scripted reply in the chat:\n${JSON.stringify((await chat()).messages)}\n${await pane(sb, "leader")}`);

  // ─── A teammate: claims a board task, calls a tool, completes it ───
  const persona = await send<{ persona: { id: string } }>(sb, "/api/personas", { id: "scripted-implementer", title: "Scripted implementer", content: PERSONA });
  assertEquals(persona.status, 201, JSON.stringify(persona.body));
  const wf = await send(sb, "/api/workflows/default/states/in_progress", { persona: "scripted-implementer" }, "PUT");
  assertEquals(wf.status, 200, JSON.stringify(wf.body));
  const story = await send<{ story: { tasks: Array<{ id: string }> } }>(sb, "/api/stories", {
    id: "scripted", title: "Scripted story", description: "Exercise the scripted provider.", workflow: "default",
    directory: sb.projectDir,
    tasks: [{ title: "Bake the pizza", description: "Put it in the oven." }],
  });
  assertEquals(story.status, 201, JSON.stringify(story.body));
  const taskId = story.body.story.tasks[0]!.id;

  const spawn = await send<{ directive: { params: { name: string } } }>(sb, "/api/leader/directives", { action: "spawn", params: { cwd: sb.projectDir } });
  const name = spawn.body.directive.params.name;

  type Story = { id: string; tasks: Array<{ id: string; status: string }> };
  const taskStatus = async () =>
    (await get<{ stories: Story[] }>(sb, "/api/stories")).stories.find((s) => s.id === "scripted")?.tasks.find((t) => t.id === taskId)?.status;
  const advanced = await sb.waitFor(async () => (await taskStatus()) === "review", 30_000);
  assert(advanced, `the task didn't reach review (status ${await taskStatus()}):\n${await pane(sb, name)}`);

  // The tool call ran against the item the teammate claimed, and its summary is the done comment.
  // (A board task's id is its WorkDef's.)
  const comments = await get<{ comments: Array<{ body: string }> }>(sb, `/api/work-defs/${taskId}/comments`);
  const bodies = comments.comments.map((c) => c.body);
  assert(bodies.some((b) => b.startsWith("[done]") && b.includes("Finished Bake the pizza: attached result.txt.")), bodies.join("\n"));
  const attachments = await get<{ attachments: Array<{ name: string; storedName: string }> }>(sb, `/api/work-defs/${taskId}/attachments`);
  const file = attachments.attachments.find((a) => a.name === "result.txt");
  assert(file, JSON.stringify(attachments));
  const attached = await fetch(`${api(sb)}/api/work-defs/${taskId}/attachments/${encodeURIComponent(file.storedName)}`);
  assertEquals(await attached.text(), "did Bake the pizza as teammate", "placeholders filled from the prompt and the role");

  // ─── Usage: both runs on the ledger, with the provider's fake cost ─
  const today = new Date().toISOString().slice(0, 10);
  type Run = { kind: string; costUsd: number; inputTokens: number; outputTokens: number; model?: string };
  const runs = async () => (await get<{ runs: Run[] }>(sb, `/api/usage/day?date=${today}&tzOffset=0`)).runs;
  assert(await sb.waitFor(async () => (await runs()).some((r) => r.kind === "work") && (await runs()).some((r) => r.kind === "chat"), 10_000), JSON.stringify(await runs()));
  const work = (await runs()).find((r) => r.kind === "work")!;
  // Two turns (tool call, then the summary) at the default 1000 in / 50 out / 200 cache read.
  assertEquals(work.inputTokens, 2000, JSON.stringify(work));
  assertEquals(work.outputTokens, 100, JSON.stringify(work));
  assertEquals(Math.round(work.costUsd * 1e6), 23_400, JSON.stringify(work));
  const chatRun = (await runs()).find((r) => r.kind === "chat")!;
  assertEquals(Math.round(chatRun.costUsd * 1e6), 11_700, JSON.stringify(chatRun));

  // ─── The request log: what each Pi actually sent its model ─────────
  const requests = readRequestLog(log);
  const leaderReq = requests.find((r) => r.role === "leader" && r.rule === "chat");
  assert(leaderReq, `no leader chat request logged: ${requests.map((r) => `${r.role}/${r.rule}`).join(", ")}`);

  const workReqs = requests.filter((r) => r.role === "teammate" && r.rule === "work");
  assertEquals(workReqs.map((r) => r.turn), [0, 1], "the work rule played its two turns in order");
  const prompt = workReqs[0]!.messages.findLast((m) => m.role === "user")!.text;
  assertStringIncludes(prompt, "## Your Role: in_progress");
  assertStringIncludes(prompt, "PERSONA-MARKER-7f3a");
  assertStringIncludes(prompt, "## Story: Scripted story");
  assertStringIncludes(prompt, "## Task: Bake the pizza");
  for (const tool of ["upload_attachment", "fail", "propose_work"]) {
    assert(workReqs[0]!.tools.includes(tool), `teammate tools lack ${tool}: ${workReqs[0]!.tools.join(", ")}`);
  }
  // The second turn saw the tool's result.
  assert(workReqs[1]!.messages.some((m) => m.role === "toolResult"), JSON.stringify(workReqs[1]!.messages));

  const seconds = (Date.now() - started) / 1000;
  console.log(`# scripted Pi e2e: ${seconds.toFixed(1)}s, ${requests.length} model requests, none to a real model`);
  assert(seconds < 60, `took ${seconds}s`);
});
