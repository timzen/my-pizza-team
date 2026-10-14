/**
 * tests/spawner.test.ts — the daemon realizing spawns (P3-1, part 2).
 *
 * This moves responsibility: until now the *leader* turned a `spawn` directive into a
 * tmux window. Two things therefore matter more than the happy path.
 *
 *   1. **The fallback must be real.** The daemon can only drive tmux if it can reach
 *      it, and under launchd/systemd it may have no `tmux` on PATH. When it can't,
 *      directives must stay pending for the leader — not fail, and not vanish.
 *   2. **A failure needs somewhere visible to live.** The leader used to report one;
 *      an unreported failure now looks exactly like a team that never grew, which is
 *      the silent class docs/DESIGN.md "Setup Is One Command" is about.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { TEST_CONFIG } from "./_config.ts";
import { LEADER_WINDOW, type TeamConfig } from "../shared/types.ts";
import type { ExecResult, TmuxExec } from "../daemon/tmux.ts";
import {
  DISMISS_KILL_DELAY_MS,
  DISMISS_WAIT_MS,
  dismissParams,
  harnessCapability,
  probeSpawnCapability,
  probeTmuxCapability,
  realizePending,
  type SpawnableDirective,
  type SpawnerStore,
} from "../daemon/spawner.ts";

function fakeTmux(handler?: (args: string[]) => Partial<ExecResult>): { exec: TmuxExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: TmuxExec = (args) => {
    calls.push(args);
    const out = handler?.(args) ?? {};
    return { ok: out.ok ?? true, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  };
  return { exec, calls };
}

/** A store stub recording status transitions. */
function fakeStore(
  directives: SpawnableDirective[],
  members: Array<{ name: string; status: string }> = [],
  exited: Set<string> = new Set(),
) {
  const updates: Array<{ id: string; status: string; error?: string }> = [];
  const store: SpawnerStore = {
    getLeaderDirectives: () => directives,
    updateLeaderDirective: (id, status, error) => {
      updates.push({ id, status, error });
      return true;
    },
    getMembers: () => members,
    dismissedAgentExited: (id) => exited.has(id),
  };
  return { store, updates };
}

const spawn = (over: Partial<SpawnableDirective> = {}): SpawnableDirective => ({
  id: "dir-1",
  action: "spawn",
  params: { name: "swift-ripley", cwd: Deno.cwd() },
  ...over,
});

const config = (over: Partial<TeamConfig> = {}): TeamConfig => ({ ...TEST_CONFIG, tmuxSession: "mpt", ...over });

const deps = (over: Partial<Parameters<typeof realizePending>[1]> = {}) => ({
  config: config(),
  daemonUrl: "http://localhost:7437",
  fallbackCwd: Deno.cwd(),
  ...over,
});

// ─── Capability probe ────────────────────────────────────────────────

Deno.test("no tmux on PATH means leader-driven spawning, with the fix named", () => {
  const { exec } = fakeTmux(() => ({ ok: false, stderr: "command not found" }));
  const cap = probeSpawnCapability(config(), exec);
  assertEquals(cap.canSpawn, false);
  if (!cap.canSpawn) {
    assertStringIncludes(cap.reason, "PATH");
    assertStringIncludes(cap.fix, "leader will spawn");
  }
});

Deno.test("a permission error is distinguished from tmux being absent", () => {
  // Different causes, different fixes — and they look identical unless separated.
  const { exec } = fakeTmux(() => ({ ok: false, stderr: "Requires run access to tmux, --allow-run" }));
  const cap = probeSpawnCapability(config(), exec);
  assertEquals(cap.canSpawn, false);
  if (!cap.canSpawn) assertStringIncludes(cap.reason, "not permitted");
});

Deno.test("tmux present but no teammate template configured is refused up front", () => {
  const { exec } = fakeTmux();
  const cap = probeSpawnCapability(config({ defaultHarness: "acme", harnesses: {}, experimental: { harnesses: true } }), exec);
  assertEquals(cap.canSpawn, false);
  if (!cap.canSpawn) assertStringIncludes(cap.fix, "harnesses.acme.teammate");
});

Deno.test("an experimental default harness without the opt-in is refused up front, with the fix", () => {
  const cap = probeSpawnCapability(config({ defaultHarness: "kiro" }), fakeTmux().exec);
  assertEquals(cap.canSpawn, false);
  if (!cap.canSpawn) assertStringIncludes(cap.fix, "experimental");
  assertEquals(probeSpawnCapability(config({ defaultHarness: "kiro", experimental: { harnesses: true } }), fakeTmux().exec).canSpawn, true);
});

