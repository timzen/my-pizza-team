/**
 * tests/herdr-backend.test.ts — the herdr terminal backend (daemon/terminal/herdr.ts),
 * against a fake herdr that answers with the recorded fixtures (tests/_herdr.ts,
 * tests/fixtures/herdr/).
 *
 * What these pin, from docs/herdr.md's mapping:
 *   - availability: installed, ≥ 0.9.5, a compatible server; each refusal names the
 *     installed version (or what's missing) and the fix;
 *   - a server is started (detached) only by operations that create windows, and
 *     waited for; reads never start one;
 *   - windows are tabs found by label — every id comes from a response;
 *   - `openWindow`: `--cwd`, `--label`, sorted `--env`, `--no-focus`, then `pane run`
 *     of the command with `HERDR_ENV=0` (no herdr native restore of mpt's panes);
 *     a fresh workspace's first tab is reused; idempotent by label; a restored tab
 *     with only its shell gets the command again;
 *   - send line / Ctrl-C / close / focus; herdr errors become clear messages;
 *   - the spawner opens and dismisses through it when `terminal` is herdr, and
 *     tmux is never touched.
 * tests/e2e/herdr-backend.test.ts drives a real herdr through the daemon.
 */

import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { fakeHerdr } from "./_herdr.ts";
import { withTeam, get } from "./_team.ts";
import {
  compareVersions,
  createHerdrBackend,
  defaultHerdrSocketPath,
  herdrEnv,
  herdrLaunchLine,
  MIN_HERDR_VERSION,
} from "../daemon/terminal/herdr.ts";
import { createTerminalBackend, getTerminalBackend } from "../daemon/terminal/index.ts";
import {
  cachedTerminalCapability,
  cachedTerminalStatus,
  focusMember,
  probeSpawnCapability,
  probeTerminalCapability,
  realizePending,
  type SpawnableDirective,
  type SpawnerStore,
} from "../daemon/spawner.ts";
import type { TeamConfig } from "../shared/types.ts";
import type { TmuxExec } from "../daemon/terminal/tmux.ts";

const backend = (h = fakeHerdr(), session?: string) =>
  createHerdrBackend({ exec: h.exec, launch: h.launch, session, sleep: () => {}, serverTimeoutMs: 200 });

/** The calls a backend made, without the `--session <s>` prefix, as space-joined strings. */
const made = (h: ReturnType<typeof fakeHerdr>) =>
  h.calls.map((c) => (c[0] === "--session" ? c.slice(2) : c).join(" "));

// ─── Availability ────────────────────────────────────────────────────

test("herdr ≥ 0.9.5 with a compatible server is available; identity is the session's socket", () => {
  const h = fakeHerdr();
  const t = backend(h);
  assertEquals(t.kind, "herdr");
  assertEquals(t.available(), true);
  assertEquals(t.unavailableReason(), "none");
  assertEquals(t.unavailable(), null);
  assertEquals(t.identity(), "/tmp/herdr-sandbox/c/herdr/sessions/mpt-sandbox/herdr.sock");
  // Every call names the session explicitly (it beats an inherited HERDR_SOCKET_PATH).
  assert(h.calls.filter((c) => c[0] !== "--version").every((c) => c[0] === "--session" && c[1] === "default"));
  assertEquals(h.launched, [], "probing never starts a server");
});

test("herdr missing: not-installed, with the PATH fix and the way back to tmux", () => {
  const h = fakeHerdr();
  h.state.missing = true;
  const t = backend(h);
  assertEquals(t.available(), false);
  assertEquals(t.unavailableReason(), "not-installed");
  assertStringIncludes(t.unavailable()!.reason, "herdr is not on this process's PATH");
  assertStringIncludes(t.unavailable()!.fix, `herdr ≥ ${MIN_HERDR_VERSION}`);
  assertStringIncludes(t.unavailable()!.fix, "tmux");
  assertEquals(t.identity(), null);
});

test("herdr too old: the capability error names the installed version and the upgrade", () => {
  const t = backend(fakeHerdr({ version: "0.9.4" }));
  assertEquals(t.unavailableReason(), "unsupported-version");
  const why = t.unavailable()!;
  assertStringIncludes(why.reason, "herdr 0.9.4 is older than 0.9.5");
  assertStringIncludes(why.fix, "herdr update");
  // And as the spawner reports it.
  const cap = probeTerminalCapability(t);
  assertEquals(cap.canSpawn, false);
  assertStringIncludes(cap.canSpawn ? "" : cap.reason, "0.9.4");
});

