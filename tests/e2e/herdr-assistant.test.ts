/**
 * tests/e2e/herdr-assistant.test.ts — the assistant under herdr, end to end (story
 * "herdr as an alternative terminal backend", task 5).
 *
 * With `terminal: "herdr"`, the user-facing paths that open or show the leader:
 *
 *   - **`POST /api/assistant/start`** (the web UI's Start button): the daemon opens
 *     the leader tab in the team's workspace, in the project directory, with the
 *     agent env file's variables, and says how to attach; a second start is
 *     `already-running` and opens nothing. `/health` reports herdr's status, and
 *     `mpt doctor` reports it from the CLI's side, on the same server.
 *   - **`mpt assistant`**: `--no-attach` starts it and prints herdr's attach hint
 *     (idempotent, like the button); inside tmux it prints the attach command rather
 *     than nesting herdr in tmux; inside a pane of the team's herdr it focuses the
 *     leader tab; in a plain terminal it really attaches (a herdr client in a
 *     window of the sandbox's private tmux server, showing the leader).
 *
 * Isolation as in tests/e2e/herdr-backend.test.ts: the sandbox's own herdr world
 * (tests/e2e/_herdr.ts, a random session passed as `herdrSession`) and private tmux
 * server (tests/e2e/_sandbox.ts). The user's default herdr session and tmux server
 * are never addressed; teardown stops the herdr server mpt started. The stand-in
 * leader prints a `$((40+2))`-marked line only execution can produce.
 *
 * Runs wherever herdr is installed; skips only where it isn't.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";
import { hasHerdr, herdrSandbox, type HerdrSandbox } from "./_herdr.ts";
import { hasTmux, sandbox, type Sandbox } from "./_sandbox.ts";

const HERDR = hasHerdr();
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "main.ts");

/** herdr's responses are untyped JSON. */
type Any = any;

/** The team workspace's tabs, by label → { tab, pane } ids. */
function tabs(hs: HerdrSandbox, label: string): Map<string, { tab: string; pane: string }> {
  const out = new Map<string, { tab: string; pane: string }>();
  const ws = (hs.herdr(["workspace", "list"]).json as Any)?.result?.workspaces?.find((w: Any) => w.label === label);
  if (!ws) return out;
  const tabList = (hs.herdr(["tab", "list", "--workspace", ws.workspace_id]).json as Any)?.result?.tabs ?? [];
  const panes = (hs.herdr(["pane", "list", "--workspace", ws.workspace_id]).json as Any)?.result?.panes ?? [];
  for (const t of tabList) out.set(t.label, { tab: t.tab_id, pane: panes.find((p: Any) => p.tab_id === t.tab_id)?.pane_id });
  return out;
}

/** What a pane shows (plain text). */
function screen(hs: HerdrSandbox, pane: string): string {
  return hs.herdr(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "60"]).stdout;
}

/** Is the tab focused in its workspace? */
function focused(hs: HerdrSandbox, tab: string): boolean {
  return (hs.herdr(["tab", "get", tab]).json as Any)?.result?.tab?.focused === true;
}

/** A herdr team in `sb`, on `hs`'s server, with a stand-in leader and an agent env file. */
function herdrTeam(sb: Sandbox, hs: HerdrSandbox): void {
  fs.writeFileSync(path.join(sb.root, "agent.env"), "MPT_E2E_VAR='from file'\n");
  sb.writeTeamConfig({
    terminal: "herdr",
    herdrSession: hs.session,
    minTeammates: 0,
    agentEnvFile: path.join(sb.root, "agent.env"),
    harnesses: {
      pi: {
        teammate: "echo TEAMMATE; sleep 300",
        leader: "echo LEADER-$((40+2)) term={terminal} at={terminalSession}:{terminalWindow} v=[$MPT_E2E_VAR] pwd=[$PWD]; sleep 300",
      },
    },
  });
}

