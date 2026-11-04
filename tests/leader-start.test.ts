/**
 * tests/leader-start.test.ts — starting the assistant (the leader) from the daemon.
 *
 * daemon/leader-start.ts is the one place "start the leader" becomes a tmux window,
 * shared by `mpt lead` and `POST /api/assistant/start` (the web UI's Start button).
 * What matters, beyond the window opening:
 *
 *   - **Idempotent.** An existing window, or a leader already connected, is
 *     `already-running` and opens nothing: two leaders would both answer the chat.
 *   - **Every refusal says why and how to fix it** — tmux unreachable, a harness
 *     with no leader template, a typo'd placeholder — before anything runs.
 *   - The route answers with the same reasons, and `/health` / `/api/teammate-pool`
 *     report whether a start is possible at all (`assistantStartable`), so the UI
 *     can show the button or the reason.
 *
 * Tmux is always a fake here; tests/e2e/tmux-lifecycle.test.ts starts a real one.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { get, post, withTeam } from "./_team.ts";
import { DEFAULT_HARNESS_TEMPLATES, LEADER_WINDOW, type TeamConfig } from "../shared/types.ts";
import type { ExecResult, TmuxExec } from "../daemon/terminal/tmux.ts";
import { assistantStartability, startLeader } from "../daemon/leader-start.ts";
import { fakeHerdr } from "./_herdr.ts";

/** A fake tmux recording every call; `windows` are what `list-windows` reports. */
function fakeTmux(windows: string[] = [], fail?: string): { exec: TmuxExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: TmuxExec = (args) => {
    calls.push(args);
    const res = (out: Partial<ExecResult>): ExecResult => ({ ok: out.ok ?? true, stdout: out.stdout ?? "", stderr: out.stderr ?? "" });
    if (args[0] === "list-windows") return windows.length ? res({ stdout: windows.join("\n") }) : res({ ok: false });
    if (args[0] === "has-session") return res({ ok: windows.length > 0 });
    if (fail && args[0] === fail) return res({ ok: false, stderr: "server exited unexpectedly" });
    return res({});
  };
  return { exec, calls };
}

const config = (cfg: Partial<TeamConfig> = {}): TeamConfig => ({ ...structuredClone(TEST_CONFIG), tmuxSession: "team", ...cfg });