test("a running server that is incompatible with the CLI is refused with the restart fix", () => {
  const h = fakeHerdr();
  h.state.compatible = false;
  const why = backend(h, "team-x").unavailable()!;
  assertStringIncludes(why.reason, 'session "team-x"');
  assertStringIncludes(why.reason, "not compatible");
  assertStringIncludes(why.fix, "herdr --session team-x server stop");
});

test("an invalid herdr session name is refused without running herdr", () => {
  const h = fakeHerdr();
  const t = backend(h, "my team");
  assertEquals(t.unavailableReason(), "misconfigured");
  assertStringIncludes(t.unavailable()!.fix, "herdrSession");
  assertEquals(h.calls, []);
});

test("compareVersions and the socket fallback", () => {
  assertEquals(compareVersions("0.9.5", "0.9.5"), 0);
  assert(compareVersions("0.10.0", "0.9.5") > 0);
  assert(compareVersions("0.9.4", "0.9.5") < 0);
  assert(compareVersions("1.0.0-rc1", "0.9.5") > 0);
  assertEquals(defaultHerdrSocketPath("default", { XDG_CONFIG_HOME: "/x" }), "/x/herdr/herdr.sock");
  assertEquals(defaultHerdrSocketPath("team", { HOME: "/h" }), "/h/.config/herdr/sessions/team/herdr.sock");
});

test("herdrEnv strips another server's handles but keeps HERDR_CONFIG_PATH", () => {
  assertEquals(herdrEnv({ PATH: "/bin", HERDR_SOCKET_PATH: "/s", HERDR_SESSION: "x", HERDR_PANE_ID: "w1:p1", HERDR_CONFIG_PATH: "/c.toml" }),
    { PATH: "/bin", HERDR_CONFIG_PATH: "/c.toml" });
});

// ─── Windows ─────────────────────────────────────────────────────────

test("openWindow on a stopped server: starts it detached, creates the workspace, reuses its first tab", () => {
  const h = fakeHerdr({ running: false });
  const t = backend(h);
  const opened = t.openWindow({
    session: "team", window: "leader", cwd: "/p/has space", command: "pi --ppt-lead",
    env: { ZED: "z", ALPHA: "a b'c" },
  });
  assertEquals(h.launched, [["--session", "default", "server"]]);
  assertEquals(made(h), [
    "status server --json", // not running
    "status server --json", // up after the launch
    "workspace list",
    // --env in key order, values verbatim; no focus stolen.
    "workspace create --label team --cwd /p/has space --env ALPHA=a b'c --env ZED=z --no-focus",
    "tab rename w1:t1 leader",
    "pane run w1:p1 export HERDR_ENV=0; pi --ppt-lead", // opted out of herdr's native restore
  ]);
  assertEquals(opened, { created: true, ref: { session: "team", window: "leader", id: "w1:p1" } });
  assertEquals(h.tab("team", "leader")?.pane.typed, ["export HERDR_ENV=0; pi --ppt-lead"]);
  assertEquals(t.listWindows("team"), ["leader"], "no stray first tab");
});

test("openWindow in an existing workspace: tab create with cwd, label, env, no focus; ids from the response", () => {
  const h = fakeHerdr();
  const t = backend(h);
  t.openWindow({ session: "team", window: "leader", cwd: "/p", command: "lead" });
  // Make the server's next ids something a predictor would get wrong.
  h.workspaces[0]!.n = 41;
  h.calls.length = 0;
  const opened = t.openWindow({ session: "team", window: "swift-ripley", cwd: "/p/x", command: "pi --ppt-worker", env: { K: "v" } });
  assertEquals(made(h), [
    "status server --json",
    "workspace list",
    "tab list --workspace w1",
    "tab create --workspace w1 --label swift-ripley --cwd /p/x --env K=v --no-focus",
    "pane run w1:p2 export HERDR_ENV=0; pi --ppt-worker",
  ]);
  assertEquals(opened.created, true);
  assertEquals(opened.ref.id, "w1:p2");
  assertEquals(h.tab("team", "swift-ripley")?.id, "w1:t42");
  assertEquals(h.tab("team", "swift-ripley")?.env, ["K=v"]);
});

