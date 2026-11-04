/**
 * tests/terminal-config.test.ts — the team's `terminal` setting and the
 * backend-neutral window metadata (story "herdr as an alternative terminal
 * backend", task 3).
 *
 * Three things matter:
 *
 *   1. **The setting is validated and live.** `PUT /api/config` takes `terminal`
 *      (one of TERMINAL_KINDS; null clears it), saves it, and the spawn and
 *      assistant-start capability checks re-read it. herdr is accepted but refused
 *      with a clear "not available yet" — never silently opened in tmux.
 *   2. **Metadata reads prefer the neutral keys** (`terminal`, `terminalSession`,
 *      `terminalWindow`, `terminalHandle`) and fall back to the pre-herdr
 *      `tmuxSession`/`tmuxWindow`, which mean "tmux".
 *   3. **Dismiss and focus use the backend an agent was started under**, not the
 *      current config — so switching the setting never strands an old window.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { get, post, put, withTeam } from "./_team.ts";
import { resolveTerminal, terminalMetadata, type TeamConfig } from "../shared/types.ts";
import { serializeTeamConfig } from "../shared/team-config.ts";
import {
  agentsOnOtherTerminal,
  dismissParams,
  dismissTerminal,
  focusMember,
  memberTerminal,
  realizePending,
  terminalChoiceCapability,
  type SpawnableDirective,
  type SpawnerStore,
} from "../daemon/spawner.ts";
import { assistantStartability, startLeader } from "../daemon/leader-start.ts";
import { createTerminalBackend, getTerminalBackend } from "../daemon/terminal/index.ts";
import type { ExecResult, TmuxExec } from "../daemon/terminal/tmux.ts";

/** A fake tmux holding `windows` in every session; records every call. */
function fakeTmux(windows: string[] = []) {
  const live = new Set(windows);
  const calls: string[][] = [];
  const exec: TmuxExec = (args): ExecResult => {
    calls.push(args);
    if (args[0] === "list-windows") return { ok: true, stdout: [...live].join("\n"), stderr: "" };
    if (args[0] === "kill-window") live.delete(args[2]!.split(":")[1]!);
    return { ok: true, stdout: "", stderr: "" };
  };
  return { exec, calls, live };
}

function fakeStore(directives: SpawnableDirective[]) {
  const updates: Array<{ id: string; status: string; error?: string }> = [];
  const store: SpawnerStore = {
    getLeaderDirectives: () => directives,
    updateLeaderDirective: (id, status, error) => { updates.push({ id, status, error }); return true; },
    getMembers: () => [],
    dismissedAgentExited: () => true,
  };
  return { store, updates };
}

const config = (over: Partial<TeamConfig> = {}): TeamConfig => ({ ...structuredClone(TEST_CONFIG), tmuxSession: "team", ...over });

// ─── The setting ─────────────────────────────────────────────────────

test("terminal defaults to tmux; unknown values resolve to the default but are refused by the capability check", () => {
  assertEquals(resolveTerminal({}), "tmux");
  assertEquals(resolveTerminal(undefined), "tmux");
  assertEquals(resolveTerminal({ terminal: "herdr" }), "herdr");
  assertEquals(resolveTerminal({ terminal: "screen" as never }), "tmux");

  assertEquals(terminalChoiceCapability({}).canSpawn, true);
  assertEquals(terminalChoiceCapability({ terminal: "tmux" }).canSpawn, true);
  const herdr = terminalChoiceCapability({ terminal: "herdr" });
  assertEquals(herdr.canSpawn, false);
  assertStringIncludes(herdr.canSpawn ? "" : herdr.reason, "not available yet");
  assertStringIncludes(herdr.canSpawn ? "" : herdr.fix, "Config → General");
  const unknown = terminalChoiceCapability({ terminal: "screen" as never });
  assertStringIncludes(unknown.canSpawn ? "" : unknown.reason, '"screen"');
});

test("getTerminalBackend follows the config; herdr is a backend that is never available", () => {
  assertEquals(getTerminalBackend({}).kind, "tmux");
  const herdr = getTerminalBackend({ terminal: "herdr" });
  assertEquals(herdr.kind, "herdr");
  assertEquals(herdr.available(), false);
  assertEquals(herdr.unavailableReason(), "not-implemented");
  assertStringIncludes(herdr.unavailable()?.reason ?? "", "not available yet");
  assertEquals(herdr.identity(), null);
  // Window operations refuse with the same message rather than touching anything.
  let thrown = "";
  try { herdr.listWindows("team"); } catch (e) { thrown = (e as Error).message; }
  assertStringIncludes(thrown, "not available yet");
});

