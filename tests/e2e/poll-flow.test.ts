/**
 * tests/e2e/poll-flow.test.ts — a polling workflow state end to end: a real Pi on
 * the scripted model checks an "external signal" once per run until it's there,
 * and the daemon holds a due check while the team isn't ready (docs/DESIGN.md
 * "Polling States", "Readiness Gating").
 *
 * The demo team's `release-signoff` story (tests/fixtures/demo/team) runs on the
 * `approval-poll` workflow: one teammate state, `completion: "poll"`,
 * `pollEvery: "1m"`, with the `approval-watcher` persona — "wait until
 * `approved.txt` exists in the working directory, then done". The scripted
 * teammate plays that persona: each check runs `test -e approved.txt`, then
 * calls `wait_for_next_check` when the file is missing, or just finishes
 * (done) when it's there.
 *
 *   1. The story is activated; its first check waits: the item ends WAITED, the
 *      task stays in the state with a poll record (one check, its reason, a next
 *      check due), and the `[wait]` comment is on the thread.
 *   2. Readiness forced to not-ready (POST /api/readiness): Check now is refused
 *      with the reason, and once the next check falls due (pollEvery + a tick,
 *      about 90s) it is **held** — `heldForReadiness` with the reason, nothing
 *      queued.
 *   3. Readiness recovers: exactly one check is queued on the next tick (not a
 *      backlog), runs, and waits again; the hold is cleared.
 *   4. The signal file is created, and **Check now** (instead of another minute)
 *      runs the check that finishes the task: done, after exactly three checks.
 *
 * The rest of the demo team is switched off for this suite (the other stories
 * pending, no packages), so the teammate only ever claims the poll task. Slow by
 * design: step 2 waits for a real due time on the daemon's 30s tick (pollEvery's
 * minimum is 1m). Skips only where tmux or harnesses/pi's Pi isn't installed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "../_assert.ts";
import { hasTmux, sandbox } from "./_sandbox.ts";
import { hasPi } from "./_pi.ts";
import { api, demoTeam, type Json, useScriptedPi, windowText } from "./_demo.ts";

const STORY = "release-signoff";
const TASK = "release-signoff-1";
const NOT_READY = "e2e: credentials expired";

/**
 * The approval watcher, scripted. The prompt rule runs the check; the
 * tool-result rules (tried first) read its output: missing → wait, present →
 * a final text, which completes the run (done). After the wait tool's own
 * result the prompt rule's last turn (text) ends the run.
 */
const SCRIPT = {
  leader: [{ name: "leader", turns: [{ text: "Scripted leader: noted." }] }],
  teammate: [
    {
      name: "signal-missing",
      on: "toolResult" as const,
      contains: "SIGNAL:pending",
      turns: [{ toolCalls: [{ name: "wait_for_next_check", arguments: { reason: "approved.txt not there yet." } }] }],
    },
    { name: "signal-present", on: "toolResult" as const, contains: "SIGNAL:approved", turns: [{ text: "Approved." }] },
    {
      name: "check",
      contains: "You are the **approval watcher**",
      turns: [
        { toolCalls: [{ name: "bash", arguments: { command: "test -e approved.txt && echo SIGNAL:approved || echo SIGNAL:pending" } }] },
        { text: "Check finished." },
      ],
    },
  ],
};

