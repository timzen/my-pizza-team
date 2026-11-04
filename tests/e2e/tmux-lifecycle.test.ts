/**
 * tests/e2e/tmux-lifecycle.test.ts — `mpt lead` and daemon-driven spawning (P5-3).
 *
 * The Phase 3 behaviours that were verified by hand against real tmux, now repeatable
 * on the sandbox's private tmux server:
 *
 *   - `mpt lead` creates **exactly one** window — the stray `zsh` window bug, which
 *     unit tests could not see because `spawnWindow` was correct in isolation and
 *     `cmdLead` composed it wrongly;
 *   - `mpt assistant` is the same command, and its output says "assistant" (the
 *     window keeps its internal name, `leader`);
 *   - a re-run attaches rather than starting a second leader (two leaders would both
 *     answer the chat);
 *   - the web UI's Start (`POST /api/assistant/start`) has the daemon open the same
 *     single leader window, idempotently;
 *   - inside tmux, `mpt lead` moves the user's client to the leader even from another
 *     session (`switch-client`, not just `select-window`) — with a real client,
 *     attached from a pane of a second private server;
 *   - the daemon spawns a teammate with **no leader connected**, which was impossible
 *     before P3-1;
 *   - a spawn that cannot be realized is marked `failed` with its reason, rather than
 *     retried forever in silence;
 *   - a daemon that can't reach tmux fails spawns at once, with the reason and fix,
 *     and never hands them (or dismisses) to a leader — it is the only realizer —
 *     and refuses to start the assistant, saying why;
 *   - a dismiss closes the teammate's window once it has exited;
 *   - a teammate reset goes to the teammate itself (nothing typed into its window),
 *     and a teammate too old to poll for it is refused at registration;
 *   - the leader's slash commands' daemon calls: a named spawn (/ppt-spawn <name>)
 *     and focusing a teammate's window (/ppt-hop, POST /api/agents/:id/focus);
 *   - /health names the tmux server the daemon talks to — the sandbox's own,
 *     resolved from TMUX_TMPDIR like the user's default server.
 *
 * Agent commands are stand-ins (`echo … ; sleep`), since there is no LLM here. These
 * test mpt's mechanics — windows, directives, statuses — not agent behaviour.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../_assert.ts";
import { hasTmux, sandbox, type Sandbox } from "./_sandbox.ts";
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "../../shared/protocol.ts";

/**
 * Stand-in agent commands. Each prints a marker that only *execution* can produce —
 * `$((40+2))` is typed into the pane literally but printed as `42`. Waiting on
 * text that also appears in the typed command lets a wait succeed before the command
 * has run at all, which is exactly what happened on the first CI run: fast enough
 * locally to hide, slow enough on a GitHub runner to fail.
 */
const HARNESSES = {
  pi: {
    teammate: "echo SPAWNED-$((40+2)) name={name} url={url} win={window}; sleep 30",
    leader: "echo LEADER-$((40+2)) url={url} win={window}; sleep 30",
  },
};

const windows = async (sb: Sandbox) =>
  (await sb.tmux("list-windows", "-t", sb.session, "-F", "#{window_name}")).stdout.split("\n").filter(Boolean);

/**
 * A window's contents. `-J` rejoins lines tmux wrapped at the pane width (80 columns
 * when detached) — without it, a long URL can be split mid-token and an assertion on
 * it fails for reasons that have nothing to do with mpt.
 */
const pane = async (sb: Sandbox, window: string) =>
  (await sb.tmux("capture-pane", "-p", "-J", "-t", `${sb.session}:${window}`)).stdout;