test("openWindow is idempotent by label, and revives a restored tab that has only its shell", () => {
  const h = fakeHerdr();
  const t = backend(h);
  t.openWindow({ session: "team", window: "neo", cwd: "/p", command: "run-neo" });
  const again = t.openWindow({ session: "team", window: "neo", cwd: "/p", command: "run-neo" });
  assertEquals(again.created, false);
  assertEquals(h.workspaces[0]!.tabs.length, 1, "no duplicate label (herdr would allow one)");
  assertEquals(h.tab("team", "neo")?.pane.typed, ["export HERDR_ENV=0; run-neo"], "nothing typed into a live agent");

  // A server restart: same tab, same label, a fresh shell and no agent.
  h.tab("team", "neo")!.pane.idle = true;
  const revived = t.openWindow({ session: "team", window: "neo", cwd: "/p q", command: "run-neo" });
  assertEquals(revived.created, true);
  assertEquals(h.tab("team", "neo")?.pane.typed, ["export HERDR_ENV=0; run-neo", "export HERDR_ENV=0; cd '/p q' && run-neo"]);
});

test("herdrLaunchLine opts the agent out of herdr's native restore (HERDR_ENV=0), then cds and runs", () => {
  // herdr's agent integrations report a pane's session only when HERDR_ENV is 1;
  // herdr keeps its own HERDR_* over --env, so the override is on the command line.
  assertEquals(herdrLaunchLine("pi --ppt-worker"), "export HERDR_ENV=0; pi --ppt-worker");
  assertEquals(herdrLaunchLine("pi -a", "/p/it's here"), "export HERDR_ENV=0; cd '/p/it'\\''s here' && pi -a");
});

test("reads never start a server: listWindows/findWindow are empty while it is down", () => {
  const h = fakeHerdr({ running: false });
  const t = backend(h);
  assertEquals(t.listWindows("team"), []);
  assertEquals(t.findWindow("team", "neo"), null);
  assertEquals(t.closeWindow(t.windowRef("team", "neo")), false);
  assertEquals(t.focusWindow(t.windowRef("team", "neo")), false);
  assertEquals(h.launched, []);
});

test("send a line, Ctrl-C, focus and close, each resolved by label", () => {
  const h = fakeHerdr();
  const t = backend(h);
  t.openWindow({ session: "team", window: "leader", cwd: "/p", command: "lead" });
  t.openWindow({ session: "team", window: "neo", cwd: "/p", command: "work" });
  const ref = t.windowRef("team", "neo");
  assertEquals(ref, { session: "team", window: "neo" });
  assertEquals(t.findWindow("team", "neo"), { session: "team", window: "neo", id: "w1:p2" });

  t.sendLine(ref, "echo hi");
  t.sendLine(ref, "-n looks like a flag");
  t.sendControl(ref, "C-c");
  const pane = h.tab("team", "neo")!.pane;
  assertEquals(pane.typed, ["export HERDR_ENV=0; work", "echo hi", " -n looks like a flag"]);
  assertEquals(pane.keys, ["ctrl+c"]);

  h.calls.length = 0;
  assertEquals(t.focusWindow(ref), true);
  assertEquals(made(h).at(-1), "tab focus w1:t2");
  assertEquals(t.focusClient(ref), null);

  assertEquals(t.closeWindow(ref), true);
  assertEquals(t.listWindows("team"), ["leader"]);
  assertEquals(t.closeWindow(ref), false, "already gone");
  assertThrows(() => t.sendLine(ref, "x"), Error, "no herdr window team:neo");
  assertEquals(t.focusClient(ref), "no herdr window team:neo");
  t.sendControl(ref, "C-c"); // best effort: no throw
});