const leaderLine = (sb: Sandbox) => `LEADER-42 term=herdr at=${sb.session}:leader v=[from file] pwd=[${sb.projectDir}]`;

test("POST /api/assistant/start opens the leader tab under herdr, idempotently; /health and doctor report herdr", { skip: !HERDR }, async () => {
  await using hs = await herdrSandbox();
  await using sb = await sandbox("herdr-assistant-ui");
  herdrTeam(sb, hs);
  await sb.startDaemon("cli", { env: hs.daemonEnv });

  const post = () => fetch(`http://127.0.0.1:${sb.port}/api/assistant/start`, { method: "POST" });
  const first = await post();
  const started = await first.json() as Any;
  assertEquals(first.status, 201, JSON.stringify(started));
  assertEquals(started.status, "started");
  assertEquals(started.terminal, "herdr");
  assertEquals(started.attach, `herdr session attach ${hs.session}`);
  assertEquals(started.envKeys, 1);
  assertEquals([...tabs(hs, sb.session).keys()], ["leader"]);
  const { pane } = tabs(hs, sb.session).get("leader")!;
  assert(await sb.waitFor(() => screen(hs, pane).includes(leaderLine(sb)), 8000), `the leader didn't run as expected:\n${screen(hs, pane)}`);

  // Again: already running — no second tab, nothing typed.
  const second = await post();
  const again = await second.json() as Any;
  assertEquals(second.status, 200, JSON.stringify(again));
  assertEquals(again.status, "already-running");
  assertEquals([...tabs(hs, sb.session).keys()], ["leader"]);
  assertEquals((screen(hs, pane).match(/LEADER-42 term/g) ?? []).length, 1, "the command ran once");

  // /health: the selected backend, its version, a running server and its socket.
  const socket = (hs.herdr(["status", "server", "--json"]).json as Any)?.socket as string;
  // The daemon caches herdr's status for a few seconds (daemon/spawner.ts
  // cachedTerminalStatus), and it last looked before the start launched the server.
  const healthNow = async () => await (await fetch(`http://127.0.0.1:${sb.port}/health`)).json() as Any;
  assert(await sb.waitFor(async () => (await healthNow()).terminalStatus?.serverRunning === true, 10_000), "the server never showed as running");
  const health = await healthNow();
  assertEquals(health.terminal, "herdr");
  assertEquals(health.terminalStatus.kind, "herdr");
  assertEquals(health.terminalStatus.available, true);
  assertEquals(health.terminalStatus.serverRunning, true);
  assertEquals(health.terminalStatus.session, hs.session);
  assertEquals(health.terminalStatus.identity, socket);

  // mpt doctor, from the same environment: herdr reported, same server (no warning).
  const doctor = await sb.mptWithEnv(hs.daemonEnv, "doctor");
  assertStringIncludes(doctor.output, `herdr ${health.terminalStatus.version} — session "${hs.session}", server running`);
  assertEquals(doctor.output.includes("herdr server"), false, doctor.output);
  assertStringIncludes(doctor.output, "daemon-driven (it can reach herdr)");
});

