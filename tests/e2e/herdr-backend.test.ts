/**
 * tests/e2e/herdr-backend.test.ts — the herdr terminal backend against a real herdr
 * (story "herdr as an alternative terminal backend", task 4).
 *
 * tests/herdr-backend.test.ts pins the argv against recorded responses; this proves
 * the real thing does what those responses promise:
 *
 *   - the **daemon**, with `terminal: "herdr"`, starts the session's herdr server
 *     itself, opens a spawned teammate as a tab in the team's workspace, in its cwd,
 *     with the agent env file's variables, running the filled template; focuses it
 *     for `/ppt-hop`; and on dismiss sends Ctrl-C and closes the tab;
 *   - the **backend** (daemon/terminal/herdr.ts, over a real herdr) is idempotent by
 *     label, and after a server restart — which restores the tab but not its
 *     process — runs the command into the restored tab again.
 *
 * Isolation: every herdr here is the sandbox's (tests/e2e/_herdr.ts — its own
 * XDG config dir and a random session name, passed to the daemon as `herdrSession`);
 * the daemon's tmux is the sandbox's private server (tests/e2e/_sandbox.ts). The
 * user's default herdr session and tmux server are never addressed, and teardown
 * stops the herdr server the daemon started. Stand-in commands print
 * `$((40+2))`-marked lines only execution can produce.
 *
 * Runs wherever herdr is installed; skips only where it isn't.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";
import { hasHerdr, herdrSandbox, type HerdrSandbox } from "./_herdr.ts";
import { sandbox, type Sandbox } from "./_sandbox.ts";
import { createHerdrBackend, type HerdrExec } from "../../daemon/terminal/herdr.ts";
import { PROTOCOL_VERSION } from "../../shared/protocol.ts";

const HERDR = hasHerdr();

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

async function api<T>(sb: Sandbox, url: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${sb.port}${url}`, body === undefined && method !== "POST" ? { method } : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  return await res.json() as T;
}

test("the daemon spawns, focuses and dismisses a teammate in herdr", { skip: !HERDR }, async () => {
  await using hs = await herdrSandbox();
  await using sb = await sandbox("herdr-spawn");
  fs.writeFileSync(path.join(sb.root, "agent.env"), "MPT_E2E_VAR=from-file\nMPT_E2E_WORDS='two words'\n");
  sb.writeTeamConfig({
    terminal: "herdr",
    herdrSession: hs.session,
    minTeammates: 0,
    agentEnvFile: path.join(sb.root, "agent.env"),
    harnesses: {
      pi: {
        teammate: "echo SPAWNED-$((40+2)) name={name} term={terminal} at={terminalSession}:{terminalWindow} " +
          "v=[$MPT_E2E_VAR] w=[$MPT_E2E_WORDS] pwd=[$PWD]; sleep 300",
        leader: "echo LEADER-$((40+2)); sleep 300",
      },
    },
  });
  // No herdr server yet: the daemon must start the session's server itself.
  assertEquals(hs.herdr(["status", "server", "--json"]).json?.["running"], false);
  await sb.startDaemon("cli", { env: hs.daemonEnv });

  const health = await api<{ terminal: string; spawning: { canSpawn: boolean; reason?: string } }>(sb, "/health", undefined, "GET");
  assertEquals(health.terminal, "herdr");
  assertEquals(health.spawning.canSpawn, true, health.spawning.reason);

  const created = await api<{ directive: { params: { name: string } } }>(
    sb, "/api/leader/directives", { action: "spawn", params: { cwd: sb.projectDir } },
  );
  const name = created.directive.params.name;
  assert(await sb.waitFor(() => tabs(hs, sb.session).has(name), 15_000), `no herdr tab for ${name}: ${[...tabs(hs, sb.session).keys()]}`);
  assertEquals([...tabs(hs, sb.session).keys()], [name], "the workspace's first tab was reused, not left as a stray");
  const { pane } = tabs(hs, sb.session).get(name)!;

  const filled = `SPAWNED-42 name=${name} term=herdr at=${sb.session}:${name} v=[from-file] w=[two words] pwd=[${sb.projectDir}]`;
  assert(await sb.waitFor(() => screen(hs, pane).includes(filled), 8000), `the command didn't run as expected:\n${screen(hs, pane)}`);
  const spawns = await api<{ failed: Array<{ error: string }> }>(sb, "/api/spawn-requests", undefined, "GET");
  assertEquals(spawns.failed, []);

  // The teammate registers with its herdr location; /ppt-hop focuses its tab.
  await api(sb, "/api/agents/register", {
    id: "t1", name, protocolVersion: PROTOCOL_VERSION,
    metadata: { terminal: "herdr", terminalSession: sb.session, terminalWindow: name, terminalHandle: pane },
  });
  const focus = await fetch(`http://127.0.0.1:${sb.port}/api/agents/t1/focus`, { method: "POST" });
  assertEquals(focus.status, 200, await focus.text());
  const focused = (hs.herdr(["tab", "get", tabs(hs, sb.session).get(name)!.tab]).json as Any)?.result?.tab?.focused;
  assertEquals(focused, true);

  // Dismiss: tombstone, heard on the next heartbeat, deregister — then the daemon
  // sends Ctrl-C and, on a later pass, closes the tab.
  await api(sb, "/api/agents/t1?dismiss=true", undefined, "DELETE");
  const beat = await api<{ dismissed?: boolean }>(sb, "/api/agents/heartbeat", { id: "t1", status: "idle" });
  assertEquals(beat.dismissed, true);
  await api(sb, "/api/agents/t1", undefined, "DELETE");
  assert(await sb.waitFor(() => !tabs(hs, sb.session).has(name), 15_000), `tab ${name} still open: ${[...tabs(hs, sb.session).keys()]}`);

  // Nothing went to tmux.
  const tmuxWindows = await sb.tmux("list-windows", "-t", sb.session, "-F", "#{window_name}");
  assertEquals(tmuxWindows.stdout.trim(), "");
});

test("the herdr backend is idempotent by label, and re-runs the command in a tab a restart restored", { skip: !HERDR }, async () => {
  await using hs = await herdrSandbox();
  // The backend over the sandbox's herdr (never the default environment's).
  const exec: HerdrExec = (args) => {
    const out = spawnSync("herdr", args, { env: hs.env, encoding: "utf8", timeout: 20_000 });
    if (out.error) return { ok: false, stdout: "", stderr: out.error.message };
    return { ok: out.status === 0, stdout: out.stdout, stderr: out.stderr };
  };
  const launch = (args: string[]) => {
    spawn("herdr", args, { env: hs.env, cwd: hs.root, detached: true, stdio: "ignore" }).unref();
  };
  const terminal = createHerdrBackend({ session: hs.session, exec, launch });
  assertEquals(terminal.unavailable(), null);

  const dir = path.join(hs.root, "has space");
  fs.mkdirSync(dir);
  const command = "echo RUN-$((40+2)) at=[$PWD] e=[$MPT_E2E_VAR]; sleep 300";
  const first = terminal.openWindow({ session: "team", window: "neo", cwd: dir, command, env: { MPT_E2E_VAR: "a b'c" } });
  assertEquals(first.created, true);
  assertStringIncludes(first.ref.id ?? "", ":p");
  const pane = first.ref.id!;
  assert(await hs.waitFor(() => screen(hs, pane).includes(`RUN-42 at=[${dir}] e=[a b'c]`)), screen(hs, pane));

  // Again, while it runs: nothing new, nothing typed.
  const again = terminal.openWindow({ session: "team", window: "neo", cwd: dir, command });
  assertEquals(again.created, false);
  assertEquals(terminal.listWindows("team"), ["neo"]);

  // Restart the server: the tab comes back, its process doesn't.
  await hs.stopServer();
  assertEquals(terminal.listWindows("team"), [], "reads don't start a server");
  await hs.startServer();
  assertEquals(terminal.listWindows("team"), ["neo"]);
  const revived = terminal.openWindow({ session: "team", window: "neo", cwd: dir, command });
  assertEquals(revived.created, true);
  const restoredPane = revived.ref.id!;
  assert(await hs.waitFor(() => (screen(hs, restoredPane).match(/RUN-42 at=/g) ?? []).length >= 1), screen(hs, restoredPane));

  // What runs there (the Team tab's unmanaged windows): `sleep`, until Ctrl-C leaves the shell.
  const ref = terminal.windowRef("team", "neo");
  assert(await hs.waitFor(() => terminal.windowActivity(ref).command === "sleep"), JSON.stringify(terminal.windowActivity(ref)));
  assertEquals(terminal.windowActivity(ref).running, true);
  assertEquals(terminal.windowActivity(terminal.windowRef("team", "nope")), { running: null, command: null });

  // Ctrl-C, then close: the workspace goes with its last tab.
  terminal.sendControl(terminal.windowRef("team", "neo"), "C-c");
  assert(await hs.waitFor(() => terminal.windowActivity(ref).running === false), JSON.stringify(terminal.windowActivity(ref)));
  assertEquals(terminal.closeWindow(terminal.windowRef("team", "neo")), true);
  assertEquals(terminal.listWindows("team"), []);
  assertEquals(terminal.closeWindow(terminal.windowRef("team", "neo")), false);
});
