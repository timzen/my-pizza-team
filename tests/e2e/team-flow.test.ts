/**
 * tests/e2e/team-flow.test.ts — the demo team at work: a leader and a teammate,
 * both real Pis on the scripted model, finish the demo story and the tracker's
 * issues, under tmux and under herdr.
 *
 * Ported from mpt-demo-team's run-e2e.sh ("Start the assistant", "Spawn Worker
 * Agent", "The worker's in-flight persona", and the monitor loop it ended in),
 * with a verdict instead of the loop: the run-e2e.sh flow left the worker to a
 * real model and watched forever; here the scripted provider (tests/e2e/_pi.ts)
 * plays every turn, so the flow runs to the end and asserts on it.
 *
 *   1. herdr only: the terminal is switched through PUT /api/config (Config →
 *      General), and /health agrees.
 *   2. The assistant starts through POST /api/assistant/start and registers.
 *   3. A spawn directive (POST /api/leader/directives) — realized by the daemon,
 *      the only terminal owner — opens a teammate, which registers.
 *   4. The teammate's first run is held at a gate (a bash tool call waiting on a
 *      file) so GET /api/agents can be read mid-run: it shows the persona the run
 *      recorded at claim (the UI's ✦ chip) — demo-coder for a board task, the
 *      tracker's personas for its issues. Then the gate opens.
 *   5. The teammate works everything in order: the story's three tasks (each
 *      moved review → done by the test, as the reviewing human would, which
 *      releases the next), DEMO-1 and DEMO-2 (worked: the tracker marks them
 *      done), DEMO-3 (triage mode: a propose_work call, pending on its Triage tab;
 *      the issue stays open). The pending story and the Solitary task never run.
 *   6. Each run's prompt carried its persona (the request log).
 *
 * Isolation: the sandbox's private tmux server, and for herdr its own config dir
 * and session (tests/e2e/_herdr.ts). Skips only where tmux / herdr, or
 * harnesses/pi's Pi, isn't installed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";
import { hasTmux, sandbox } from "./_sandbox.ts";
import { hasHerdr, herdrSandbox } from "./_herdr.ts";
import { hasPi, readRequestLog } from "./_pi.ts";
import {
  api, demoTeam, itemPersona, type Json, switchToHerdr, teamWindows, type Terminal, TRACKER, useScriptedPi, windowText,
} from "./_demo.ts";

const SKIP: Record<Terminal, boolean> = { tmux: !hasTmux() || !hasPi(), herdr: !hasHerdr() || !hasPi() };

const STORY = "add-user-auth";
const TASKS = ["add-user-auth-1", "add-user-auth-2", "add-user-auth-3"];

/** The persona each WorkDef's run must record and carry: [id, a line of its text]. */
const EXPECTED_PERSONA: Record<string, [string, string]> = {
  ...Object.fromEntries(TASKS.map((t) => [t, ["demo-coder", "You are the **demo coder**"]])),
  [`${TRACKER}~DEMO-1`]: ["mpt-source-demo-tracker/tracker-worker", "You are working an issue from the **Demo Tracker**"],
  [`${TRACKER}~DEMO-2`]: ["mpt-source-demo-tracker/tracker-worker", "You are working an issue from the **Demo Tracker**"],
  [`${TRACKER}~DEMO-3`]: ["mpt-personas-demo/tracker-triager", "You are the **tracker triager**"],
};

/**
 * What the teammate plays. Every run opens with the gate (a no-op once released),
 * so the first run can be observed mid-flight. A triage run then proposes one
 * task; a work run just reports back, which completes it.
 */
function teammateScript(gate: string, projectDir: string) {
  const gateCall = { toolCalls: [{ name: "bash", arguments: { command: `sh '${gate}'` } }] };
  return {
    leader: [{ name: "leader", turns: [{ text: "Scripted leader: noted." }] }],
    teammate: [
      {
        name: "triage",
        contains: "## Your Role: Triage",
        turns: [
          gateCall,
          {
            toolCalls: [{
              name: "propose_work",
              arguments: {
                outcome: "proposals",
                body: "Scripted triage: one small task covers it.",
                proposals: [{ id: "p1", kind: "task", title: "Add due dates", goal: "Accept an optional dueDate on POST /todos.", directory: projectDir }],
              },
            }],
          },
          { text: "Triaged: proposed one task." },
        ],
      },
      { name: "work", turns: [gateCall, { text: "Scripted teammate: done." }] },
    ],
  };
}