async function api<T>(sb: Sandbox, path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${sb.port}${path}`, body === undefined && method === "POST" ? {} : {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json() as T;
}

// ─── mpt assistant (alias mpt lead) ──────────────────────────────────

test("mpt assistant creates exactly one window, running the leader command in the project", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("lead");
  sb.writeTeamConfig({ harnesses: HARNESSES });

  const result = await sb.mpt("assistant", "--no-attach");
  assertEquals(result.code, 0, result.output);
  // What the user reads says "assistant"; the window keeps its internal name.
  assertStringIncludes(result.output, "Assistant started in");
  assertEquals(/leader/i.test(result.output.replace(/:leader\b/g, "")), false, result.output);

  // Exactly one — no stray initial window left beside the leader.
  assertEquals(await windows(sb), ["leader"]);

  const ran = await sb.waitFor(async () => (await pane(sb, "leader")).includes("LEADER-42 "), 8000);
  assertEquals(ran, true, `leader command did not run:\n${await pane(sb, "leader")}`);
  // Assert on the *output* specifically, not anywhere in the pane. Take it from the
  // marker onward rather than requiring it at line start: on a slow runner the keys
  // can be typed before the shell draws its prompt, so the output lands on the
  // prompt's line (`user@host:~$ LEADER-42 url=…`). Only execution prints LEADER-42.
  const marked = (await pane(sb, "leader")).split("\n").find((l) => l.includes("LEADER-42 ")) ?? "";
  const output = marked.slice(marked.indexOf("LEADER-42 "));
  assertStringIncludes(output, `url=http://localhost:${sb.port}`);
  assertStringIncludes(output, "win=leader");
});

test("a second start attaches instead of starting another leader — `lead` is the same command", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("lead-twice");
  sb.writeTeamConfig({ harnesses: HARNESSES });
  await sb.mpt("assistant", "--no-attach");

  // The alias: `mpt lead` finds the window `mpt assistant` opened.
  const again = await sb.mpt("lead", "--no-attach");
  assertEquals(again.code, 0, again.output);
  assertStringIncludes(again.output, "already running");
  assertEquals(await windows(sb), ["leader"], "two leaders would both answer the chat");
});

/**
 * A real tmux client attached to `target` on the sandbox's server, so `switch-client`
 * has someone to move. A client needs a terminal; a pane of a *second* private tmux
 * server is one (a pty, on every platform tmux runs on — no `script(1)` dialects).
 * `$TMUX` is unset inside it, or tmux would refuse to nest. Disposing kills that
 * second server, which the sandbox's teardown doesn't know about.
 */
async function attachedClient(sb: Sandbox, target: string): Promise<AsyncDisposable> {
  const hostSocket = path.join(sb.tmuxDir, "host");
  const started = await sb.tmux("-S", hostSocket, "new-session", "-d", "-x", "100", "-y", "30", `env -u TMUX tmux attach -t ${target}`);
  assertEquals(started.code, 0, started.output);
  const attached = await sb.waitFor(async () => (await clients(sb)).length > 0, 8000);
  assertEquals(attached, true, "the simulated client never attached");
  return { [Symbol.asyncDispose]: async () => { await sb.tmux("-S", hostSocket, "kill-server"); } };
}

/**
 * A second session, as the user's "mpt-services". Not `${sb.session}-…`: tmux
 * resolves `-t <name>` by unique *prefix* when there's no exact match, so before the
 * leader session exists, mpt's `has-session -t <session>` would find this one.
 */
const otherSession = (sb: Sandbox) => `svc-${sb.session}`;

/** Where each attached client is: `session:window`. */
const clients = async (sb: Sandbox) =>
  (await sb.tmux("list-clients", "-F", "#{client_session}:#{window_name}")).stdout.split("\n").filter(Boolean);

/** The `$TMUX` a shell in `session`'s pane would have: `<socket>,<server pid>,<session id>`. */
async function insideTmuxEnv(sb: Sandbox, session: string): Promise<Record<string, string>> {
  const fmt = "#{socket_path},#{pid},#{session_id},#{pane_id}";
  const [socket, pid, sessionId, pane] = (await sb.tmux("display-message", "-p", "-t", session, fmt)).stdout.trim().split(",");
  return { TMUX: `${socket},${pid},${sessionId!.replace("$", "")}`, TMUX_PANE: pane! };
}

test("mpt lead inside tmux moves the client from another session to the leader", { skip: !hasTmux() }, async () => {
  // select-window alone changed the leader session's current window but left a
  // client in another session (the user's "mpt-services") where it was.
  await using sb = await sandbox("lead-switch");
  sb.writeTeamConfig({ harnesses: HARNESSES });
  const other = otherSession(sb);
  assertEquals((await sb.tmux("new-session", "-d", "-s", other)).code, 0);
  await using _client = await attachedClient(sb, other);
  assertEquals((await clients(sb)).map((c) => c.split(":")[0]), [other], "the client starts in the other session");
  const inside = await insideTmuxEnv(sb, other);

  const first = await sb.mptWithEnv(inside, "lead");
  assertEquals(first.code, 0, first.output);
  assertStringIncludes(first.output, `Switched to ${sb.session}:leader`);
  assertEquals(await clients(sb), [`${sb.session}:leader`]);

  // Back to the other session; a re-run reuses the leader and still moves the client.
  assertEquals((await sb.tmux("switch-client", "-t", other)).code, 0);
  const again = await sb.mptWithEnv(inside, "lead");
  assertEquals(again.code, 0, again.output);
  assertStringIncludes(again.output, "already running");
  assertEquals(await windows(sb), ["leader"], "an existing leader is reused, never duplicated");
  assertEquals(await clients(sb), [`${sb.session}:leader`]);
});