/** A team dir inside a temp project dir, removed afterwards. */
function withProject<T>(fn: (teamDir: string, projectDir: string) => T): T {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-leader-start-"));
  const teamDir = path.join(projectDir, ".my-pizza-team");
  fs.mkdirSync(teamDir);
  try {
    return fn(teamDir, projectDir);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

const UNREACHABLE = { canSpawn: false as const, reason: "tmux is not on this process's PATH", fix: "install tmux" };

// ─── The module ──────────────────────────────────────────────────────

test("the built-in Pi leader template approves the project folder (-a), like the teammate's", () => {
  // Started from the UI nobody is attached to answer "Trust project folder?".
  assertStringIncludes(DEFAULT_HARNESS_TEMPLATES["pi"]!.leader!, "pi -a --ppt-lead");
  assertStringIncludes(DEFAULT_HARNESS_TEMPLATES["pi"]!.teammate, "pi -a ");
});

test("startLeader opens the leader window in the project dir, running the rendered template", () => {
  withProject((teamDir, projectDir) => {
    const { exec, calls } = fakeTmux();
    const result = startLeader({ config: config(), teamDir, daemonUrl: "http://localhost:9999", exec });
    assertEquals(result.status, "started");
    if (result.status !== "started") return;
    assertEquals(result.session, "team");
    assertEquals(result.window, LEADER_WINDOW);
    assertEquals(result.cwd, projectDir);
    assertEquals(result.envWarning, null);

    // A fresh session: its first window is renamed to the leader's, not left beside it.
    assertEquals(calls.some((c) => c[0] === "new-session"), true);
    assertEquals(calls.find((c) => c[0] === "rename-window"), ["rename-window", "-t", "team", LEADER_WINDOW]);
    const typed = calls.find((c) => c[0] === "send-keys")![3]!;
    assertStringIncludes(typed, `cd '${projectDir}' && pi -a --ppt-lead --ppt-daemon=http://localhost:9999`);
    assertStringIncludes(typed, "--ppt-terminal=tmux --ppt-terminal-session=team --ppt-terminal-window=leader");
  });
});

test("startLeader gives the window the agent env file's variables (-e), never typed into the shell", () => {
  withProject((teamDir) => {
    fs.writeFileSync(path.join(teamDir, "agent.env"), "AWS_PROFILE=dev\nTOKEN=s3cret\n");
    const { exec, calls } = fakeTmux();
    const result = startLeader({ config: config({ agentEnvFile: "agent.env" }), teamDir, daemonUrl: "http://x", exec });
    assertEquals(result.status === "started" && result.envKeys, 2);
    assertEquals(result.status === "started" && result.envPath, path.join(teamDir, "agent.env"));
    const created = calls.find((c) => c[0] === "new-session")!;
    assertStringIncludes(created.join(" "), "-e AWS_PROFILE=dev");
    assertEquals(calls.find((c) => c[0] === "send-keys")![3]!.includes("s3cret"), false);
  });
});

test("startLeader with a missing agent env file still starts, and says why", () => {
  withProject((teamDir) => {
    const { exec } = fakeTmux();
    const result = startLeader({ config: config({ agentEnvFile: "missing.env" }), teamDir, daemonUrl: "http://x", exec });
    assertEquals(result.status, "started");
    if (result.status !== "started") return;
    assertStringIncludes(result.envWarning ?? "", "agentEnvFile not applied");
    assertEquals(result.envPath, null);
  });
});

test("startLeader is idempotent: an existing leader window is already-running and nothing is opened", () => {
  withProject((teamDir) => {
    const { exec, calls } = fakeTmux(["kind-sulu", LEADER_WINDOW]);
    const result = startLeader({ config: config(), teamDir, daemonUrl: "http://x", exec });
    assertEquals(result.status, "already-running");
    // Only looked: nothing created, renamed or typed.
    assertEquals(calls.filter((c) => c[0] !== "list-windows" && c[0] !== "has-session"), []);
    if (result.status === "already-running") assertEquals(result.attach, `tmux attach -t team:${LEADER_WINDOW}`);
  });
});

test("startLeader says which terminal it used and how to attach", () => {
  withProject((teamDir) => {
    const { exec } = fakeTmux();
    const result = startLeader({ config: config(), teamDir, daemonUrl: "http://x", exec });
    assertEquals(result.status === "started" && result.terminal, "tmux");
    assertEquals(result.status === "started" && result.attach, `tmux attach -t team:${LEADER_WINDOW}`);
  });
});

// ─── Under herdr ─────────────────────────────────────────────────────

test("under herdr, startLeader opens the leader tab with the env file's variables, idempotently", () => {
  withProject((teamDir, projectDir) => {
    fs.writeFileSync(path.join(teamDir, "agent.env"), "AWS_PROFILE=dev\n");
    const h = fakeHerdr({ running: false });
    const cfg = config({ terminal: "herdr", herdrSession: "mine", agentEnvFile: "agent.env" });
    const first = startLeader({ config: cfg, teamDir, daemonUrl: "http://x", herdrExec: h.exec, herdrLaunch: h.launch });
    assertEquals(first.status, "started");
    if (first.status !== "started") return;
    assertEquals(first.terminal, "herdr");
    assertEquals(first.attach, "herdr session attach mine");
    assertEquals(first.envKeys, 1);
    assertEquals(h.launched, [["--session", "mine", "server"]], "the session's server was started");
    const tab = h.tab("team", LEADER_WINDOW)!;
    assertEquals(tab.env, ["AWS_PROFILE=dev"]);
    assertEquals(tab.cwd, projectDir);
    assertStringIncludes(tab.pane.typed[0]!, "--ppt-terminal=herdr --ppt-terminal-session=team --ppt-terminal-window=leader");

    // Again: already running, nothing typed, no second tab.
    const again = startLeader({ config: cfg, teamDir, daemonUrl: "http://x", herdrExec: h.exec, herdrLaunch: h.launch });
    assertEquals(again.status, "already-running");
    assertEquals(h.workspaces[0]!.tabs.map((t) => t.label), [LEADER_WINDOW]);
    assertEquals(tab.pane.typed.length, 1);

    // A server restart restored the tab but not its process: that's not a running
    // leader, so the command runs into it again.
    tab.pane.idle = true;
    const revived = startLeader({ config: cfg, teamDir, daemonUrl: "http://x", herdrExec: h.exec, herdrLaunch: h.launch });
    assertEquals(revived.status, "started");
    assertEquals(tab.pane.typed.length, 2);
  });
});

test("under herdr's default session, the attach command is plain `herdr`", () => {
  withProject((teamDir) => {
    const h = fakeHerdr();
    const result = startLeader({ config: config({ terminal: "herdr" }), teamDir, daemonUrl: "http://x", herdrExec: h.exec, herdrLaunch: h.launch });
    assertEquals(result.status === "started" && result.attach, "herdr");
  });
});

test("startLeader: a leader already connected is already-running, whatever tmux shows", () => {
  withProject((teamDir) => {
    const { exec, calls } = fakeTmux();
    const result = startLeader({ config: config(), teamDir, daemonUrl: "http://x", exec, leaderOnline: true });
    assertEquals(result.status, "already-running");
    assertEquals(calls, []);
  });
});

test("startLeader refuses a harness with no leader template, naming the config key", () => {
  withProject((teamDir) => {
    const { exec, calls } = fakeTmux();
    const cfg = config({ defaultHarness: "kiro", harnesses: { kiro: { teammate: "kiro-cli chat" } } });
    const result = startLeader({ config: cfg, teamDir, daemonUrl: "http://x", exec });
    assertEquals(result.status, "error");
    if (result.status !== "error") return;
    assertEquals(result.code, "no-template");
    assertStringIncludes(result.reason, `harness "kiro"`);
    assertStringIncludes(result.fix, "harnesses.kiro.leader");
    assertEquals(calls, [], "nothing started");
  });
});

test("startLeader refuses unknown placeholders instead of running them", () => {
  withProject((teamDir) => {
    const { exec, calls } = fakeTmux();
    const cfg = config({ harnesses: { pi: { teammate: "x", leader: "pi --ppt-daemon={ur}" } } });
    const result = startLeader({ config: cfg, teamDir, daemonUrl: "http://x", exec });
    assertEquals(result.status === "error" && result.code, "unresolved-placeholders");
    assertEquals(result.status === "error" && result.reason.includes("{ur}"), true);
    assertEquals(calls, []);
  });
});

test("startLeader refuses when tmux is unreachable, with the capability's reason and fix", () => {
  withProject((teamDir) => {
    const { exec, calls } = fakeTmux();
    const result = startLeader({ config: config(), teamDir, daemonUrl: "http://x", exec, tmux: UNREACHABLE });
    assertEquals(result, { status: "error", code: "tmux-unavailable", reason: UNREACHABLE.reason, fix: UNREACHABLE.fix });
    assertEquals(calls, []);
  });
});

test("startLeader reports tmux refusing the window as an error, never a throw", () => {
  withProject((teamDir) => {
    const { exec } = fakeTmux([], "new-session");
    const result = startLeader({ config: config(), teamDir, daemonUrl: "http://x", exec });
    assertEquals(result.status === "error" && result.code, "tmux-failed");
    assertEquals(result.status === "error" && result.reason.includes("server exited unexpectedly"), true);
  });
});

test("assistantStartability: ok by default; else the first failure's reason and fix", () => {
  assertEquals(assistantStartability(config()), { ok: true });
  assertEquals(assistantStartability(config(), UNREACHABLE), { ok: false, reason: UNREACHABLE.reason, fix: UNREACHABLE.fix });
  const noLeader = assistantStartability(config({ defaultHarness: "claude" }));
  assertEquals(noLeader.ok, false);
  assertStringIncludes(!noLeader.ok ? noLeader.fix : "", "harnesses.claude.leader");
  // A config overriding only another harness keeps Pi's built-in leader.
  assertEquals(assistantStartability(config({ harnesses: { kiro: { teammate: "k" } } })), { ok: true });
  // {mpt} is a known placeholder (the daemon fills it).
  assertEquals(assistantStartability(config({ harnesses: { pi: { teammate: "x", leader: "{mpt} lead-ish {url}" } } })), { ok: true });
});

// ─── The route and the payloads the UI reads ─────────────────────────

test("POST /api/assistant/start refuses with 409 and the reason + fix when the daemon can't reach tmux", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.setTmuxCapability(UNREACHABLE);
    const res = await post(app, "/api/assistant/start");
    assertEquals(res.status, 409);
    const body = await res.json() as { success: boolean; code: string; reason: string; fix: string; error: string };
    assertEquals(body.success, false);
    assertEquals(body.code, "tmux-unavailable");
    assertEquals(body.reason, UNREACHABLE.reason);
    assertEquals(body.fix, UNREACHABLE.fix);
    assertStringIncludes(body.error, "fix: install tmux");
  });
});

