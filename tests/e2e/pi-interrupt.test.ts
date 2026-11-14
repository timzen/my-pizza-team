/**
 * tests/e2e/pi-interrupt.test.ts — Interrupt, end to end, on a real Pi with no model
 * (docs/DESIGN.md "Stalled Teammates"; daemon/routes/stalls.ts, runtime/interrupt.ts,
 * harnesses/pi/src/index.ts).
 *
 * A scripted teammate (tests/e2e/_pi.ts) claims a board task and runs a bash
 * command that never returns — a backgrounded `sleep` and a foreground one, the
 * shape of a test runner whose worker never settles. The user interrupts it
 * (`POST /api/agents/:id/interrupt`), and:
 *
 *   - every process the command started is gone (Pi's own abort, `ctx.abort()`,
 *     kills the bash tool's process group);
 *   - the item is not completed by the aborted run: the teammate gets the nudge
 *     ("Your last command (`sleep …`) was interrupted by the user …") as its next
 *     message, answers it, and only that run completes the task;
 *   - the directive is reported done (`lastInterrupt` on GET /api/agents), and the
 *     harness declared `interrupt` (`interruptSupported`).
 *
 * (The stall flag and its Inbox note need heartbeats 30 s apart and a threshold in
 * minutes: they're covered on a fake clock in tests/stall*.test.ts.)
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
async function send<T>(sb: Sandbox, p: string, body: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${api(sb)}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as T };
}
const pane = async (sb: Sandbox, window: string) =>
  (await sb.tmux("capture-pane", "-p", "-J", "-t", `${sb.session}:${window}`)).stdout;

/** Is process `pid` alive? */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a scripted Pi teammate's hung command is interrupted: the tree is killed, it is nudged, and the item completes", { skip: !hasTmux() || !hasPi() }, async () => {
  const started = Date.now();
  await using sb = await sandbox("pi-interrupt");
  const script = path.join(sb.root, "script.json");
  const log = path.join(sb.root, "requests.jsonl");
  const pidFile = path.join(sb.root, "hung.pids");
  const command = `sleep 3613 & echo $! > ${JSON.stringify(pidFile)}; echo $$ >> ${JSON.stringify(pidFile)}; sleep 3614`;
  fs.writeFileSync(script, JSON.stringify({
    teammate: [
      { name: "work", contains: "## Task: Hang the tests", turns: [{ toolCalls: [{ name: "bash", arguments: { command } }] }, { text: "unreachable: the command never returns" }] },
      { name: "nudge", contains: "was interrupted by the user", turns: [{ text: "The test never settled; re-ran it with a timeout. Done." }] },
    ],
    default: [{ name: "fallback", turns: [{ text: "nothing scripted for this" }] }],
  }, null, 2));
  sb.writeTeamConfig({ minTeammates: 0, harnesses: { pi: scriptedPiHarness({ script, log }) } });
  await sb.startDaemon();

  const story = await send<{ story: { tasks: Array<{ id: string }> } }>(sb, "/api/stories", {
    id: "hang", title: "Hang story", description: "A command that never returns.", workflow: "default",
    directory: sb.projectDir, tasks: [{ title: "Hang the tests", description: "Run the suite." }],
  });
  assertEquals(story.status, 201, JSON.stringify(story.body));
  const taskId = story.body.story.tasks[0]!.id;
  const spawn = await send<{ directive: { params: { name: string } } }>(sb, "/api/leader/directives", { action: "spawn", params: { cwd: sb.projectDir } });
  const name = spawn.body.directive.params.name;

  // The command runs, and hangs.
  const pids = () => fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
  assert(await sb.waitFor(() => pids().length === 2 && pids().every(alive), 30_000), `the command never started:\n${await pane(sb, name)}`);
  const hung = pids();

  type Agent = { id: string; name: string; interruptSupported?: boolean; lastInterrupt?: { status: string; error: string | null } | null };
  const teammate = async () => (await get<{ agents: Agent[] }>(sb, "/api/agents")).agents.find((a) => a.name === name)!;
  assertEquals((await teammate()).interruptSupported, true, "the Pi harness declares `interrupt`");

  // Interrupt.
  const res = await send<{ directive: { id: string } }>(sb, `/api/agents/${encodeURIComponent((await teammate()).id)}/interrupt`, {});
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assert(await sb.waitFor(() => !hung.some(alive), 15_000), `still alive after the interrupt: ${hung.filter(alive).join(", ")}\n${await pane(sb, name)}`);

  // The nudge's run completes the task; the aborted run didn't.
  type Story = { id: string; tasks: Array<{ id: string; status: string }> };
  const taskStatus = async () => (await get<{ stories: Story[] }>(sb, "/api/stories")).stories.find((s) => s.id === "hang")?.tasks.find((t) => t.id === taskId)?.status;
  assert(await sb.waitFor(async () => (await taskStatus()) === "review", 20_000), `the task didn't reach review (status ${await taskStatus()}):\n${await pane(sb, name)}`);
  const bodies = (await get<{ comments: Array<{ body: string }> }>(sb, `/api/work-defs/${taskId}/comments`)).comments.map((c) => c.body);
  const done = bodies.filter((b) => b.startsWith("[done]"));
  assertEquals(done.length, 1, bodies.join("\n"));
  assertStringIncludes(done[0]!, "The test never settled; re-ran it with a timeout. Done.");
  assert(await sb.waitFor(async () => (await teammate())?.lastInterrupt?.status === "done", 10_000), JSON.stringify(await teammate()));

  // What the model was told.
  const nudge = readRequestLog(log).find((r) => r.role === "teammate" && r.rule === "nudge");
  assert(nudge, `no nudge request: ${readRequestLog(log).map((r) => `${r.role}/${r.rule}`).join(", ")}`);
  const text = nudge.messages.findLast((m) => m.role === "user")!.text;
  assert(text.startsWith("Your last command (`sleep 3613 & "), text);
  assertStringIncludes(text, "was interrupted by the user after 0m with no progress. It likely hung.");
  assertStringIncludes(text, "re-run with a timeout, then continue your task.");

  const seconds = (Date.now() - started) / 1000;
  console.log(`# scripted Pi interrupt e2e: ${seconds.toFixed(1)}s`);
  assert(seconds < 60, `took ${seconds}s`);
});