test("a poll state: waits, holds a due check while not ready, one check on recovery, done on the signal", { skip: !hasTmux() || !hasPi() }, async () => {
  const started = Date.now();
  await using sb = await sandbox("poll-flow");
  const team = demoTeam(sb);
  // Only the poll story runs: the other ready story goes pending, the tracker and persona packages go.
  const storyFile = (id: string) => path.join(sb.teamDir, "stories", `${id}.json`);
  const auth = JSON.parse(fs.readFileSync(storyFile("add-user-auth"), "utf8"));
  fs.writeFileSync(storyFile("add-user-auth"), JSON.stringify({ ...auth, pending: true }, null, 2));
  team.editConfig((config) => { delete config["packages"]; delete config["sourcePersonas"]; });
  useScriptedPi(sb, team, SCRIPT);
  await sb.startDaemon("source");
  const a = api(sb);

  // The CR example workflow loads too, with its one poll state (validated on load).
  const workflows = (await a.get("/api/workflows")).body as Json[];
  assertEquals(workflows.find((w) => w.name === "cr-review")?.pollStates, ["cr"], JSON.stringify(workflows));
  assertEquals(workflows.find((w) => w.name === "approval-poll")?.pollStates, ["awaiting_approval"]);

  const task = async () => ((await a.get("/api/stories")).body.stories as Json[]).find((s) => s.id === STORY).tasks.find((t: Json) => t.id === TASK);
  const checks = async () => ((await a.get(`/api/work-items?workDefId=${TASK}`)).body.items as Json[]);
  const states = async () => (await checks()).map((i) => i.state).sort().join(",");
  const debug = async (name: string) => `task ${JSON.stringify(await task())}, items ${await states()}\n${await windowText(sb, "tmux", name)}`;

  // ─── A teammate, and the story activated ─────────────────────────
  const spawn = await a.post("/api/leader/directives", { action: "spawn", params: { cwd: sb.projectDir, reason: "e2e-test" } });
  assertEquals(spawn.body.success, true, JSON.stringify(spawn.body));
  const name = spawn.body.directive.params.name as string;
  assertEquals((await a.post(`/api/stories/${STORY}/activate`)).status, 200);

  // ─── 1. The first check waits ────────────────────────────────────
  assert(await sb.waitFor(async () => (await states()) === "WAITED", 60_000), `the first check never waited: ${await debug(name)}`);
  let t = await task();
  assertEquals([t.status, t.poll?.checks, t.poll?.lastWaitReason], ["awaiting_approval", 1, "approved.txt not there yet."], JSON.stringify(t));
  assert(t.poll?.nextCheckAt && !t.poll.heldForReadiness, `no next check due: ${JSON.stringify(t.poll)}`);
  const thread = (await a.get(`/api/work-defs/${TASK}/comments`)).body.comments as Json[];
  assert(thread.some((c) => String(c.body).startsWith("[wait] approved.txt not there yet.")), JSON.stringify(thread));

  // ─── 2. Not ready: Check now refused, the due check held ─────────
  assertEquals((await a.post("/api/readiness", { ready: false, reason: NOT_READY })).status, 200);
  const refused = await a.post(`/api/tasks/${TASK}/check-now`);
  assertEquals([refused.status, refused.body.readiness], [409, NOT_READY], JSON.stringify(refused.body));
  // Due at the first check's end + 1m; the 30s tick then holds it.
  assert(await sb.waitFor(async () => (await task()).poll?.heldForReadiness === true, 120_000),
    `the due check was never held: ${await debug(name)}`);
  t = await task();
  assertEquals([t.poll.heldReason, t.poll.checks, await states()], [NOT_READY, 1, "WAITED"], "held: nothing queued");

  // ─── 3. Recovery: exactly one check ──────────────────────────────
  assertEquals((await a.post("/api/readiness", { ready: true })).status, 200);
  assert(await sb.waitFor(async () => (await states()) === "WAITED,WAITED", 60_000), `no recovery check: ${await debug(name)}`);
  t = await task();
  assertEquals([t.poll.checks, t.poll.heldForReadiness ?? false, t.status], [2, false, "awaiting_approval"], JSON.stringify(t));

  // ─── 4. The signal, then Check now: done ─────────────────────────
  fs.writeFileSync(path.join(sb.projectDir, "approved.txt"), "signed off\n");
  const now = await a.post(`/api/tasks/${TASK}/check-now`);
  assertEquals(now.status, 200, JSON.stringify(now.body));
  assert(await sb.waitFor(async () => (await task()).status === "done", 60_000), `the task never finished: ${await debug(name)}`);
  assertEquals(await states(), "COMPLETE,WAITED,WAITED", "three checks: wait, the recovery check's wait, done");

  console.log(`# poll flow: ${((Date.now() - started) / 1000).toFixed(1)}s`);
});