Deno.test("tmux present and a template configured can spawn", () => {
  assertEquals(probeSpawnCapability(config(), fakeTmux().exec).canSpawn, true);
});

// ─── Realization ─────────────────────────────────────────────────────

Deno.test("a spawn becomes a tmux window running the harness command", () => {
  const { store, updates } = fakeStore([spawn()]);
  const { exec, calls } = fakeTmux((args) => (args[0] === "has-session" ? { ok: true } : {}));

  const result = realizePending(store, deps({ exec }));
  assertEquals(result.realized, ["dir-1"]);
  assertEquals(result.failed, []);
  assertEquals(updates, [{ id: "dir-1", status: "done", error: undefined }]);

  const typed = calls.find((c) => c[0] === "send-keys")![3]!;
  assertStringIncludes(typed, "--ppt-name=swift-ripley");
  assertStringIncludes(typed, "--ppt-daemon=http://localhost:7437");
  assertStringIncludes(typed, "--ppt-tmux-window=swift-ripley");
});

Deno.test("reset-session is left for the leader, not taken over", () => {
  // It types `/new` — a Pi slash command. Doing it here would mean the daemon knowing
  // each harness's commands, which is the coupling DESIGN.md "The Daemon Is the Supervisor" removes.
  const { store, updates } = fakeStore([{ id: "d", action: "reset-session", memberId: "a1", params: {} }]);
  const { exec, calls } = fakeTmux();
  const result = realizePending(store, deps({ exec }));
  assertEquals(result.realized, []);
  assertEquals(updates, [], "must stay pending for the leader");
  assertEquals(calls, []);
});

Deno.test("an unknown action is left alone rather than guessed at", () => {
  const { store, updates } = fakeStore([{ id: "d", action: "some-future-action", params: {} }]);
  const result = realizePending(store, deps({ exec: fakeTmux().exec }));
  assertEquals(result.realized, []);
  assertEquals(updates, []);
});

Deno.test("a spawn for a name already online is a no-op, not a second window", () => {
  // Guards a retry arriving after the agent registered.
  const { store, updates } = fakeStore([spawn()], [{ name: "swift-ripley", status: "idle" }]);
  const { exec, calls } = fakeTmux();
  const result = realizePending(store, deps({ exec }));
  assertEquals(result.realized, ["dir-1"]);
  assertEquals(updates[0]!.status, "done");
  assertEquals(calls.some((c) => c[0] === "new-window"), false);
});

Deno.test("an offline member of the same name does not block a replacement", () => {
  // Replacing a reaped teammate is the pool's whole job.
  const { store } = fakeStore([spawn()], [{ name: "swift-ripley", status: "offline" }]);
  const { exec, calls } = fakeTmux((args) => (args[0] === "has-session" ? { ok: true } : {}));
  realizePending(store, deps({ exec }));
  assertEquals(calls.some((c) => c[0] === "send-keys"), true);
});

Deno.test("the directive's cwd wins, and a missing one falls back", () => {
  const explicit = fakeStore([spawn({ params: { name: "a", cwd: Deno.cwd() } })]);
  const e1 = fakeTmux((args) => (args[0] === "has-session" ? { ok: true } : {}));
  realizePending(explicit.store, deps({ exec: e1.exec, fallbackCwd: "/nonexistent" }));
  assertStringIncludes(e1.calls.find((c) => c[0] === "send-keys")![3]!, Deno.cwd());

  const implicit = fakeStore([spawn({ params: { name: "a" } })]);
  const e2 = fakeTmux((args) => (args[0] === "has-session" ? { ok: true } : {}));
  realizePending(implicit.store, deps({ exec: e2.exec, fallbackCwd: Deno.cwd() }));
  assertStringIncludes(e2.calls.find((c) => c[0] === "send-keys")![3]!, Deno.cwd());
});

// ─── Failures are visible ────────────────────────────────────────────

Deno.test("a cwd that isn't a directory fails the directive with the reason", () => {
  // Otherwise the agent starts in the shell's default directory and works on the
  // wrong thing, looking healthy the whole time.
  const { store, updates } = fakeStore([spawn({ params: { name: "a", cwd: "/definitely/not/here" } })]);
  const result = realizePending(store, deps({ exec: fakeTmux().exec }));
  assertEquals(result.failed.length, 1);
  assertStringIncludes(result.failed[0]!.error, "not a directory");
  assertEquals(updates[0]!.status, "failed");
  assertStringIncludes(updates[0]!.error!, "/definitely/not/here");
});

