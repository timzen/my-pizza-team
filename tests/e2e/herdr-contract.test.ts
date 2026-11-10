/**
 * tests/e2e/herdr-contract.test.ts — the herdr operations mpt needs, against a real server.
 *
 * The spike for "herdr as an alternative terminal backend" (docs/herdr.md). Before
 * any production code depends on herdr, this proves that the installed herdr does
 * what mpt's tmux code does today (daemon/terminal/tmux.ts), mapped the way docs/herdr.md
 * decides:
 *
 *   mpt (tmux)                           herdr
 *   ─────────────────────────────────    ───────────────────────────────────────────
 *   server running?                      `status server --json` → `.running`
 *   ensureSession(session)               `workspace create --label <session>`
 *   spawnWindow(window, cwd, env, cmd)   `tab create --label <window> --cwd --env`
 *                                        (or rename the fresh workspace's first tab),
 *                                        then `pane run <root pane> <cmd>`
 *   listWindows / windowExists           `tab list --workspace <id>` → labels
 *   sendKeys(line + Enter)               `pane send-text` + `pane send-keys enter`
 *   sendControl("C-c")                   `pane send-keys ctrl+c`
 *   selectWindow / switchClient          `tab focus <tab_id>`
 *   killWindow                           `tab close <tab_id>`
 *   tmux -V                              `--version` / `status --json`
 *   kill-server                          `server stop`
 *
 * It also pins the behaviours the design leans on: pane env comes from the *server*
 * plus `--env` (not the CLI caller), duplicate labels are allowed (so mpt must keep
 * them unique), a command's exit closes its tab, closing the last tab closes the
 * workspace, a restart restores tabs (labels and ids) but not their processes nor
 * their `--env`, herdr's native restore relaunches a pane that reported an agent
 * session (and `HERDR_ENV`, the integrations' gate, can't be overridden by `--env`),
 * and an attached client follows `tab focus`.
 *
 * Every JSON response is checked against a recorded fixture in tests/fixtures/herdr/
 * (the unit tests of later tasks build on those): the live response must still have
 * every field the fixture has, with the same JSON type, so a herdr upgrade that
 * renames a field fails here rather than in production. Re-record with
 * `MPT_HERDR_RECORD=1 npm run test:e2e` (paths and pids are scrubbed).
 *
 * Runs only on an isolated server (tests/e2e/_herdr.ts). herdr is not a dependency of
 * mpt, so these skip where it isn't installed — and only there.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert, assertEquals, assertExists, assertMatch } from "../_assert.ts";
import { compareVersions, hasHerdr, herdrSandbox, herdrVersion, type HerdrResult, MIN_HERDR_VERSION } from "./_herdr.ts";
import { hasTmux, sandbox } from "./_sandbox.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "herdr");
const RECORD = process.env["MPT_HERDR_RECORD"] === "1";
const HERDR = hasHerdr();

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Replace sandbox paths, the session name, the binary path and pids so a fixture says nothing about this host. */
function scrub(value: Json, root: string, session: string): Json {
  if (typeof value === "string") {
    let s = value.replaceAll(root, "/tmp/herdr-sandbox").replaceAll(session, "mpt-sandbox");
    if (/\/herdr$/.test(s) && !s.startsWith("/tmp/herdr-sandbox")) s = "/usr/local/bin/herdr";
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, root, session));
  if (value && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /(^|_)pid$|process_group_id$/.test(k) && typeof v === "number" ? 4242 : scrub(v, root, session);
    }
    return out;
  }
  return value;
}

function kind(v: Json): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

/**
 * Every field of `expected` (a fixture) must be in `actual` with the same JSON type;
 * arrays are compared by their first element. Extra live fields are fine — herdr's
 * docs tell JSON clients to ignore unknown fields. Returns the mismatches.
 */