test("herdr's error JSON and unexpected output become clear errors", () => {
  const h = fakeHerdr();
  const t = backend(h);
  t.openWindow({ session: "team", window: "neo", cwd: "/p", command: "work" });
  // A tab create that fails with herdr's error shape.
  const failing = createHerdrBackend({
    exec: (args) => (args.includes("create")
      ? { ok: false, stdout: "", stderr: '{"error":{"code":"invalid_cwd","message":"cwd /nope does not exist"}}' }
      : h.exec(args)),
    launch: h.launch, sleep: () => {},
  });
  assertThrows(() => failing.openWindow({ session: "team", window: "b", cwd: "/nope", command: "x" }), Error,
    "herdr tab create failed: cwd /nope does not exist");
  // A response that isn't JSON, and one missing a field mpt reads.
  const garbled = createHerdrBackend({ exec: (args) => (args.includes("list") ? { ok: true, stdout: "oops", stderr: "" } : h.exec(args)), launch: h.launch });
  assertThrows(() => garbled.listWindows("team"), Error, "herdr workspace list printed something that isn't JSON: oops");
  const partial = createHerdrBackend({
    exec: (args) => (args.includes("tab") && args.includes("list") ? { ok: true, stdout: '{"result":{"tabs":[{"label":"neo"}]}}', stderr: "" } : h.exec(args)),
    launch: h.launch,
  });
  assertThrows(() => partial.listWindows("team"), Error, "herdr tab list: the response has no tab_id");
});

test("a server that doesn't come up is an error naming the session and the manual check", () => {
  const h = fakeHerdr({ running: false });
  h.state.launchStarts = false;
  const t = createHerdrBackend({ exec: h.exec, launch: h.launch, session: "solo", sleep: () => {}, serverTimeoutMs: 0 });
  assertThrows(() => t.openWindow({ session: "team", window: "neo", cwd: "/p", command: "x" }), Error,
    'the herdr server for session "solo" did not start');
  assertEquals(h.launched, [["--session", "solo", "server"]]);
});

