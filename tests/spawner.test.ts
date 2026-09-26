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
 *      the silent class docs/BATTERIES_INCLUDED.md §1.1 is about.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import type { ExecResult, TmuxExec } from "../daemon/tmux.ts";
import {
  probeSpawnCapability,
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
function fakeStore(directives: SpawnableDirective[], members: Array<{ name: string; status: string }> = []) {
  const updates: Array<{ id: string; status: string; error?: string }> = [];
  const store: SpawnerStore = {
    getLeaderDirectives: () => directives,
    updateLeaderDirective: (id, status, error) => {
      updates.push({ id, status, error });
      return true;
    },
    getMembers: () => members,
  };
  return { store, updates };
}

const spawn = (over: Partial<SpawnableDirective> = {}): SpawnableDirective => ({
  id: "dir-1",
  action: "spawn",
  params: { name: "swift-ripley", cwd: Deno.cwd() },
  ...over,
});

const config = (over: Partial<TeamConfig> = {}): TeamConfig => ({ ...DEFAULT_CONFIG, tmuxSession: "mpt", ...over });

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
  const cap = probeSpawnCapability(config({ defaultHarness: "kiro", harnesses: {} }), exec);
  assertEquals(cap.canSpawn, false);
  if (!cap.canSpawn) assertStringIncludes(cap.fix, "harnesses.kiro.teammate");
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
  // each harness's commands, which is the coupling §3.1 removes.
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

Deno.test("a dismiss interrupts the agent before killing its window", () => {
  // Killing outright would cut off a final flush.
  const { store } = fakeStore([{
    id: "d",
    action: "dismiss",
    params: { name: "swift-ripley" },
    metadata: { tmuxSession: "mpt", tmuxWindow: "swift-ripley" },
  }]);
  const { exec, calls } = fakeTmux((args) =>
    args[0] === "list-windows" ? { ok: true, stdout: "swift-ripley\n" } : {}
  );
  realizePending(store, deps({ exec }));
  const order = calls.map((c) => `${c[0]}${c[3] ? ` ${c[3]}` : ""}`);
  assertEquals(order.includes("send-keys C-c"), true);
  assertEquals(calls.some((c) => c[0] === "kill-window"), true);
  assertEquals(order.indexOf("send-keys C-c") < calls.findIndex((c) => c[0] === "kill-window"), true);
});

Deno.test("dismissing an already-gone window succeeds quietly", () => {
  const { store, updates } = fakeStore([{ id: "d", action: "dismiss", params: { name: "gone" } }]);
  const { exec, calls } = fakeTmux((args) => (args[0] === "list-windows" ? { ok: true, stdout: "other\n" } : {}));
  const result = realizePending(store, deps({ exec }));
  assertEquals(result.failed, []);
  assertEquals(updates[0]!.status, "done");
  assertEquals(calls.some((c) => c[0] === "kill-window"), false);
});