function shapeMismatches(expected: Json, actual: Json, at = "$"): string[] {
  // A nullable field (e.g. `server.version` when stopped) may be null in one and set in the other.
  if (expected === null || actual === null) return [];
  if (kind(expected) !== kind(actual)) return [`${at}: expected ${kind(expected)}, got ${kind(actual)}`];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return expected.length && actual.length ? shapeMismatches(expected[0]!, actual[0]!, `${at}[0]`) : [];
  }
  if (typeof expected === "object" && typeof actual === "object") {
    const e = expected as { [k: string]: Json };
    const a = actual as { [k: string]: Json };
    return Object.keys(e).flatMap((k) => k in a ? shapeMismatches(e[k]!, a[k]!, `${at}.${k}`) : [`${at}.${k}: missing`]);
  }
  return [];
}

/**
 * Check (or, with MPT_HERDR_RECORD=1, write) the fixture `name` for a call's JSON.
 * Returns the JSON for further assertions.
 */
function fixture(name: string, res: HerdrResult, hs: { root: string; session: string }): Record<string, unknown> {
  assertExists(res.json, `${name}: herdr printed no JSON (code ${res.code}): ${res.stdout}${res.stderr}`);
  const file = path.join(FIXTURES, `${name}.json`);
  const live = scrub(res.json as Json, hs.root, hs.session);
  if (RECORD) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(live, null, 2) + "\n");
  } else {
    assert(fs.existsSync(file), `missing fixture ${file} — record it with MPT_HERDR_RECORD=1`);
    const recorded = JSON.parse(fs.readFileSync(file, "utf8")) as Json;
    const bad = shapeMismatches(recorded, live);
    assertEquals(bad, [], `${name}: herdr's response no longer matches tests/fixtures/herdr/${name}.json`);
  }
  return res.json;
}

/** `res` succeeded; its JSON (if any) is returned. */
function ok(res: HerdrResult, what: string): HerdrResult {
  assertEquals(res.code, 0, `${what} failed: ${res.stdout}${res.stderr}`);
  return res;
}

/** herdr's responses are untyped JSON; the assertions below are what pin their shape. */
type Any = any;

test("herdr is probed with permission, so a skip below means herdr is truly absent", () => {
  // The same guard tests/e2e/tmux.test.ts has: a probe that can't run processes must
  // not read as "not installed" and quietly skip the real tests.
  // Under Node's permission model spawnSync throws ERR_ACCESS_DENIED; EACCES/EPERM is
  // a herdr we may not execute. Only ENOENT (not installed) may lead to a skip.
  const res = spawnSync("herdr", ["--version"]);
  const err = res.error as NodeJS.ErrnoException | undefined;
  assert(!err || err.code === "ENOENT", `herdr could not be probed: ${err?.message}`);
});

test("the installed herdr is new enough, and says so the way mpt will read it", { skip: !HERDR }, async () => {
  const version = herdrVersion();
  assertExists(version, "`herdr --version` did not print `herdr X.Y.Z`");
  assert(compareVersions(version, MIN_HERDR_VERSION) >= 0, `herdr ${version} is older than ${MIN_HERDR_VERSION}`);

  await using hs = await herdrSandbox();
  // `status --json` answers with no server running, and never starts one.
  const status = fixture("status-not-running", ok(hs.herdr(["status", "--json"]), "status"), hs) as Any;
  assertEquals(status.client.version, version);
  assertEquals(typeof status.client.protocol, "number");
  assertEquals(status.server.running, false);
  assertEquals(status.server.status, "not_running");
  assertEquals(status.server.session, hs.session); // named by --session, running or not
  // The socket is under the sandbox — never ~/.config/herdr/herdr.sock.
  assertEquals(status.server.socket, path.join(hs.configDir, "sessions", hs.session, "herdr.sock"));

  // An API call with no server fails (exit 1, JSON on stderr) rather than starting one:
  // the daemon has to start the server itself.
  const none = hs.herdr(["workspace", "list"]);
  assertEquals(none.code, 1);
  assertEquals(none.stdout, "");
  assertEquals((fixture("error-server-not-running", none, hs) as Any).error.code, "server_not_running");

  // `--session default` names the default session explicitly, and beats an inherited
  // HERDR_SOCKET_PATH (which herdr injects into every pane): how mpt will always say
  // which server it means, even when the daemon itself runs inside a herdr pane.
  const explicit = spawnSync("herdr", ["--session", "default", "status", "server", "--json"], {
    env: { ...hs.env, HERDR_SOCKET_PATH: path.join(hs.root, "elsewhere.sock") },
    encoding: "utf8",
  });
  assertEquals(JSON.parse(explicit.stdout).socket, path.join(hs.configDir, "herdr.sock"));
});