test("mpt lead --no-attach inside tmux moves nothing and prints both hints", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("lead-noattach-tmux");
  sb.writeTeamConfig({ harnesses: HARNESSES });
  const other = otherSession(sb);
  assertEquals((await sb.tmux("new-session", "-d", "-s", other)).code, 0);
  await using _client = await attachedClient(sb, other);

  const result = await sb.mptWithEnv(await insideTmuxEnv(sb, other), "lead", "--no-attach");
  assertEquals(result.code, 0, result.output);
  assertStringIncludes(result.output, `tmux attach -t ${sb.session}:leader`);
  assertStringIncludes(result.output, `tmux switch-client -t ${sb.session}:leader`);
  assertEquals((await clients(sb)).every((c) => c.startsWith(`${other}:`)), true, "the client stays put");
});

test("mpt lead refuses a harness that cannot lead, naming the config key", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("lead-noleader");
  sb.writeTeamConfig({ defaultHarness: "kiro", harnesses: { kiro: { teammate: "kiro-cli chat" } } });

  const result = await sb.mpt("lead", "--no-attach");
  assertEquals(result.code === 0, false);
  assertStringIncludes(result.output, "harnesses.kiro.leader");
  assertEquals(await windows(sb), [], "nothing should have been started");
});

test("mpt lead reports a typo'd template placeholder instead of running it", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("lead-typo");
  sb.writeTeamConfig({ harnesses: { pi: { teammate: "x", leader: "pi --ppt-daemon={ur}" } } });

  const result = await sb.mpt("lead", "--no-attach");
  assertEquals(result.code === 0, false);
  assertStringIncludes(result.output, "{ur}");
  assertEquals(await windows(sb), []);
});

// ─── Daemon-driven spawning ──────────────────────────────────────────

test("POST /api/assistant/start twice opens one leader window, run by the daemon", { skip: !hasTmux() }, async () => {
  // The web UI's Start button: the daemon opens the leader's window itself, with
  // nobody attached. A second press (or a second tab) is already-running, never a
  // second leader — two would both answer the chat.
  await using sb = await sandbox("assistant-start");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  const health = await api<{ assistantStartable: { ok: boolean } }>(sb, "/health", undefined, "GET");
  assertEquals(health.assistantStartable, { ok: true });

  const first = await fetch(`http://127.0.0.1:${sb.port}/api/assistant/start`, { method: "POST" });
  assertEquals(first.status, 201);
  assertEquals(((await first.json()) as { status: string }).status, "started");
  const second = await fetch(`http://127.0.0.1:${sb.port}/api/assistant/start`, { method: "POST" });
  assertEquals(second.status, 200);
  assertEquals(((await second.json()) as { status: string }).status, "already-running");

  assertEquals((await windows(sb)).filter((w) => w === "leader"), ["leader"], "exactly one leader window");
  assertEquals(await windows(sb), ["leader"], "and no stray initial window beside it");
  const ran = await sb.waitFor(async () => (await pane(sb, "leader")).includes("LEADER-42 "), 8000);
  assertEquals(ran, true, `leader command did not run:\n${await pane(sb, "leader")}`);
  // The daemon's own URL (its real port), not a default.
  const marked = (await pane(sb, "leader")).split("\n").find((l) => l.includes("LEADER-42 ")) ?? "";
  assertStringIncludes(marked.slice(marked.indexOf("LEADER-42 ")), `url=http://localhost:${sb.port}`);

  // And `mpt lead` sees the same leader rather than starting another.
  const lead = await sb.mpt("lead", "--no-attach");
  assertEquals(lead.code, 0, lead.output);
  assertStringIncludes(lead.output, "already running");
  assertEquals(await windows(sb), ["leader"]);
});

