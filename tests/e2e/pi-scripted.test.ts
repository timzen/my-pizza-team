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
 *   - the teammate's request carrying the state's persona in its system prompt
 *     (not in the work prompt), and MPT's teammate tools;
 *   - the persona's `tools` policy narrowing the declared tools (MPT's kept), and
 *     a pattern that matches nothing reported once on the item's thread;
 *   - model switching: the available models reported, a user's pin realized by
 *     the teammate and the leader (`set-model`), an unknown model failed;
 *   - the persona's `model` alias (team config `modelAliases.pi`) switching the
 *     teammate to `mpt-mock/scripted-strong` for the item — every work request
 *     and the usage ledger's run name it — while the leader stays on `scripted`,
 *     and the teammate is back on `scripted` once the item ends.
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
  sb.writeTeamConfig({
    minTeammates: 0, harnesses: { pi: scriptedPiHarness({ script, log }) },
    modelAliases: { pi: { strong: "mpt-mock/scripted-strong" } },
  });
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
  const persona = await send<{ persona: { id: string } }>(sb, "/api/personas", {
    id: "scripted-implementer", title: "Scripted implementer", content: PERSONA,
    // Scopes the teammate's tools (harnesses/pi/src/persona-scope.ts): only `read`
    // plus MPT's own tools; the pattern matching nothing is reported on the thread.
    tools: { allow: ["read", "nomatch*"] },
    // Switches the teammate's model for the item (harnesses/pi/src/persona-model.ts).
    model: "strong",
  });
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
  // The ledger names the model each run actually used: the persona's for the work.
  assertEquals(work.model, "scripted-strong", JSON.stringify(work));
  assertEquals(chatRun.model, "scripted", JSON.stringify(chatRun));

  // ─── The request log: what each Pi actually sent its model ─────────
  const requests = readRequestLog(log);
  const leaderReq = requests.find((r) => r.role === "leader" && r.rule === "chat");
  assert(leaderReq, `no leader chat request logged: ${requests.map((r) => `${r.role}/${r.rule}`).join(", ")}`);

  const workReqs = requests.filter((r) => r.role === "teammate" && r.rule === "work");
  assertEquals(workReqs.map((r) => r.turn), [0, 1], "the work rule played its two turns in order");
  const prompt = workReqs[0]!.messages.findLast((m) => m.role === "user")!.text;
  // The persona is in the system prompt (the Pi harness declares
  // `persona-system-prompt`), and only there: not in the work prompt.
  for (const req of workReqs) {
    assertStringIncludes(req.systemPrompt, "## Your Role: in_progress");
    assertStringIncludes(req.systemPrompt, "PERSONA-MARKER-7f3a");
  }
  assert(!prompt.includes("## Your Role"), `the work prompt still carries the role:\n${prompt}`);
  assert(!workReqs[0]!.messages.some((m) => m.text.includes("PERSONA-MARKER-7f3a")), "the persona leaked into a message");
  assert(prompt.startsWith("## Story: Scripted story"), prompt);
  assertStringIncludes(prompt, "## Story: Scripted story");
  assertStringIncludes(prompt, "## Task: Bake the pizza");
  for (const tool of ["upload_attachment", "fail", "propose_work"]) {
    assert(workReqs[0]!.tools.includes(tool), `teammate tools lack ${tool}: ${workReqs[0]!.tools.join(", ")}`);
  }
  // The persona's tool policy: `read` and MPT's tools are declared, Pi's other
  // built-ins are not, and the unmatched pattern got one comment on the thread.
  for (const req of workReqs) {
    assert(req.tools.includes("read"), `read missing: ${req.tools.join(", ")}`);
    for (const tool of ["bash", "edit", "write"]) assert(!req.tools.includes(tool), `${tool} offered despite the persona: ${req.tools.join(", ")}`);
  }
  const scopeNotes = bodies.filter((b) => b.includes("persona scripted-implementer: tools.allow pattern 'nomatch*' matched no tools"));
  assertEquals(scopeNotes.length, 1, bodies.join("\n"));
  // The persona's model: every work request went to the alias's model, the leader's didn't.
  for (const req of workReqs) assertEquals(req.model, "mpt-mock/scripted-strong", "the work ran on the persona's model");
  assertEquals(leaderReq.model, "mpt-mock/scripted");
  assert(!bodies.some((b) => b.includes("[persona model]") || b.includes("can't be used")), bodies.join("\n"));
  // After the item the teammate is back on the default (restored, then a fresh session):
  // the Team tab's model, reported on model_select.
  type Agent = { name: string; session?: { model?: { id: string } | null } };
  const teammateModel = async () => (await get<{ agents: Agent[] }>(sb, "/api/agents")).agents.find((a) => a.name === name)?.session?.model?.id;
  assert(await sb.waitFor(async () => (await teammateModel()) === "scripted", 10_000), `teammate model: ${await teammateModel()}`);

  // ─── Model switching (docs/DESIGN.md "Choosing a Model") ───────────
  // The teammate reported what it can use; a user's pin is realized by the
  // agent (set-model) and the Team tab's model follows; an unknown model fails
  // with the harness's reason; the assistant takes the same route.
  type ModelState = {
    supported: boolean; models: Array<{ ref: string }> | null; pin: string | null;
    lastChange: { status: string; error: string | null } | null;
  };
  const teammateId = (await get<{ agents: Array<{ id: string; name: string }> }>(sb, "/api/agents")).agents.find((a) => a.name === name)!.id;
  const modelState = (id: string) => get<ModelState>(sb, `/api/agents/${encodeURIComponent(id)}/model`);
  const before = await modelState(teammateId);
  assert(before.supported, JSON.stringify(before));
  assert(before.models?.some((m) => m.ref === "mpt-mock/scripted-strong"), JSON.stringify(before.models));
  assertEquals((await send(sb, `/api/agents/${teammateId}/model`, { model: "mpt-mock/scripted-strong" })).status, 201);
  assert(await sb.waitFor(async () => (await modelState(teammateId)).lastChange?.status === "done" && (await teammateModel()) === "scripted-strong", 15_000),
    `pin not realized: ${JSON.stringify(await modelState(teammateId))}, model ${await teammateModel()}`);
  assertEquals((await modelState(teammateId)).pin, "mpt-mock/scripted-strong");
  assertEquals((await send(sb, `/api/agents/${teammateId}/model`, { model: "mpt-mock/no-such-model" })).status, 201);
  assert(await sb.waitFor(async () => (await modelState(teammateId)).lastChange?.status === "failed", 15_000), JSON.stringify(await modelState(teammateId)));
  assertStringIncludes((await modelState(teammateId)).lastChange!.error ?? "", "isn't a model this Pi knows");
  assertEquals((await modelState(teammateId)).pin, "mpt-mock/scripted-strong", "a refused model doesn't move the pin");
  // The assistant (the leader), through the same per-agent route.
  assertEquals((await send(sb, "/api/agents/leader/model", { model: "mpt-mock/scripted-strong" })).status, 201);
  const leaderModel = async () => (await get<{ agents: Array<Agent & { id: string }> }>(sb, "/api/agents")).agents.find((a) => a.id === "leader")?.session?.model?.id;
  assert(await sb.waitFor(async () => (await modelState("leader")).lastChange?.status === "done" && (await leaderModel()) === "scripted-strong", 15_000),
    `leader pin not realized: ${JSON.stringify(await modelState("leader"))}, model ${await leaderModel()}`);

  // The second turn saw the tool's result.
  assert(workReqs[1]!.messages.some((m) => m.role === "toolResult"), JSON.stringify(workReqs[1]!.messages));

  const seconds = (Date.now() - started) / 1000;
  console.log(`# scripted Pi e2e: ${seconds.toFixed(1)}s, ${requests.length} model requests, none to a real model`);
  assert(seconds < 60, `took ${seconds}s`);
});
