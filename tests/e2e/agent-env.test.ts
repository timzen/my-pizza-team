/**
 * tests/e2e/agent-env.test.ts — the agent env file (`agentEnvFile`) reaching real windows.
 *
 * The unit tests assert the argv (`new-window -e KEY=VALUE`); this proves tmux takes
 * it and that the variable is in the window's shell — on a tmux server started
 * *before* the file existed, which is the stale-environment case the feature is for
 * (a long-lived server hands new windows its start-up environment, not the file's).
 *
 *   - `mpt lead` gives the leader's window the file's variables (fresh session:
 *     `new-session -e`);
 *   - the daemon gives a spawned teammate's window the file's variables, and an edit
 *     to the file reaches the next teammate with no daemon or tmux restart;
 *   - a bad file never blocks a spawn or the leader: the window opens without it, and
 *     `mpt lead` / `mpt doctor` say why.
 *
 * Stand-in agent commands print `$VAR` from the window's shell; `$((40+2))` marks
 * output only execution can produce (see tests/e2e/tmux-lifecycle.test.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../_assert.ts";
import { hasTmux, sandbox, type Sandbox } from "./_sandbox.ts";

const HARNESSES = {
  pi: {
    teammate: "echo SPAWNED-$((40+2)) name={name} v=[$MPT_E2E_VAR] w=[$MPT_E2E_WORDS]; sleep 30",
    leader: "echo LEADER-$((40+2)) v=[$MPT_E2E_VAR] w=[$MPT_E2E_WORDS]; sleep 30",
  },
};

const windows = async (sb: Sandbox) =>
  (await sb.tmux("list-windows", "-t", sb.session, "-F", "#{window_name}")).stdout.split("\n").filter(Boolean);

const pane = async (sb: Sandbox, window: string) =>
  (await sb.tmux("capture-pane", "-p", "-J", "-t", `${sb.session}:${window}`)).stdout;

/** The output line starting at `marker` (only execution prints it), once it appears. */
async function outputLine(sb: Sandbox, window: string, marker: string): Promise<string> {
  await sb.waitFor(async () => (await pane(sb, window)).includes(marker), 8000);
  const line = (await pane(sb, window)).split("\n").find((l) => l.includes(marker)) ?? "";
  return line.slice(line.indexOf(marker));
}

async function spawnTeammate(sb: Sandbox): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${sb.port}/api/leader/directives`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "spawn", params: { cwd: sb.projectDir } }),
  });
  const name = ((await res.json()) as { directive: { params: { name: string } } }).directive.params.name;
  const appeared = await sb.waitFor(async () => (await windows(sb)).includes(name), 8000);
  assertEquals(appeared, true, `no window for ${name}; windows: ${await windows(sb)}`);
  return name;
}

test("mpt lead gives the leader's window the env file's variables", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("env-lead");
  // A tmux server already running without the variables — the stale-server case.
  await sb.tmux("new-session", "-d", "-s", "stale");
  sb.writeTeamConfig({ harnesses: HARNESSES, agentEnvFile: "agent.env" });
  fs.writeFileSync(path.join(sb.teamDir, "agent.env"), `# test\nMPT_E2E_VAR=from-file\nMPT_E2E_WORDS="two words"\n`);

  const result = await sb.mpt("lead", "--no-attach");
  assertEquals(result.code, 0, result.output);
  assertStringIncludes(result.output, "Agent env: 2 variable(s)");
  assertEquals(await windows(sb), ["leader"], "still exactly one window in a fresh session");

  const out = await outputLine(sb, "leader", "LEADER-42 ");
  assertStringIncludes(out, "v=[from-file]");
  assertStringIncludes(out, "w=[two words]");
});

test("a bad env file doesn't stop mpt lead: it starts without it and says why", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("env-lead-bad");
  sb.writeTeamConfig({ harnesses: HARNESSES, agentEnvFile: "agent.env" });
  fs.writeFileSync(path.join(sb.teamDir, "agent.env"), "MPT_E2E_VAR=secret-value\nexport NOPE=1\n");

  const result = await sb.mpt("lead", "--no-attach");
  assertEquals(result.code, 0, result.output);
  assertStringIncludes(result.output, "agentEnvFile not applied");
  assertStringIncludes(result.output, "line 2");
  assertEquals(result.output.includes("secret-value"), false, "a value is never printed");
  assertStringIncludes(await outputLine(sb, "leader", "LEADER-42 "), "v=[]");

  const doctor = await sb.mpt("doctor");
  assertStringIncludes(doctor.output, "Agent env");
  assertStringIncludes(doctor.output, "invalid line");
  assertEquals(doctor.output.includes("secret-value"), false);
});

test("the daemon passes the env file to each spawn, re-reading it so edits need no restart", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("env-spawn");
  await sb.tmux("new-session", "-d", "-s", "stale");
  const envFile = path.join(sb.root, "mpt-env"); // absolute, outside the team dir
  fs.writeFileSync(envFile, "MPT_E2E_VAR=first\n");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES, agentEnvFile: envFile });
  await sb.startDaemon();

  const one = await spawnTeammate(sb);
  assertStringIncludes(await outputLine(sb, one, "SPAWNED-42 "), "v=[first]");

  // Edit the file; the daemon and the tmux server keep running.
  fs.writeFileSync(envFile, "MPT_E2E_VAR=second\nMPT_E2E_WORDS='it works'\n");
  const two = await spawnTeammate(sb);
  const out = await outputLine(sb, two, "SPAWNED-42 ");
  assertStringIncludes(out, "v=[second]");
  assertStringIncludes(out, "w=[it works]");
});

test("a missing env file never blocks a spawn", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("env-spawn-missing");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES, agentEnvFile: "~/nope.env" });
  await sb.startDaemon();

  const name = await spawnTeammate(sb);
  assertStringIncludes(await outputLine(sb, name, "SPAWNED-42 "), "v=[]");
  const requests = await (await fetch(`http://127.0.0.1:${sb.port}/api/spawn-requests`)).json() as { failed: unknown[] };
  assertEquals(requests.failed.length, 0, "the spawn succeeded");

  const doctor = await sb.mpt("doctor");
  assertStringIncludes(doctor.output, "does not exist");
});