test("the daemon spawns a teammate with no leader connected", { skip: !hasTmux() }, async () => {
  // Impossible before P3-1, when only the leader realized directives.
  await using sb = await sandbox("spawn");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  const health = await api<{ spawning: { canSpawn: boolean } }>(sb, "/health");
  assertEquals(health.spawning.canSpawn, true, "the daemon should report it can reach tmux");

  const created = await api<{ directive: { params: { name: string } } }>(
    sb,
    "/api/leader/directives",
    { action: "spawn", params: { cwd: sb.projectDir } },
  );
  const name = created.directive.params.name;

  const appeared = await sb.waitFor(async () => (await windows(sb)).includes(name), 8000);
  assertEquals(appeared, true, `no window for ${name}; windows: ${await windows(sb)}`);

  const ran = await sb.waitFor(async () => (await pane(sb, name)).includes(`SPAWNED-42 name=${name}`), 8000);
  assertEquals(ran, true, `teammate command did not run:\n${await pane(sb, name)}`);

  // And the directive was resolved rather than left pending to be re-realized.
  const requests = await api<{ requests: unknown[]; failed: unknown[] }>(sb, "/api/spawn-requests");
  assertEquals(requests.requests.length, 0);
  assertEquals(requests.failed.length, 0);
});

test("a spawn into a missing directory is marked failed with its reason", { skip: !hasTmux() }, async () => {
  // Left pending, it would be retried every 2s, spawning nothing and saying nothing.
  await using sb = await sandbox("spawn-fail");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  await api(sb, "/api/leader/directives", { action: "spawn", params: { cwd: "/definitely/not/here" } });

  let failed: Array<{ error: string }> = [];
  const surfaced = await sb.waitFor(async () => {
    failed = (await api<{ failed: Array<{ error: string }> }>(sb, "/api/spawn-requests")).failed;
    return failed.length > 0;
  }, 8000);
  assertEquals(surfaced, true, "the failure should surface");
  assertStringIncludes(failed[0]!.error, "not a directory");
  assertEquals(await windows(sb), [], "and no window should have been created");
});

test("a teammate reset goes to the teammate itself — nothing is typed into its window", { skip: !hasTmux() }, async () => {
  // It used to be the leader typing `/new` (a Pi command) into the window. Now the
  // ask is a `new-session` the teammate polls and realizes in-process; the daemon
  // never learns a harness's keystrokes (DESIGN.md "The Daemon Is the Supervisor").
  await using sb = await sandbox("spawn-reset");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  const created = await api<{ directive: { params: { name: string } } }>(
    sb, "/api/leader/directives", { action: "spawn", params: { cwd: sb.projectDir } },
  );
  const name = created.directive.params.name;
  assertEquals(await sb.waitFor(async () => (await pane(sb, name)).includes(`SPAWNED-42 name=${name}`), 8000), true, `no window for ${name}`);

  // A current teammate (it speaks the protocol version that polls its own directives).
  await api(sb, "/api/agents/register", {
    id: "t1", name, directory: sb.projectDir, protocolVersion: PROTOCOL_VERSION,
    metadata: { tmuxSession: sb.session, tmuxWindow: name },
  });
  const reset = await api<{ directive: { action: string } }>(sb, "/api/agents/t1/directives", { action: "new-session" });
  assertEquals(reset.directive.action, "new-session");
  // An older UI's `reset-session` POST lands in the same place.
  const legacy = await api<{ directive: { action: string } }>(sb, "/api/leader/directives", { action: "reset-session", memberId: "t1" });
  assertEquals(legacy.directive.action, "new-session");

  // Give the spawner several passes to (wrongly) act on them.
  await new Promise((r) => setTimeout(r, 4500));
  const own = await api<{ directives: Array<{ action: string }> }>(sb, "/api/agents/t1/directives", undefined, "GET");
  assertEquals(own.directives.map((d) => d.action), ["new-session", "new-session"], "pending for the teammate itself");
  const forLeader = await api<{ directives: unknown[] }>(sb, "/api/leader/directives", undefined, "GET");
  assertEquals(forLeader.directives, [], "nothing for the leader");
  assertEquals((await pane(sb, name)).includes("/new"), false, "nothing typed into the teammate's window");
  assertEquals((await windows(sb)).includes(name), true, "and its window left alone");
});