test("insideClient is true only inside a pane of this server", () => {
  const t = backend();
  const socket = "/tmp/herdr-sandbox/c/herdr/sessions/mpt-sandbox/herdr.sock";
  assertEquals(t.insideClient({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socket }), true);
  assertEquals(t.insideClient({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/other.sock" }), false);
  assertEquals(t.insideClient({ TMUX: "/tmp/tmux-1/default,1,0" }), false);
});

test("describe: version, server, session and socket — without starting a server", () => {
  const h = fakeHerdr({ running: false });
  const idle = backend(h, "mine").describe();
  assertEquals(idle.kind, "herdr");
  assertEquals(idle.available, true);
  assertEquals(idle.version, "0.9.5");
  assertEquals(idle.serverRunning, false);
  assertEquals(idle.session, "mine");
  assertEquals(h.launched, [], "describing never starts a server");

  const up = backend(fakeHerdr()).describe();
  assertEquals([up.serverRunning, up.identity, up.session], [true, "/tmp/herdr-sandbox/c/herdr/sessions/mpt-sandbox/herdr.sock", "default"]);

  const old = fakeHerdr({ version: "0.9.1" });
  const tooOld = backend(old).describe();
  assertEquals([tooOld.available, tooOld.version], [false, "0.9.1"]);
  assertStringIncludes(tooOld.reason ?? "", "older than 0.9.5");

  const gone = fakeHerdr();
  gone.state.missing = true;
  const missing = backend(gone).describe();
  assertEquals([missing.available, missing.version, missing.serverRunning, missing.identity], [false, null, null, null]);
  assertStringIncludes(missing.fix ?? "", "herdr");
});

test("attach command: plain `herdr` for the default session, `herdr session attach <name>` otherwise", () => {
  const ref = backend().windowRef("team", "leader");
  assertEquals(backend().attachCommand(ref), "herdr");
  assertEquals(backend(fakeHerdr(), "mine").attachCommand(ref), "herdr session attach mine");
  assertStringIncludes(backend().switchHint(ref), '"leader" tab');
  assertStringIncludes(backend().switchHint(ref), '"team" workspace');
});

test("focusClient focuses the tab (server-wide), and fails clearly for a window that isn't there", () => {
  const h = fakeHerdr();
  const t = backend(h);
  t.openWindow({ session: "team", window: "leader", cwd: "/p", command: "lead" });
  assertEquals(t.focusClient(t.windowRef("team", "leader")), null);
  assertEquals(made(h).filter((c) => c.startsWith("tab focus")), [`tab focus ${h.tab("team", "leader")!.id}`]);
  assertEquals(t.focusClient(t.windowRef("team", "gone")), "no herdr window team:gone");
});

test("cachedTerminalStatus reuses an answer for its TTL, per kind and session", () => {
  let made = 0;
  let clock = 0;
  const status = cachedTerminalStatus(5000, (cfg) => {
    made += 1;
    return backend(fakeHerdr(), cfg.herdrSession);
  }, () => clock);
  assertEquals(status(config({ terminal: "herdr" })).session, "default");
  status(config({ terminal: "herdr" }));
  assertEquals(made, 1);
  assertEquals(status(config({ terminal: "herdr", herdrSession: "b" })).session, "b");
  assertEquals(made, 2);
  clock = 6000;
  status(config({ terminal: "herdr" }));
  assertEquals(made, 3);
});

test("/health reports the configured terminal's status (herdr: its session and socket)", async () => {
  await withTeam({ terminal: "herdr", herdrSession: "mine" }, async ({ app, store }) => {
    store.setTerminalStatusProbe((cfg) => backend(fakeHerdr(), cfg.herdrSession).describe());
    const health = await (await get(app, "/health")).json() as {
      terminal: string; terminalStatus: { kind: string; version: string; session: string; identity: string };
    };
    assertEquals(health.terminal, "herdr");
    assertEquals(health.terminalStatus.kind, "herdr");
    assertEquals(health.terminalStatus.version, "0.9.5");
    assertEquals(health.terminalStatus.session, "mine");
  });

  // tmux: what the startup probe recorded (none in a test store = null).
  await withTeam(undefined, async ({ app }) => {
    assertEquals((await (await get(app, "/health")).json() as { terminalStatus: unknown }).terminalStatus, null);
  });
});

// ─── Wiring: getTerminalBackend, the capability probe, the spawner ───

const config = (over: Partial<TeamConfig> = {}): TeamConfig => ({ ...structuredClone(TEST_CONFIG), tmuxSession: "team", ...over });

/** A tmux that records calls and must never be used by these tests. */
function untouchedTmux(): { exec: TmuxExec; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: (args) => { calls.push(args); return { ok: true, stdout: "", stderr: "" }; } };
}

function fakeStore(directives: SpawnableDirective[]) {
  const updates: Array<{ id: string; status: string; error?: string }> = [];
  const store: SpawnerStore = {
    getLeaderDirectives: () => directives.filter((d) => !updates.some((u) => u.id === d.id && u.status !== "pending")),
    updateLeaderDirective: (id, status, error) => { updates.push({ id, status, error }); return true; },
    getMembers: () => [],
    dismissedAgentExited: () => true,
  };
  return { store, updates };
}

test("getTerminalBackend gives herdr for terminal=herdr, on the configured herdrSession", () => {
  const h = fakeHerdr();
  const t = getTerminalBackend({ terminal: "herdr", herdrSession: "team-a" }, { herdrExec: h.exec, herdrLaunch: h.launch });
  assertEquals(t.kind, "herdr");
  assertEquals(t.available(), true);
  assertEquals(h.calls.at(-1)?.slice(0, 2), ["--session", "team-a"]);
  assertEquals(createTerminalBackend("herdr", { herdrExec: h.exec }).kind, "herdr");
});

test("probeSpawnCapability probes the configured backend: herdr's version, not tmux", () => {
  const tmux = untouchedTmux();
  const old = fakeHerdr({ version: "0.9.0" });
  const cap = probeSpawnCapability(config({ terminal: "herdr" }), tmux.exec, { herdrExec: old.exec });
  assertStringIncludes(cap.canSpawn ? "" : cap.reason, "herdr 0.9.0 is older than 0.9.5");
  assertEquals(probeSpawnCapability(config({ terminal: "herdr" }), tmux.exec, { herdrExec: fakeHerdr().exec }).canSpawn, true);
  assertEquals(tmux.calls, []);
});

test("cachedTerminalCapability reuses an answer for its TTL, per kind and session", () => {
  let probes = 0;
  let t = 0;
  const h = fakeHerdr();
  const probe = cachedTerminalCapability(5000, (cfg) => {
    probes += 1;
    return createTerminalBackend("herdr", { herdrExec: h.exec, herdrSession: cfg.herdrSession });
  }, () => t);
  probe({ terminal: "herdr" });
  probe({ terminal: "herdr" });
  assertEquals(probes, 1);
  probe({ terminal: "herdr", herdrSession: "other" });
  assertEquals(probes, 2);
  t = 6000;
  probe({ terminal: "herdr" });
  assertEquals(probes, 3);
});

test("the spawner opens a teammate in herdr (starting its server), and dismisses it there", () => {
  const h = fakeHerdr({ running: false });
  const tmux = untouchedTmux();
  const cfg = config({ terminal: "herdr", harnesses: { pi: { teammate: "run {name} on {terminal} at {terminalSession}:{terminalWindow}" } } });
  const spawn = fakeStore([{ id: "s1", action: "spawn", params: { name: "neo", cwd: process.cwd() } }]);
  const deps = { config: cfg, daemonUrl: "http://x", fallbackCwd: process.cwd(), exec: tmux.exec, herdrExec: h.exec, herdrLaunch: h.launch };
  const result = realizePending(spawn.store, deps);
  assertEquals(result.failed, []);
  assertEquals(spawn.updates, [{ id: "s1", status: "done", error: undefined }]);
  assertEquals(h.launched.length, 1, "the daemon started the herdr server");
  const tab = h.tab("team", "neo")!;
  assertEquals(tab.cwd, process.cwd());
  assertEquals(tab.pane.typed, ["export HERDR_ENV=0; run neo on herdr at team:neo"]);

  // Dismiss: C-c on one pass, close on a later one.
  let now = 10_000;
  const interrupts = new Map<string, number>();
  const dismiss = fakeStore([{
    id: "d1", action: "dismiss",
    params: { memberId: "a1", name: "neo", terminal: "herdr", terminalSession: "team", deadline: 1 },
  }]);
  const ddeps = { ...deps, now: () => now, interrupts };
  realizePending(dismiss.store, ddeps);
  assertEquals(tab.pane.keys, ["ctrl+c"]);
  now += 5_000;
  realizePending(dismiss.store, ddeps);
  assertEquals(dismiss.updates, [{ id: "d1", status: "done", error: undefined }]);
  assertEquals(h.tab("team", "neo"), undefined, "the tab is closed");
  assertEquals(tmux.calls, [], "tmux is never touched");
});

test("a spawn while herdr is unusable fails with herdr's reason, and nothing opens", () => {
  const h = fakeHerdr({ version: "0.8.0" });
  const { store, updates } = fakeStore([{ id: "s1", action: "spawn", params: { name: "neo", cwd: process.cwd() } }]);
  realizePending(store, { config: config({ terminal: "herdr" }), daemonUrl: "http://x", fallbackCwd: process.cwd(), herdrExec: h.exec, herdrLaunch: h.launch });
  assertEquals(updates[0]?.status, "failed");
  assertStringIncludes(updates[0]?.error ?? "", "could not spawn: herdr 0.8.0 is older than 0.9.5");
  assertEquals(h.workspaces, []);
});

test("focusMember focuses a herdr agent's tab in herdr", () => {
  const h = fakeHerdr();
  createHerdrBackend({ exec: h.exec, launch: h.launch }).openWindow({ session: "team", window: "neo", cwd: "/p", command: "x" });
  const member = { name: "neo", metadata: { terminal: "herdr", terminalSession: "team", terminalWindow: "neo" } };
  const tmux = untouchedTmux();
  assertEquals(focusMember(member, config(), tmux.exec, { herdrExec: h.exec }), null);
  assertEquals(made(h).at(-1), "tab focus w1:t1");
  assertEquals(focusMember({ ...member, metadata: { ...member.metadata, terminalWindow: "gone" } }, config(), tmux.exec, { herdrExec: h.exec }),
    "no herdr window team:gone");
  assertEquals(tmux.calls, []);
});

test("the store's spawn capability follows herdr's probe when terminal is herdr", async () => {
  await withTeam({ terminal: "herdr" }, async ({ app, store }) => {
    store.setTerminalProbe(() => ({ canSpawn: false, reason: "herdr 0.9.0 is older than 0.9.5", fix: "herdr update" }));
    const spawning = store.getSpawnCapability();
    assertStringIncludes(spawning.canSpawn ? "" : spawning.reason, "0.9.0");
    const health = await (await get(app, "/health")).json();
    assertEquals(health.spawning.canSpawn, false);
    assertEquals(health.assistantStartable.ok, false);

    store.setTerminalProbe(() => ({ canSpawn: true }));
    assertEquals(store.getSpawnCapability().canSpawn, true);
    assertEquals(store.getAssistantStartability().ok, true);
    // tmux's startup probe no longer decides for a herdr team.
    store.setTmuxCapability({ canSpawn: false, reason: "no tmux", fix: "install tmux" });
    assertEquals(store.getSpawnCapability().canSpawn, true);
  });
});