test("mpt assistant under herdr: --no-attach hints, idempotence, inside tmux prints, inside herdr focuses", { skip: !HERDR }, async () => {
  await using hs = await herdrSandbox();
  await using sb = await sandbox("herdr-assistant-cli");
  herdrTeam(sb, hs);

  const first = await sb.mptWithEnv(hs.daemonEnv, "assistant", "--no-attach");
  assertEquals(first.code, 0, first.output);
  assertStringIncludes(first.output, `Assistant started in ${sb.session}:leader (herdr, ${sb.projectDir})`);
  assertStringIncludes(first.output, "Agent env: 1 variable(s)");
  assertStringIncludes(first.output, `Attach with: herdr session attach ${hs.session}`);
  assertStringIncludes(first.output, 'From inside herdr: switch to the "leader" tab');
  assertEquals(first.output.includes("tmux attach"), false, first.output);
  const { tab, pane } = tabs(hs, sb.session).get("leader")!;
  assert(await sb.waitFor(() => screen(hs, pane).includes(leaderLine(sb)), 8000), screen(hs, pane));

  // `lead` is the same command; a second start reuses the tab.
  const again = await sb.mptWithEnv(hs.daemonEnv, "lead", "--no-attach");
  assertEquals(again.code, 0, again.output);
  assertStringIncludes(again.output, "already running");
  assertEquals([...tabs(hs, sb.session).keys()], ["leader"]);

  // Another tab in front, so a focus is visible.
  const ws = (hs.herdr(["workspace", "list"]).json as Any).result.workspaces.find((w: Any) => w.label === sb.session);
  const other = (hs.herdr(["tab", "create", "--workspace", ws.workspace_id, "--label", "other"]).json as Any).result.tab.tab_id as string;
  assertEquals(hs.herdr(["tab", "focus", other]).code, 0);
  assertEquals(focused(hs, tab), false);

  // Inside tmux: no nested herdr — the attach command, with the leader brought to the front.
  const inTmux = await sb.mptWithEnv({ ...hs.daemonEnv, TMUX: `${sb.tmuxDir}/default,1,0`, TMUX_PANE: "%0" }, "assistant");
  assertEquals(inTmux.code, 0, inTmux.output);
  assertStringIncludes(inTmux.output, "inside tmux");
  assertStringIncludes(inTmux.output, `Attach from a terminal outside it with: herdr session attach ${hs.session}`);
  assertEquals(focused(hs, tab), true);

  // Inside a pane of the team's herdr server: focus the leader tab, no attach.
  assertEquals(hs.herdr(["tab", "focus", other]).code, 0);
  const socket = (hs.herdr(["status", "server", "--json"]).json as Any)?.socket as string;
  const inHerdr = await sb.mptWithEnv({ ...hs.daemonEnv, HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p9" }, "assistant");
  assertEquals(inHerdr.code, 0, inHerdr.output);
  assertStringIncludes(inHerdr.output, `Switched to ${sb.session}:leader.`);
  assertEquals(focused(hs, tab), true);

  // Inside a pane of some other herdr server: print, never nest.
  const elsewhere = await sb.mptWithEnv({ ...hs.daemonEnv, HERDR_ENV: "1", HERDR_SOCKET_PATH: "/nowhere/herdr.sock" }, "assistant");
  assertEquals(elsewhere.code, 0, elsewhere.output);
  assertStringIncludes(elsewhere.output, "different herdr server");
  assertEquals([...tabs(hs, sb.session).keys()], ["leader", "other"], "nothing new opened");
});

test("mpt assistant in a plain terminal attaches a herdr client showing the leader", { skip: !HERDR || !hasTmux() }, async () => {
  // A herdr client needs a real terminal with a size; a window of the sandbox's
  // private tmux server is one. TMUX is unset inside it, so mpt sees a plain terminal.
  await using hs = await herdrSandbox();
  await using sb = await sandbox("herdr-assistant-attach");
  herdrTeam(sb, hs);
  const env = { ...sb.env, ...hs.daemonEnv };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const opened = await sb.tmux("new-session", "-d", "-s", sb.session, "-x", "160", "-y", "40", "-c", sb.projectDir, ...envArgs,
    "env", "-u", "TMUX", "-u", "TMUX_PANE", process.execPath, CLI, "assistant");
  assertEquals(opened.code, 0, opened.output);
  const client = async () => (await sb.tmux("capture-pane", "-p", "-t", sb.session)).stdout;

  assert(await sb.waitFor(async () => (await client()).includes("LEADER-42 term=herdr"), 20_000), `no herdr client showing the leader:\n${await client()}`);
  assertEquals([...tabs(hs, sb.session).keys()], ["leader"]);
  assertEquals(focused(hs, tabs(hs, sb.session).get("leader")!.tab), true);
});