test("a teammate too old to reset itself is refused at registration, not left for a leader", { skip: !hasTmux() }, async () => {
  // A v5 teammate never polls its own directives, and the leader that used to type
  // `/new` into its window no longer touches tmux — so its reset would silently do
  // nothing. MIN_PROTOCOL_VERSION refuses it instead, with the fix.
  await using sb = await sandbox("spawn-reset-legacy");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  const res = await fetch(`http://127.0.0.1:${sb.port}/api/agents/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "t1", name: "swift-ripley", directory: sb.projectDir, protocolVersion: MIN_PROTOCOL_VERSION - 1 }),
  });
  assertEquals(res.status, 409);
  assertStringIncludes(((await res.json()) as { error: string }).error, "Restart the agent");
});

// ─── The leader's slash commands, through the daemon ──────────────────
//
// The Pi leader no longer runs tmux (harnesses/pi/tests/structure.test.mjs keeps it
// that way): /ppt-spawn is a spawn directive, /ppt-hop is POST /api/agents/:id/focus.
// These drive the same daemon calls against real tmux.

test("a spawn with a given name (/ppt-spawn <name>) opens a window with that name", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("spawn-named");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  const created = await api<{ directive: { id: string; params: { name: string } } }>(
    sb, "/api/leader/directives", { action: "spawn", params: { name: "bold-uhura", cwd: sb.projectDir } },
  );
  assertEquals(created.directive.params.name, "bold-uhura");
  assertEquals(await sb.waitFor(async () => (await pane(sb, "bold-uhura")).includes("SPAWNED-42 name=bold-uhura"), 8000), true,
    `no window for bold-uhura; windows: ${await windows(sb)}`);
  // What /ppt-spawn waits on: the directive leaves the pending list without failing.
  const spawns = await api<{ requests: Array<{ id: string }>; failed: Array<{ id: string }> }>(sb, "/api/spawn-requests", undefined, "GET");
  assertEquals(spawns.requests.some((r) => r.id === created.directive.id), false);
  assertEquals(spawns.failed.some((f) => f.id === created.directive.id), false);
});

test("focusing a teammate (/ppt-hop) selects its window; an unknown window is a 409 with the reason", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("focus");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  // Two teammate windows, so selecting one is observable.
  for (const name of ["kind-sulu", "calm-data"]) {
    await api(sb, "/api/leader/directives", { action: "spawn", params: { name, cwd: sb.projectDir } });
    assertEquals(await sb.waitFor(async () => (await windows(sb)).includes(name), 8000), true, `no window for ${name}`);
  }
  await api(sb, "/api/agents/register", {
    id: "t1", name: "kind-sulu", protocolVersion: PROTOCOL_VERSION, metadata: { tmuxSession: sb.session, tmuxWindow: "kind-sulu" },
  });
  const current = async () => (await sb.tmux("display-message", "-p", "-t", sb.session, "#{window_name}")).stdout.trim();
  assertEquals(await current(), "calm-data", "the newest window is current before the hop");

  const res = await fetch(`http://127.0.0.1:${sb.port}/api/agents/t1/focus`, { method: "POST" });
  assertEquals(res.status, 200);
  assertEquals(await current(), "kind-sulu");

  // A registered agent whose window is gone: the reason, not a silent success.
  await api(sb, "/api/agents/register", { id: "t2", name: "lost-worf", protocolVersion: PROTOCOL_VERSION, metadata: {} });
  const missing = await fetch(`http://127.0.0.1:${sb.port}/api/agents/t2/focus`, { method: "POST" });
  assertEquals(missing.status, 409);
  assertStringIncludes(((await missing.json()) as { error: string }).error, `no tmux window ${sb.session}:lost-worf`);
});

test("/health names the daemon's tmux server: the user's default one, under TMUX_TMPDIR", { skip: !hasTmux() }, async () => {
  // Plain `tmux`, no -L/-S: users attach with `tmux attach -t mpt`. The sandbox's
  // TMUX_TMPDIR is what makes that server private here, so it must keep working.
  await using sb = await sandbox("socket");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();
  const health = await api<{ tmuxSocket: string | null }>(sb, "/health");
  const uid = process.getuid!();
  assertEquals(health.tmuxSocket, path.join(fs.realpathSync(sb.tmuxDir), `tmux-${uid}`, "default"));
  // And it is the server the sandbox's own `tmux` reaches (what `mpt doctor` compares).
  await sb.tmux("new-session", "-d", "-s", "probe");
  assertEquals((await sb.tmux("display-message", "-p", "#{socket_path}")).stdout.trim(), health.tmuxSocket);
});

test("a dismiss closes the teammate's window once it has exited", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("dismiss");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  const created = await api<{ directive: { params: { name: string } } }>(
    sb, "/api/leader/directives", { action: "spawn", params: { cwd: sb.projectDir } },
  );
  const name = created.directive.params.name;
  assertEquals(await sb.waitFor(async () => (await windows(sb)).includes(name), 8000), true, `no window for ${name}`);

  // Stand in for the teammate: register under the window's name, get dismissed,
  // hear it on the next heartbeat, and deregister on the way out.
  await api(sb, "/api/agents/register", { id: "t1", name, metadata: { tmuxSession: sb.session, tmuxWindow: name } });
  await api(sb, "/api/agents/t1?dismiss=true", undefined, "DELETE");
  const beat = await api<{ dismissed?: boolean }>(sb, "/api/agents/heartbeat", { id: "t1", status: "idle" });
  assertEquals(beat.dismissed, true);
  await api(sb, "/api/agents/t1", undefined, "DELETE");

  // C-c on one pass, kill-window on a later one (≥1.5s on): well inside 10s.
  const closed = await sb.waitFor(async () => !(await windows(sb)).includes(name), 10_000);
  assertEquals(closed, true, `window ${name} still open: ${await windows(sb)}`);
});

