/**
 * tests/e2e/tmux-lifecycle.test.ts — `mpt lead` and daemon-driven spawning (P5-3).
 *
 * The Phase 3 behaviours that were verified by hand against real tmux, now repeatable
 * on the sandbox's private tmux server:
 *
 *   - `mpt lead` creates **exactly one** window — the stray `zsh` window bug, which
 *     unit tests could not see because `spawnWindow` was correct in isolation and
 *     `cmdLead` composed it wrongly;
 *   - a re-run attaches rather than starting a second leader (two leaders would both
 *     answer the chat);
 *   - the daemon spawns a teammate with **no leader connected**, which was impossible
 *     before P3-1;
 *   - a spawn that cannot be realized is marked `failed` with its reason, rather than
 *     retried forever in silence;
 *   - a daemon that can't reach tmux fails spawns at once, with the reason and fix,
 *     and never hands them (or dismisses) to a leader — it is the only realizer;
 *   - a dismiss closes the teammate's window once it has exited;
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

// ─── mpt lead ────────────────────────────────────────────────────────

test("mpt lead creates exactly one window, running the leader command in the project", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("lead");
  sb.writeTeamConfig({ harnesses: HARNESSES });

  const result = await sb.mpt("lead", "--no-attach");
  assertEquals(result.code, 0, result.output);

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

test("a second mpt lead attaches instead of starting another leader", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("lead-twice");
  sb.writeTeamConfig({ harnesses: HARNESSES });
  await sb.mpt("lead", "--no-attach");

  const again = await sb.mpt("lead", "--no-attach");
  assertEquals(again.code, 0, again.output);
  assertStringIncludes(again.output, "already running");
  assertEquals(await windows(sb), ["leader"], "two leaders would both answer the chat");
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

test("reset-session is left pending for the leader, not taken over by the daemon", { skip: !hasTmux() }, async () => {
  // It types `/new` — a Pi command. The daemon knowing each harness's commands is
  // exactly the coupling DESIGN.md "The Daemon Is the Supervisor" removes.
  await using sb = await sandbox("spawn-reset");
  sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
  await sb.startDaemon();

  await api(sb, "/api/agents/register", { id: "t1", name: "swift-ripley", directory: sb.projectDir });
  await api(sb, "/api/leader/directives", { action: "reset-session", memberId: "t1" });

  // Give the spawner several passes to (wrongly) act on it.
  await new Promise((r) => setTimeout(r, 4500));
  const pending = await api<{ directives: Array<{ action: string }> }>(sb, "/api/leader/directives");
  assertEquals(pending.directives.some((d) => d.action === "reset-session"), true, "must still be pending for the leader");
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