test("PUT /api/config validates, saves and clears terminal", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    const current = await (await get(app, "/api/config")).json();
    assertEquals(current.terminal, undefined); // unset = tmux, and stays unset on disk

    const bad = await put(app, "/api/config", { ...current, terminal: "screen" });
    assertEquals(bad.status, 400);
    assertStringIncludes((await bad.json()).error, "terminal must be one of: tmux, herdr");
    assertEquals(store.getConfig().terminal, undefined, "a refused save changes nothing");

    assertEquals((await put(app, "/api/config", { ...current, terminal: "herdr" })).status, 200);
    assertEquals(store.getConfig().terminal, "herdr");
    const onDisk = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
    assertEquals(onDisk.terminal, "herdr");

    // Live: spawning and the assistant start now say herdr isn't available yet.
    const spawning = store.getSpawnCapability();
    assertStringIncludes(spawning.canSpawn ? "" : spawning.reason, "herdr terminal backend is not available yet");
    const health = await (await get(app, "/health")).json();
    assertEquals(health.terminal, "herdr");
    assertEquals(health.spawning.canSpawn, false);
    assertEquals(health.assistantStartable.ok, false);

    // Absent keeps it; null clears it back to the default.
    assertEquals((await put(app, "/api/config", { ...current })).status, 200);
    assertEquals(store.getConfig().terminal, "herdr");
    assertEquals((await put(app, "/api/config", { ...current, terminal: null })).status, 200);
    assertEquals(store.getConfig().terminal, undefined);
    assertEquals(store.getSpawnCapability().canSpawn, true);
    assertEquals("terminal" in JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")), false);
  });
});

test("config.json writes terminal after tmuxSession, and omits it when unset", () => {
  const keys = Object.keys(serializeTeamConfig({ ...config(), terminal: "herdr" }));
  assertEquals(keys.indexOf("terminal"), keys.indexOf("tmuxSession") + 1);
  assertEquals("terminal" in serializeTeamConfig(config()), false);
});

test("selecting herdr refuses spawns with the reason, and opens nothing in tmux", () => {
  const { store, updates } = fakeStore([{ id: "s1", action: "spawn", params: { name: "neo", cwd: process.cwd() } }]);
  const tmux = fakeTmux();
  realizePending(store, { config: config({ terminal: "herdr" }), daemonUrl: "http://x", fallbackCwd: process.cwd(), exec: tmux.exec });
  assertEquals(updates[0]?.status, "failed");
  assertStringIncludes(updates[0]?.error ?? "", "could not spawn: the herdr terminal backend is not available yet");
  assertEquals(tmux.calls, []);
});

test("selecting herdr refuses the assistant start with a terminal-unavailable code", () => {
  const cfg = config({ terminal: "herdr" });
  const startable = assistantStartability(cfg);
  assertEquals(startable.ok, false);
  const tmux = fakeTmux();
  const result = startLeader({ config: cfg, teamDir: "/tmp/x/.my-pizza-team", daemonUrl: "http://x", exec: tmux.exec });
  assertEquals(result.status === "error" && result.code, "terminal-unavailable");
  assertEquals(tmux.calls, []);
});

// ─── Metadata ────────────────────────────────────────────────────────

test("memberTerminal prefers the neutral keys and falls back to tmuxSession/tmuxWindow (= tmux)", () => {
  const cfg = config({ terminal: "herdr" });
  // Neutral keys win over legacy ones.
  assertEquals(
    memberTerminal({ name: "neo", metadata: {
      terminal: "tmux", terminalSession: "s", terminalWindow: "w", terminalHandle: "@3", tmuxSession: "old", tmuxWindow: "old",
    } }, cfg),
    { terminal: "tmux", session: "s", window: "w", handle: "@3" },
  );
  // Only the pre-herdr keys: an agent started before `terminal` existed was in tmux,
  // whatever the config says now.
  assertEquals(memberTerminal({ name: "neo", metadata: { tmuxSession: "s", tmuxWindow: "w" } }, cfg),
    { terminal: "tmux", session: "s", window: "w" });
  // Nothing reported: the name in the configured container and terminal.
  assertEquals(memberTerminal({ name: "neo", metadata: {} }, cfg), { terminal: "herdr", session: "team", window: "neo" });
  // A terminal mpt doesn't know is ignored, not trusted.
  assertEquals(memberTerminal({ name: "neo", metadata: { terminal: "screen", terminalWindow: "w" } }, config()).terminal, "tmux");
});

test("terminalMetadata: neutral flags win, the older --*tmux-* ones fill in, empties are dropped", () => {
  assertEquals(terminalMetadata({}), {});
  assertEquals(terminalMetadata({ terminal: "", session: "", legacySession: " s ", legacyWindow: "w" }),
    { terminalSession: "s", terminalWindow: "w" });
  assertEquals(terminalMetadata({ terminal: "herdr", session: "a", window: "b", handle: "w1:p2", legacySession: "x", legacyWindow: "y" }),
    { terminal: "herdr", terminalSession: "a", terminalWindow: "b", terminalHandle: "w1:p2" });
});

test("a registered agent's neutral metadata reaches its dismiss directive", async () => {
  await withTeam({ tmuxSession: "team" }, async ({ app, store }) => {
    await post(app, "/api/agents/register", {
      id: "a1", name: "neo", metadata: { terminal: "tmux", terminalSession: "team", terminalWindow: "neo" },
    });
    await app.request("/api/agents/a1?dismiss=true", { method: "DELETE" });
    const d = store.getLeaderDirectives().find((x) => x.action === "dismiss");
    assertEquals(d?.params.terminal, "tmux");
    assertEquals(d?.params.terminalSession, "team");
    assertEquals(d?.params.name, "neo");
  });
});