test("a daemon that can't reach tmux fails a spawn at once, with the reason and fix — no leader fallback", { skip: !hasTmux() }, async () => {
  // A PATH with everything the daemon needs but tmux: what a launchd/systemd daemon
  // without the user's PATH looks like. The leader used to realize spawns then;
  // now the daemon is the only realizer, so the failure is the answer.
  await using sb = await sandbox("no-tmux");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  const noTmux = path.join(sb.root, "no-tmux-bin");
  fs.mkdirSync(noTmux);
  for (const tool of ["git", "sh"]) {
    const found = sb.env["PATH"]!.split(":").map((d) => path.join(d, tool)).find((p) => fs.existsSync(p));
    if (found) fs.symlinkSync(found, path.join(noTmux, tool));
  }
  await sb.startDaemon("cli", { env: { PATH: noTmux } });

  const health = await api<{ spawning: { canSpawn: boolean; reason?: string; fix?: string }; tmuxSocket: string | null }>(sb, "/health");
  assertEquals(health.spawning.canSpawn, false);
  assertStringIncludes(health.spawning.reason!, "PATH");
  assertEquals(health.tmuxSocket, null);

  const created = await api<{ directive: { status: string } }>(sb, "/api/leader/directives", { action: "spawn", params: { cwd: sb.projectDir } });
  assertEquals(created.directive.status, "failed", "failed on creation, not left pending");
  const spawns = await api<{ requests: unknown[]; failed: Array<{ error: string }> }>(sb, "/api/spawn-requests", undefined, "GET");
  assertEquals(spawns.requests, []);
  assertStringIncludes(spawns.failed[0]!.error, "tmux is not on this process's PATH — fix:");

  // Nor can the assistant be started from the UI; /health says why, and so does the route.
  const startable = (await api<{ assistantStartable: { ok: boolean; reason?: string } }>(sb, "/health")).assistantStartable;
  assertEquals(startable.ok, false);
  assertStringIncludes(startable.reason!, "PATH");
  const start = await fetch(`http://127.0.0.1:${sb.port}/api/assistant/start`, { method: "POST" });
  assertEquals(start.status, 409);
  assertEquals(((await start.json()) as { code: string }).code, "tmux-unavailable");

  // A dismiss isn't handed to a leader either: the tombstone stops the agent, and
  // the window close fails with the reason.
  await api(sb, "/api/agents/register", { id: "t1", name: "swift-ripley", metadata: {} });
  await api(sb, "/api/agents/t1?dismiss=true", undefined, "DELETE");
  const forLeader = await api<{ directives: Array<{ action: string }> }>(sb, "/api/leader/directives", undefined, "GET");
  assertEquals(forLeader.directives.filter((d) => d.action === "spawn" || d.action === "dismiss"), []);
  const beat = await api<{ dismissed?: boolean }>(sb, "/api/agents/heartbeat", { id: "t1", status: "idle" });
  assertEquals(beat.dismissed, true);
  assertEquals(await windows(sb), [], "nothing reached tmux");
});