Deno.test("a spawn with no name fails rather than creating an unnamed window", () => {
  const { store, updates } = fakeStore([spawn({ params: { cwd: Deno.cwd() } })]);
  const result = realizePending(store, deps({ exec: fakeTmux().exec }));
  assertEquals(result.failed.length, 1);
  assertStringIncludes(updates[0]!.error!, "no name");
});

Deno.test("an unconfigured harness fails the directive, naming it", () => {
  const { store, updates } = fakeStore([spawn({ params: { name: "a", cwd: Deno.cwd(), harness: "codex" } })]);
  const result = realizePending(store, deps({ exec: fakeTmux().exec }));
  assertEquals(result.failed.length, 1);
  assertStringIncludes(updates[0]!.error!, "codex");
});

Deno.test("a tmux failure fails the directive instead of retrying forever", () => {
  // Left pending, it would be retried every 2s, spawning nothing and saying nothing.
  const { store, updates } = fakeStore([spawn()]);
  const { exec } = fakeTmux((args) => {
    if (args[0] === "has-session") return { ok: true };
    if (args[0] === "new-window") return { ok: false, stderr: "no space left on device" };
    return {};
  });
  const result = realizePending(store, deps({ exec }));
  assertEquals(result.failed.length, 1);
  assertEquals(updates[0]!.status, "failed");
  assertStringIncludes(updates[0]!.error!, "no space left");
});

Deno.test("one failing directive does not stop the others", () => {
  const { store, updates } = fakeStore([
    spawn({ id: "bad", params: { name: "a", cwd: "/definitely/not/here" } }),
    spawn({ id: "good", params: { name: "b", cwd: Deno.cwd() } }),
  ]);
  const { exec } = fakeTmux((args) => (args[0] === "has-session" ? { ok: true } : {}));
  const result = realizePending(store, deps({ exec }));
  assertEquals(result.realized, ["good"]);
  assertEquals(result.failed.map((f) => f.id), ["bad"]);
  assertEquals(updates.length, 2);
});

// ─── Dismiss ─────────────────────────────────────────────────────────

Deno.test("a dismiss interrupts the agent, and kills its window only on a later pass", () => {
  // Killing on the same pass as the C-c would cut off a final flush.
  const { store, updates } = fakeStore([{
    id: "d",
    action: "dismiss",
    params: { name: "swift-ripley" },
    metadata: { tmuxSession: "mpt", tmuxWindow: "swift-ripley" },
  }]);
  const { exec, calls } = fakeTmux((args) =>
    args[0] === "list-windows" ? { ok: true, stdout: "swift-ripley\n" } : {}
  );
  let t = 1_000_000;
  const d = deps({ exec, now: () => t, interrupts: new Map() });

  realizePending(store, d);
  assertEquals(calls.some((c) => c[0] === "send-keys" && c[3] === "C-c"), true);
  assertEquals(calls.some((c) => c[0] === "kill-window"), false, "no kill on the C-c pass");
  assertEquals(updates, [], "still pending until the window is gone");

  // A pass too soon after the C-c still doesn't kill.
  t += 500;
  realizePending(store, d);
  assertEquals(calls.some((c) => c[0] === "kill-window"), false);

  t += DISMISS_KILL_DELAY_MS;
  realizePending(store, d);
  const kill = calls.find((c) => c[0] === "kill-window");
  assertEquals(kill, ["kill-window", "-t", "mpt:swift-ripley"]);
  assertEquals(calls.filter((c) => c[3] === "C-c").length, 1, "interrupted once");
  assertEquals(updates, [{ id: "d", status: "done", error: undefined }]);
});

Deno.test("a UI dismiss waits for its agent to exit, then closes the window", () => {
  const exited = new Set<string>();
  const { store, updates } = fakeStore([{
    id: "d",
    action: "dismiss",
    params: { memberId: "a1", name: "swift-ripley", tmuxSession: "team", deadline: 1_000_000 + DISMISS_WAIT_MS },
  }], [], exited);
  const { exec, calls } = fakeTmux((args) =>
    args[0] === "list-windows" ? { ok: true, stdout: "leader\nswift-ripley\n" } : {}
  );
  let t = 1_000_000;
  const d = deps({ exec, now: () => t, interrupts: new Map() });

  // Still running: leave it to exit by itself.
  realizePending(store, d);
  assertEquals(calls.filter((c) => c[0] === "send-keys" || c[0] === "kill-window"), []);

  exited.add("a1");
  t += 2_000;
  realizePending(store, d); // C-c
  t += 2_000;
  realizePending(store, d); // kill
  assertEquals(calls.find((c) => c[0] === "send-keys"), ["send-keys", "-t", "team:swift-ripley", "C-c"]);
  assertEquals(calls.find((c) => c[0] === "kill-window"), ["kill-window", "-t", "team:swift-ripley"]);
  assertEquals(updates[0]!.status, "done");
});