// ─── Dismiss and focus use the recorded backend ──────────────────────

test("dismiss closes a tmux window after the team switched to herdr", () => {
  // Started under tmux; the team now says herdr. The window must still close in tmux.
  const member = { id: "a1", name: "neo", metadata: { terminal: "tmux", terminalSession: "team", terminalWindow: "neo" } };
  const cfg = config({ terminal: "herdr" });
  const params = dismissParams(member, cfg, 0)!;
  assertEquals(params.terminal, "tmux");

  const { store, updates } = fakeStore([{ id: "d1", action: "dismiss", params: { ...params, deadline: 0 }, metadata: member.metadata }]);
  const tmux = fakeTmux(["neo"]);
  let t = 10_000;
  const deps = { config: cfg, daemonUrl: "http://x", fallbackCwd: process.cwd(), exec: tmux.exec, now: () => t, interrupts: new Map() };
  realizePending(store, deps); // C-c
  t += 5_000;
  realizePending(store, deps); // kill
  assertEquals(tmux.calls.find((c) => c[0] === "kill-window"), ["kill-window", "-t", "team:neo"]);
  assertEquals(updates, [{ id: "d1", status: "done", error: undefined }]);
});

test("dismiss of a window recorded under herdr goes to herdr (refused for now), never to tmux", () => {
  const member = { id: "a1", name: "neo", metadata: { terminal: "herdr", terminalSession: "team", terminalWindow: "neo" } };
  const params = dismissParams(member, config(), 0)!; // config is tmux
  assertEquals(params.terminal, "herdr");
  const { store, updates } = fakeStore([{ id: "d1", action: "dismiss", params, metadata: member.metadata }]);
  const tmux = fakeTmux(["neo"]);
  realizePending(store, { config: config(), daemonUrl: "http://x", fallbackCwd: process.cwd(), exec: tmux.exec });
  assertEquals(updates[0]?.status, "failed");
  assertStringIncludes(updates[0]?.error ?? "", "the agent still exits");
  assertStringIncludes(updates[0]?.error ?? "", "herdr terminal backend is not available yet");
  assertEquals(tmux.calls, [], "the tmux window of the same name is left alone");
});

test("dismissTerminal reads the directive's params, then the pre-herdr shape, then metadata", () => {
  const cfg = config({ terminal: "herdr" });
  assertEquals(dismissTerminal({ params: { terminal: "tmux" } }, cfg), "tmux");
  assertEquals(dismissTerminal({ params: { name: "neo", tmuxSession: "team" } }, cfg), "tmux"); // queued by an older daemon
  assertEquals(dismissTerminal({ params: { name: "neo" }, metadata: { tmuxWindow: "neo" } }, cfg), "tmux");
  assertEquals(dismissTerminal({ params: { name: "neo" } }, cfg), "herdr"); // names neither: the configured one
});

test("focus goes to the backend the agent was started under", () => {
  const tmux = fakeTmux();
  const cfg = config({ terminal: "herdr" });
  assertEquals(focusMember({ name: "neo", metadata: { terminal: "tmux", terminalSession: "team", terminalWindow: "neo" } }, cfg, tmux.exec), null);
  assertEquals(tmux.calls, [["select-window", "-t", "team:neo"]]);
  const refused = focusMember({ name: "neo", metadata: { terminal: "herdr", terminalWindow: "neo" } }, config(), tmux.exec);
  assertStringIncludes(refused ?? "", "not available yet");
  assertEquals(tmux.calls.length, 1, "nothing sent to tmux for a herdr window");
});

// ─── The "switch applies to new windows only" warning ────────────────

test("agentsOnOtherTerminal lists online agents started under another terminal", async () => {
  const members = [
    { name: "leader", status: "idle", metadata: { tmuxWindow: "leader" } },
    { name: "neo", status: "working", metadata: { terminal: "tmux", terminalWindow: "neo" } },
    { name: "gone", status: "offline", metadata: { terminal: "tmux" } },
  ];
  assertEquals(agentsOnOtherTerminal(members, config()), []);
  assertEquals(agentsOnOtherTerminal(members, config({ terminal: "herdr" })),
    [{ name: "leader", terminal: "tmux" }, { name: "neo", terminal: "tmux" }]);

  await withTeam({}, async ({ app, store }) => {
    await post(app, "/api/agents/register", { id: "a1", name: "neo", metadata: { terminal: "tmux", terminalWindow: "neo" } });
    store.getConfig().terminal = "herdr";
    assertEquals((await (await get(app, "/api/config")).json()).agentsOnOtherTerminal, [{ name: "neo", terminal: "tmux" }]);
    assertEquals((await (await get(app, "/health")).json()).agentsOnOtherTerminal, [{ name: "neo", terminal: "tmux" }]);
  });
});

test("createTerminalBackend builds the backend for a recorded kind", () => {
  assertEquals(createTerminalBackend("tmux").kind, "tmux");
  assertEquals(createTerminalBackend("herdr").kind, "herdr");
});
