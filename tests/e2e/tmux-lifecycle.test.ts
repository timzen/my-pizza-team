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
 *     retried forever in silence.
 *
 * Agent commands are stand-ins (`echo … ; sleep`), since there is no LLM here. These
 * test mpt's mechanics — windows, directives, statuses — not agent behaviour.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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

async function api<T>(sb: Sandbox, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${sb.port}${path}`, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json() as T;
}

// ─── mpt lead ────────────────────────────────────────────────────────

Deno.test({
  name: "mpt lead creates exactly one window, running the leader command in the project",
  ignore: !hasTmux(),
  async fn() {
    await using sb = await sandbox("lead");
    sb.writeTeamConfig({ harnesses: HARNESSES });

    const result = await sb.mpt("lead", "--no-attach");
    assertEquals(result.code, 0, result.output);

    // Exactly one — no stray initial window left beside the leader.
    assertEquals(await windows(sb), ["leader"]);

    const ran = await sb.waitFor(async () => (await pane(sb, "leader")).includes("LEADER-42 "), 8000);
    assertEquals(ran, true, `leader command did not run:\n${await pane(sb, "leader")}`);
    // Assert on the *output* line specifically, not anywhere in the pane.
    const output = (await pane(sb, "leader")).split("\n").find((l) => l.startsWith("LEADER-42 ")) ?? "";
    assertStringIncludes(output, `url=http://localhost:${sb.port}`);
    assertStringIncludes(output, "win=leader");
  },
});

Deno.test({
  name: "a second mpt lead attaches instead of starting another leader",
  ignore: !hasTmux(),
  async fn() {
    await using sb = await sandbox("lead-twice");
    sb.writeTeamConfig({ harnesses: HARNESSES });
    await sb.mpt("lead", "--no-attach");

    const again = await sb.mpt("lead", "--no-attach");
    assertEquals(again.code, 0, again.output);
    assertStringIncludes(again.output, "already running");
    assertEquals(await windows(sb), ["leader"], "two leaders would both answer the chat");
  },
});

Deno.test({
  name: "mpt lead refuses a harness that cannot lead, naming the config key",
  ignore: !hasTmux(),
  async fn() {
    await using sb = await sandbox("lead-noleader");
    sb.writeTeamConfig({ defaultHarness: "kiro", harnesses: { kiro: { teammate: "kiro-cli chat" } } });

    const result = await sb.mpt("lead", "--no-attach");
    assertEquals(result.code === 0, false);
    assertStringIncludes(result.output, "harnesses.kiro.leader");
    assertEquals(await windows(sb), [], "nothing should have been started");
  },
});

Deno.test({
  name: "mpt lead reports a typo'd template placeholder instead of running it",
  ignore: !hasTmux(),
  async fn() {
    await using sb = await sandbox("lead-typo");
    sb.writeTeamConfig({ harnesses: { pi: { teammate: "x", leader: "pi --ppt-daemon={ur}" } } });

    const result = await sb.mpt("lead", "--no-attach");
    assertEquals(result.code === 0, false);
    assertStringIncludes(result.output, "{ur}");
    assertEquals(await windows(sb), []);
  },
});

// ─── Daemon-driven spawning ──────────────────────────────────────────

Deno.test({
  name: "the daemon spawns a teammate with no leader connected",
  ignore: !hasTmux(),
  async fn() {
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
  },
});

Deno.test({
  name: "a spawn into a missing directory is marked failed with its reason",
  ignore: !hasTmux(),
  async fn() {
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
  },
});

Deno.test({
  name: "reset-session is left pending for the leader, not taken over by the daemon",
  ignore: !hasTmux(),
  async fn() {
    // It types `/new` — a Pi command. The daemon knowing each harness's commands is
    // exactly the coupling §3.1 removes.
    await using sb = await sandbox("spawn-reset");
    sb.writeTeamConfig({ minTeammates: 0, harnesses: HARNESSES });
    await sb.startDaemon();

    await api(sb, "/api/agents/register", { id: "t1", name: "swift-ripley", directory: sb.projectDir });
    await api(sb, "/api/leader/directives", { action: "reset-session", memberId: "t1" });

    // Give the spawner several passes to (wrongly) act on it.
    await new Promise((r) => setTimeout(r, 4500));
    const pending = await api<{ directives: Array<{ action: string }> }>(sb, "/api/leader/directives");
    assertEquals(pending.directives.some((d) => d.action === "reset-session"), true, "must still be pending for the leader");
  },
});