test("POST /api/assistant/start refuses a default harness with no leader template", async () => {
  await withTeam({ defaultHarness: "kiro", harnesses: { kiro: { teammate: "kiro-cli chat" } } }, async ({ app }) => {
    const res = await post(app, "/api/assistant/start");
    assertEquals(res.status, 409);
    const body = await res.json() as { code: string; fix: string };
    assertEquals(body.code, "no-template");
    assertStringIncludes(body.fix, "harnesses.kiro.leader");
  });
});

test("POST /api/assistant/start with a leader already connected is already-running (200), not a second leader", async () => {
  await withTeam({}, async ({ app }) => {
    await post(app, "/api/agents/register", { id: "leader-1", name: "leader" });
    const res = await post(app, "/api/assistant/start");
    assertEquals(res.status, 200);
    const body = await res.json() as { success: boolean; status: string; window: string };
    assertEquals(body.success, true);
    assertEquals(body.status, "already-running");
    assertEquals(body.window, LEADER_WINDOW);
  });
});

test("POST /api/assistant/start needs the API token when one is configured", async () => {
  await withTeam({ apiToken: "t0ken" }, async ({ app }) => {
    assertEquals((await post(app, "/api/assistant/start")).status, 401);
  });
});

test("/health and /api/teammate-pool report assistantStartable, following the live config", async () => {
  await withTeam({}, async ({ app, store }) => {
    const health = async () => (await (await get(app, "/health")).json() as { assistantStartable: unknown }).assistantStartable;
    const pool = async () => (await (await get(app, "/api/teammate-pool")).json() as { assistantStartable: unknown }).assistantStartable;
    assertEquals(await health(), { ok: true });
    assertEquals(await pool(), { ok: true });

    store.getConfig().defaultHarness = "claude";
    const blocked = await health() as { ok: boolean; fix: string };
    assertEquals(blocked.ok, false);
    assertStringIncludes(blocked.fix, "harnesses.claude.leader");
    store.getConfig().defaultHarness = "pi";

    store.setTmuxCapability(UNREACHABLE);
    assertEquals(await pool(), { ok: false, reason: UNREACHABLE.reason, fix: UNREACHABLE.fix });
  });
});