Deno.test("a UI dismiss whose agent never exits is closed at the deadline", () => {
  const { store, updates } = fakeStore([{
    id: "d",
    action: "dismiss",
    params: { memberId: "a1", name: "swift-ripley", tmuxSession: "mpt", deadline: 1_000_000 + DISMISS_WAIT_MS },
  }]);
  const { exec, calls } = fakeTmux((args) =>
    args[0] === "list-windows" ? { ok: true, stdout: "swift-ripley\n" } : {}
  );
  let t = 1_000_000;
  const d = deps({ exec, now: () => t, interrupts: new Map() });
  // Daemon passes every 2s, as start.ts runs them.
  while (!updates.length && t < 1_000_000 + 60_000) {
    realizePending(store, d);
    t += 2_000;
  }
  assertEquals(calls.some((c) => c[0] === "kill-window"), true);
  assertEquals(t - 1_000_000 <= 30_000, true, `window gone within the grace period (took ${t - 1_000_000}ms)`);
});

Deno.test("the leader's window is never killed by a dismiss", () => {
  const { store, updates } = fakeStore([{ id: "d", action: "dismiss", params: { name: LEADER_WINDOW } }]);
  const { exec, calls } = fakeTmux((args) => (args[0] === "list-windows" ? { ok: true, stdout: "leader\n" } : {}));
  const d = deps({ exec, interrupts: new Map() });
  realizePending(store, d);
  realizePending(store, d);
  assertEquals(calls.some((c) => c[0] === "send-keys" || c[0] === "kill-window"), false);
  assertEquals(updates[0]!.status, "failed");
});

Deno.test("dismissParams falls back to the member's name and the configured session, and skips the leader", () => {
  const cfg = config({ tmuxSession: "team" });
  assertEquals(
    dismissParams({ id: "a1", name: "swift-ripley", metadata: {} }, cfg, 0),
    { memberId: "a1", name: "swift-ripley", tmuxSession: "team", deadline: DISMISS_WAIT_MS },
  );
  assertEquals(
    dismissParams({ id: "a1", name: "x", metadata: { tmuxSession: "s", tmuxWindow: "w" } }, cfg, 0)?.name,
    "w",
  );
  assertEquals(dismissParams({ id: "l", name: "leader", metadata: { tmuxWindow: LEADER_WINDOW } }, cfg), null);
});

Deno.test("a dismiss with tmux gone away doesn't throw", () => {
  // tmux unreachable mid-run: list-windows fails, which reads as "already gone".
  const { store, updates } = fakeStore([{ id: "d", action: "dismiss", params: { name: "swift-ripley" } }]);
  const { exec } = fakeTmux(() => ({ ok: false, stderr: "no server running" }));
  const result = realizePending(store, deps({ exec, interrupts: new Map() }));
  assertEquals(result.failed, []);
  assertEquals(updates[0]!.status, "done");
});

Deno.test("dismissing an already-gone window succeeds quietly", () => {
  const { store, updates } = fakeStore([{ id: "d", action: "dismiss", params: { name: "gone" } }]);
  const { exec, calls } = fakeTmux((args) => (args[0] === "list-windows" ? { ok: true, stdout: "other\n" } : {}));
  const result = realizePending(store, deps({ exec }));
  assertEquals(result.failed, []);
  assertEquals(updates[0]!.status, "done");
  assertEquals(calls.some((c) => c[0] === "kill-window"), false);
});

Deno.test("the harness check is separate from the tmux probe, so a fixed config needs no restart", () => {
  // start.ts probes tmux once and re-runs harnessCapability every spawn pass.
  assertEquals(probeTmuxCapability(fakeTmux().exec).canSpawn, true);
  const cfg = config({ defaultHarness: "kiro" });
  assertEquals(harnessCapability(cfg).canSpawn, false);
  cfg.experimental = { harnesses: true }; // what PUT /api/config does in place
  assertEquals(harnessCapability(cfg).canSpawn, true);
});