for (const terminal of ["tmux", "herdr"] as const) {
  test(`${terminal}: a scripted leader and teammate finish the demo story and the tracker's issues`, { skip: SKIP[terminal] }, async () => {
    const started = Date.now();
    await using sb = await sandbox(`team-flow-${terminal}`);
    // Declared after the sandbox, so it is torn down first: stopping the herdr
    // server ends the agents in its panes before the sandbox reaps and removes.
    await using hs = terminal === "herdr" ? await herdrSandbox() : undefined;
    const team = demoTeam(sb);

    // The gate: blocks until `released` exists (then every later run passes straight through).
    const released = path.join(sb.root, "released");
    const gate = path.join(sb.root, "gate.sh");
    fs.writeFileSync(gate, `while [ ! -e '${released}' ]; do sleep 0.1; done\necho gate open\n`);
    const log = useScriptedPi(sb, team, teammateScript(gate, sb.projectDir), hs);
    await sb.startDaemon("source", { env: hs?.daemonEnv ?? {} });
    const a = api(sb);
    if (hs) await switchToHerdr(a, hs);

    // ─── The assistant ────────────────────────────────────────────────
    const start = await a.post("/api/assistant/start");
    assertEquals([start.status, start.body.terminal], [201, terminal], JSON.stringify(start.body));
    const agents = async () => (await a.get("/api/agents")).body.agents as Json[];
    assert(await sb.waitFor(async () => (await agents()).some((m) => m.id === "leader"), 30_000),
      `the leader never registered:\n${await windowText(sb, terminal, "leader", hs)}`);

    // ─── A teammate, spawned by the daemon ────────────────────────────
    const spawn = await a.post("/api/leader/directives", { action: "spawn", params: { cwd: sb.projectDir, reason: "e2e-test" } });
    assertEquals(spawn.body.success, true, JSON.stringify(spawn.body));
    const name = spawn.body.directive.params.name as string;
    const worker = async () => (await agents()).find((m) => m.id !== "leader");
    assert(await sb.waitFor(async () => !!(await worker()), 30_000),
      `no teammate registered (spawn requests: ${JSON.stringify((await a.get("/api/spawn-requests")).body)}):\n${await windowText(sb, terminal, name, hs)}`);

    assert((await teamWindows(sb, terminal, hs)).includes(name), `no ${name} window in ${terminal}: ${await teamWindows(sb, terminal, hs)}`);

    // ─── Its in-flight persona, mid-run at the gate ───────────────────
    assert(await sb.waitFor(async () => !!(await worker())?.persona, 30_000),
      `the teammate never showed an in-flight persona: ${JSON.stringify(await worker())}\n${await windowText(sb, terminal, name, hs)}`);
    const busy = (await worker())!;
    const inFlight = ((await a.get(`/api/work-items/${busy.workItemId}`)).body.item) as Json;
    const expected = EXPECTED_PERSONA[inFlight.ref.workDefId];
    assert(expected, `the teammate claimed something unexpected: ${inFlight.ref.workDefId}`);
    assertEquals(busy.persona.id, expected[0], JSON.stringify(busy.persona));
    assertEquals((await itemPersona(a, busy.workItemId))?.[0], expected[0], "the in-flight persona is the run's recorded one");
    fs.writeFileSync(released, "");

    // ─── Everything gets done ─────────────────────────────────────────
    type Task = { id: string; status: string };
    const tasks = async () => ((await a.get("/api/stories")).body.stories as Json[]).find((s) => s.id === STORY).tasks as Task[];
    const triaged = async () => ((await a.get(`/api/work-defs/${TRACKER}~DEMO-3/triage`)).body.pending ?? []).length > 0;
    const finished = async () => {
      // The reviewing human: each task that reaches review is approved, releasing the next.
      for (const t of await tasks()) if (t.status === "review") await a.post(`/api/tasks/${t.id}/move`, { status: "done" });
      return (await tasks()).every((t) => t.status === "done")
        && team.issue("DEMO-1").status === "done" && team.issue("DEMO-2").status === "done"
        && await triaged();
    };
    const done = await sb.waitFor(finished, 90_000);
    assert(done, `not everything finished: tasks ${JSON.stringify(await tasks())}, tracker ${
      JSON.stringify(team.issues().map((i) => [i.id, i.status]))}, DEMO-3 triaged ${await triaged()}\n${await windowText(sb, terminal, name, hs)}`);

    // DEMO-3 was triaged, not done: open, with its outcome on the thread and one pending proposal.
    assertEquals(team.issue("DEMO-3").status, "open");
    assert(await sb.waitFor(() => (team.issue("DEMO-3").comments ?? []).some((c) => /triage .* ended COMPLETE/.test(c.body))),
      JSON.stringify(team.issue("DEMO-3")));
    const triage = (await a.get(`/api/work-defs/${TRACKER}~DEMO-3/triage`)).body;
    assertEquals([triage.badge, triage.pending.length, triage.pending[0]?.proposal?.title ?? triage.pending[0]?.title],
      ["proposal", 1, "Add due dates"], JSON.stringify(triage));

    // Never run: the pending story's task, and the Solitary task (run on demand only).
    const items = (await a.get("/api/work-items")).body.items as Json[];
    for (const id of ["ui-theme-polish-1", "audit-project-dependencies"]) {
      assertEquals(items.filter((i) => i.ref.workDefId === id).length, 0, `${id} ran`);
    }

    // ─── Each run's prompt carried its persona ────────────────────────
    // (And the gate really ran: a bash tool result, not a tool error the run raced past.)
    const gateResults = readRequestLog(log).filter((r) => r.role === "teammate" && r.turn === 1)
      .map((r) => r.messages.findLast((m) => m.role === "toolResult")?.text ?? "");
    assert(gateResults.length === 6 && gateResults.every((t) => t.includes("gate open")), JSON.stringify(gateResults));
    const prompts = readRequestLog(log)
      .filter((r) => r.role === "teammate" && r.turn === 0)
      .map((r) => r.messages.findLast((m) => m.role === "user")!.text);
    for (const [def, [, text]] of Object.entries(EXPECTED_PERSONA)) {
      const item = items.find((i) => i.ref.workDefId === def && i.state === "COMPLETE");
      assert(item, `no COMPLETE run of ${def}: ${JSON.stringify(items.filter((i) => i.ref.workDefId === def))}`);
      assertEquals((await itemPersona(a, item.id))?.[0], EXPECTED_PERSONA[def]![0], `${def}'s recorded persona`);
      const title = String(item.title).replace(/^Triage: /, "");
      const prompt = prompts.find((p) => p.includes(title));
      assert(prompt, `no logged prompt for ${def} ("${title}")`);
      assertStringIncludes(prompt, text);
    }

    const seconds = (Date.now() - started) / 1000;
    console.log(`# team flow (${terminal}): ${seconds.toFixed(1)}s, ${readRequestLog(log).length} scripted model requests`);
  });
}