test("the agent-window lifecycle works end to end on a named session", { skip: !HERDR }, async () => {
  await using hs = await herdrSandbox();
  const r = hs;

  // Start a headless server. FROM_SERVER proves where a pane's environment comes from.
  await hs.startServer({ FROM_SERVER: "server", WHO: "server" });
  const st = fixture("status-running", ok(hs.herdr(["status", "--json"]), "status"), r) as Any;
  assertEquals(st.server.running, true);
  assertEquals(st.server.version, st.client.version);
  assertEquals(st.server.protocol, st.client.protocol);
  assertEquals(st.server.compatible, true);
  assertEquals(st.server.session, hs.session);
  fixture("status-server", ok(hs.herdr(["status", "server", "--json"]), "status server"), r);
  const sessions = fixture("session-list", ok(hs.herdr(["session", "list", "--json"]), "session list"), r) as Any;
  assert(sessions.sessions.some((s: Any) => s.name === hs.session && s.running === true), "session not listed as running");

  fixture("workspace-list-empty", ok(hs.herdr(["workspace", "list"]), "workspace list"), r);

  // The team container: one workspace, labelled with the team's session name. Its
  // creation also opens a first tab (label "1") — like a fresh tmux session's window.
  const dir = path.join(hs.root, "has space");
  fs.mkdirSync(dir);
  const ws = fixture("workspace-create", ok(hs.herdr([
    "workspace", "create", "--cwd", dir, "--label", "mpt-team", "--no-focus",
  ]), "workspace create"), r) as Any;
  const wsId: string = ws.result.workspace.workspace_id;
  assertEquals(ws.result.workspace.label, "mpt-team");
  assertEquals(ws.result.tab.label, "1");
  const firstTab: string = ws.result.tab.tab_id;
  const firstPane: string = ws.result.root_pane.pane_id;
  assertEquals(ws.result.root_pane.tab_id, firstTab);

  const wsList = ok(hs.herdr(["workspace", "list"]), "workspace list").json as Any;
  assertEquals(wsList.result.workspaces.map((w: Any) => w.label), ["mpt-team"]);

  // Reuse that first tab for the first agent instead of stranding it (tmux: rename-window).
  const renamed = fixture("tab-rename", ok(hs.herdr(["tab", "rename", firstTab, "leader"]), "tab rename"), r) as Any;
  assertEquals(renamed.result.tab.label, "leader");

  // An agent "window": a tab with a label, cwd (with a space) and env, no focus stolen.
  const tab = fixture("tab-create", ok(hs.herdr([
    "tab", "create", "--workspace", wsId, "--cwd", dir, "--label", "worker-one",
    "--env", "MPT_AGENT=worker-one", "--env", "QUOTED=a b'c", "--env", "WHO=env-flag", "--no-focus",
  ], { FROM_CLI: "cli" }), "tab create"), r) as Any;
  const tabId: string = tab.result.tab.tab_id;
  const paneId: string = tab.result.root_pane.pane_id;
  assertEquals(tab.result.tab.label, "worker-one");
  assertEquals(tab.result.tab.focused, false);
  assertEquals(tab.result.root_pane.cwd, dir);
  assertEquals(tab.result.root_pane.tab_id, tabId);
  // Server-assigned ids, workspace-qualified: "<ws>:t<n>" / "<ws>:p<n>".
  assertMatch(tabId, new RegExp(`^${wsId}:t\\d+$`));
  assertMatch(paneId, new RegExp(`^${wsId}:p\\d+$`));

  // Run the agent's command in the root pane straight after creation (no wait for the
  // shell). `pane run` submits text + Enter atomically and prints nothing on success.
  const run = ok(hs.herdr(["pane", "run", paneId,
    `printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' "$MPT_AGENT" "$QUOTED" "$PWD" "$HERDR_ENV" "$HERDR_PANE_ID" ` +
    `"$HERDR_TAB_ID" "$FROM_SERVER" "\${FROM_CLI:-unset}" "$WHO" > env.txt`]), "pane run");
  assertEquals(run.stdout, "");
  const envFile = path.join(dir, "env.txt");
  assert(await hs.waitFor(() => fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").endsWith("\n")), "command did not run");
  assertEquals(fs.readFileSync(envFile, "utf8").trim().split("|"), [
    "worker-one", "a b'c", dir, // --env as given, verbatim; --cwd honoured
    "1", paneId, tabId, // "inside herdr" markers
    "server", "unset", // pane env = the server's env + --env; the CLI caller's is NOT passed
    "env-flag", // --env overrides the server's value
  ]);

  // Find windows by name again: tab labels within the team's workspace.
  const tabs = fixture("tab-list", ok(hs.herdr(["tab", "list", "--workspace", wsId]), "tab list"), r) as Any;
  assertEquals(tabs.result.tabs.map((t: Any) => t.label), ["leader", "worker-one"]);
  const panes = fixture("pane-list", ok(hs.herdr(["pane", "list", "--workspace", wsId]), "pane list"), r) as Any;
  assertEquals(panes.result.panes.find((p: Any) => p.tab_id === tabId)?.pane_id, paneId);
  fixture("tab-get", ok(hs.herdr(["tab", "get", tabId]), "tab get"), r);
  fixture("pane-get", ok(hs.herdr(["pane", "get", paneId]), "pane get"), r);

  // Labels are not unique: a second "worker-one" is created without complaint. mpt has
  // to check `tab list` before creating, as spawnWindow already does for tmux.
  const dup = ok(hs.herdr(["tab", "create", "--workspace", wsId, "--label", "worker-one", "--no-focus"]), "dup tab").json as Any;
  assertEquals(dup.result.tab.label, "worker-one");
  ok(hs.herdr(["tab", "close", dup.result.tab.tab_id]), "close dup");

  // sendKeys: a line, then Enter, as two low-level calls (neither prints anything).
  assertEquals(ok(hs.herdr(["pane", "send-text", paneId, "sleep 300"]), "send-text").stdout, "");
  assertEquals(ok(hs.herdr(["pane", "send-keys", paneId, "enter"]), "send-keys").stdout, "");
  const foreground = () => (hs.herdr(["pane", "process-info", "--pane", paneId]).json as Any)?.result?.process_info
    ?.foreground_processes?.map((p: Any) => p.name) ?? [];
  assert(await hs.waitFor(() => foreground().includes("sleep")), "`sleep 300` did not start");
  fixture("pane-process-info", ok(hs.herdr(["pane", "process-info", "--pane", paneId]), "process-info"), r);

  // sendControl: Ctrl-C interrupts it, back to the bare shell. (`C-c`, tmux's
  // spelling, is accepted as an alias.)
  ok(hs.herdr(["pane", "send-keys", paneId, "ctrl+c"]), "ctrl+c");
  assert(await hs.waitFor(() => !foreground().includes("sleep") && foreground().includes("sh")), "Ctrl-C did not interrupt");
  ok(hs.herdr(["pane", "send-keys", paneId, "C-c"]), "C-c alias");

  // Output: read and wait (a readiness probe's building blocks).
  ok(hs.herdr(["pane", "run", paneId, "echo READY-MARKER"]), "echo");
  const waited = fixture("pane-wait-output", ok(hs.herdr([
    "pane", "wait-output", paneId, "--match", "READY-MARKER", "--timeout", "5000",
  ]), "wait-output"), r) as Any;
  assertEquals(waited.result.type, "output_matched");
  const read = ok(hs.herdr(["pane", "read", paneId, "--source", "recent", "--lines", "20"]), "pane read");
  assert(read.stdout.includes("READY-MARKER"), "pane read is plain text, not JSON");

  // selectWindow / switchClient: focus is server state, reported on the tab.
  const focused = fixture("tab-focus", ok(hs.herdr(["tab", "focus", tabId]), "tab focus"), r) as Any;
  assertEquals(focused.result.tab.focused, true);

  // Errors: exit 1, nothing on stdout, JSON `{ error: { code, message } }` on stderr.
  const noTab = hs.herdr(["tab", "close", `${wsId}:t999`]);
  assertEquals([noTab.code, noTab.stdout], [1, ""]);
  assertEquals((fixture("error-tab-not-found", noTab, r) as Any).error.code, "tab_not_found");
  const noPane = hs.herdr(["pane", "send-keys", `${wsId}:p999`, "enter"]);
  assertEquals([noPane.code, noPane.stdout], [1, ""]);
  assertEquals((fixture("error-pane-not-found", noPane, r) as Any).error.code, "pane_not_found");

  // A command that exits takes its tab with it (tmux's default for a window's shell).
  ok(hs.herdr(["pane", "run", firstPane, "exit"]), "exit");
  assert(await hs.waitFor(() => !(hs.herdr(["tab", "list", "--workspace", wsId]).json as Any).result.tabs
    .some((t: Any) => t.tab_id === firstTab)), "the exited shell's tab is still there");

  // killWindow: close the tab. It is the workspace's last, so the workspace goes too —
  // the team container must be re-created on demand, never assumed.
  assertEquals((fixture("tab-close", ok(hs.herdr(["tab", "close", tabId]), "tab close"), r) as Any).result.type, "ok");
  assertEquals((ok(hs.herdr(["workspace", "list"]), "workspace list").json as Any).result.workspaces, []);

  // Stop the server: its panes' processes go with it.
  assertEquals(ok(hs.herdr(["server", "stop"]), "server stop").stdout, "");
  assert(await hs.waitFor(() => (hs.herdr(["status", "server", "--json"]).json as Any)?.running === false), "server did not stop");
  const again = hs.herdr(["session", "stop", hs.session, "--json"]);
  assertEquals(again.code, 1);
  assertEquals((fixture("error-session-stop-not-running", again, r) as Any).error.code, "session_stop_failed");
});

test("a server restart restores tabs and their ids, but not their processes", { skip: !HERDR }, async () => {
  await using hs = await herdrSandbox();
  await hs.startServer();
  const ws = ok(hs.herdr(["workspace", "create", "--cwd", hs.root, "--label", "mpt-team", "--no-focus"]), "ws").json as Any;
  const wsId: string = ws.result.workspace.workspace_id;
  const tab = ok(hs.herdr(["tab", "create", "--workspace", wsId, "--cwd", hs.root, "--label", "worker-one", "--no-focus"]), "tab").json as Any;
  const paneId: string = tab.result.root_pane.pane_id;
  const terminalBefore: string = tab.result.root_pane.terminal_id;
  ok(hs.herdr(["pane", "run", paneId, "sleep 300"]), "run");
  const foreground = () => (hs.herdr(["pane", "process-info", "--pane", paneId]).json as Any)?.result?.process_info
    ?.foreground_processes?.map((p: Any) => p.name) ?? [];
  assert(await hs.waitFor(() => foreground().includes("sleep")), "`sleep 300` did not start");

  // `session stop` is the same stop, addressed by name (what `mpt` would use for a
  // non-default session).
  const stopped = fixture("session-stop", ok(hs.herdr(["session", "stop", hs.session, "--json"]), "session stop"), hs) as Any;
  assertEquals(stopped.stopped, true);
  await hs.stopServer();

  await hs.startServer();
  const tabs = (ok(hs.herdr(["tab", "list", "--workspace", wsId]), "tab list").json as Any).result.tabs;
  // The layout is back — same workspace, tab ids and labels...
  assertEquals(tabs.map((t: Any) => [t.tab_id, t.label]), [[ws.result.tab.tab_id, "1"], [tab.result.tab.tab_id, "worker-one"]]);
  const pane = (ok(hs.herdr(["pane", "get", paneId]), "pane get").json as Any).result.pane;
  // ...but the terminal is new, and runs a fresh shell: a label alone does not mean
  // the agent is alive (docs/herdr.md "Restart").
  assert(pane.terminal_id !== terminalBefore, "expected a new terminal after restart");
  assertEquals(foreground().includes("sleep"), false);
});

test("native agent-session restore relaunches a pane that reported a session; HERDR_ENV is herdr's", { skip: !HERDR }, async () => {
  // Why mpt runs every agent with HERDR_ENV=0 (daemon/terminal/herdr.ts
  // herdrLaunchLine, docs/herdr.md "Restart"): herdr's official integrations report a
  // pane's session only when HERDR_ENV is 1, and herdr types `pi --session <file>`
  // into every restored pane that reported one — without mpt's flags.
  await using hs = await herdrSandbox();
  // A stand-in `pi` herdr detects as Pi by its process name: `sleep`, renamed.
  const bin = path.join(hs.root, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync("/bin/sleep", path.join(bin, "pi"));
  const serverEnv = { PATH: `${bin}:${hs.env["PATH"] ?? ""}` };
  await hs.startServer(serverEnv);
  const ws = ok(hs.herdr(["workspace", "create", "--cwd", hs.root, "--label", "mpt-team", "--no-focus"]), "ws").json as Any;
  const wsId: string = ws.result.workspace.workspace_id;
  const tab = ok(hs.herdr(["tab", "create", "--workspace", wsId, "--cwd", hs.root, "--label", "worker-one",
    "--env", "HERDR_ENV=0", "--env", "MPT_E2E_VAR=kept", "--no-focus"]), "tab").json as Any;
  const paneId: string = tab.result.root_pane.pane_id;

  // herdr keeps its own HERDR_* over --env: the override has to be on the command line.
  ok(hs.herdr(["pane", "run", paneId, `echo "$HERDR_ENV|$MPT_E2E_VAR" > env.txt; pi 300`]), "run");
  const envFile = path.join(hs.root, "env.txt");
  assert(await hs.waitFor(() => fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").endsWith("\n")), "command did not run");
  assertEquals(fs.readFileSync(envFile, "utf8").trim(), "1|kept");

  // herdr takes a session report only for a pane it sees running Pi.
  const pane = () => (hs.herdr(["pane", "get", paneId]).json as Any)?.result?.pane;
  assert(await hs.waitFor(() => pane()?.agent === "pi"), `pi not detected: ${JSON.stringify(pane())}`);

  // What herdr's Pi integration sends (~/.pi/agent/extensions/herdr-agent-state.ts), on its socket.
  const sessionFile = path.join(hs.root, "session.jsonl");
  fs.writeFileSync(sessionFile, "{}\n");
  const socket = path.join(hs.configDir, "sessions", hs.session, "herdr.sock");
  const send = (request: unknown) => new Promise<string>((resolve) => {
    const c = net.createConnection(socket);
    c.on("connect", () => c.write(`${JSON.stringify(request)}\n`));
    c.on("data", (d) => { resolve(String(d)); c.destroy(); });
    c.on("error", (e) => resolve(String(e)));
  });
  const seq = Date.now() * 1000;
  assertMatch(await send({ id: "s", method: "pane.report_agent_session", params: {
    // session_start_source (Pi's session_start reason) is required: without it herdr ignores the report.
    pane_id: paneId, source: "herdr:pi", agent: "pi", seq, session_start_source: "startup", agent_session_path: sessionFile,
  } }), /"type":"ok"/);
  assertMatch(await send({ id: "a", method: "pane.report_agent", params: {
    pane_id: paneId, source: "herdr:pi", agent: "pi", state: "idle", seq: seq + 1, agent_session_path: sessionFile,
  } }), /"type":"ok"/);
  assert(await hs.waitFor(() => pane()?.agent_session?.value === sessionFile), `no session: ${JSON.stringify(pane())}`);

  // Restart: herdr types the resume command into the restored pane by itself.
  await hs.stopServer();
  await hs.startServer(serverEnv);
  const read = () => hs.herdr(["pane", "read", paneId, "--source", "recent", "--lines", "20"]).stdout;
  assert(await hs.waitFor(() => read().includes(`pi --session ${sessionFile}`)), `no native restore:\n${read()}`);

  // And the restored pane has the server's env, not the tab's --env.
  fs.rmSync(envFile);
  ok(hs.herdr(["pane", "run", paneId, `echo "$HERDR_ENV|$MPT_E2E_VAR" > env.txt`]), "run again");
  assert(await hs.waitFor(() => fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").endsWith("\n")), "command did not run");
  assertEquals(fs.readFileSync(envFile, "utf8").trim(), "1|");
});

test("an attached client follows `tab focus`", { skip: !HERDR || !hasTmux() }, async () => {
  // A real TUI client needs a real terminal with a size (a bare pty reports a zero-sized
  // grid and herdr refuses). The sandbox's private tmux server provides one; its
  // screen shows which herdr tab the client is viewing.
  await using hs = await herdrSandbox();
  await using sb = await sandbox("herdr-attach");
  await hs.startServer();
  const ws = ok(hs.herdr(["workspace", "create", "--cwd", hs.root, "--label", "mpt-team", "--no-focus"]), "ws").json as Any;
  const wsId: string = ws.result.workspace.workspace_id;
  ok(hs.herdr(["pane", "run", ws.result.root_pane.pane_id, "clear; echo MARKER-ALPHA"]), "alpha");
  const b = ok(hs.herdr(["tab", "create", "--workspace", wsId, "--label", "beta", "--no-focus"]), "tab").json as Any;
  ok(hs.herdr(["pane", "run", b.result.root_pane.pane_id, "clear; echo MARKER-BETA"]), "beta");

  // Attach from a window of the private tmux server, with the herdr sandbox's env.
  const envArgs = Object.entries(hs.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const attach = await sb.tmux("new-session", "-d", "-s", sb.session, "-x", "160", "-y", "40", ...envArgs,
    "herdr", "--session", hs.session);
  assertEquals(attach.code, 0, `could not open the attaching tmux session: ${attach.output}`);
  const screen = async () => (await sb.tmux("capture-pane", "-p", "-t", sb.session)).stdout;
  assert(await sb.waitFor(async () => (await screen()).includes("mpt-team"), 10_000), `client did not attach:\n${await screen()}`);

  ok(hs.herdr(["tab", "focus", b.result.tab.tab_id]), "focus beta");
  assert(await sb.waitFor(async () => (await screen()).includes("MARKER-BETA"), 5000), `client did not follow to beta:\n${await screen()}`);
  ok(hs.herdr(["tab", "focus", ws.result.tab.tab_id]), "focus alpha");
  assert(await sb.waitFor(async () => {
    const s = await screen();
    return s.includes("MARKER-ALPHA") && !s.includes("MARKER-BETA");
  }, 5000), `client did not follow back to alpha:\n${await screen()}`);
});
