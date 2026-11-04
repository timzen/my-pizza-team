/**
 * tests/dismiss-window.test.ts — a UI dismiss closes the teammate's tmux window.
 *
 * Spawn types the harness command into the window's shell, so a dismissed harness
 * exiting by itself leaves a shell prompt behind. `DELETE /api/agents/:id?dismiss=true`
 * therefore queues a `dismiss` directive that the spawner realizes once the agent has
 * gone (daemon/spawner.ts realizeDismiss). These drive the real route and store with a
 * fake tmux, end to end, and pin the exits that must *keep* their window.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, JSON_HEADERS } from "./_team.ts";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { realizePending, type SpawnerStore } from "../daemon/spawner.ts";
import type { ExecResult, TmuxExec } from "../daemon/terminal/tmux.ts";

/** A fake tmux server holding `windows` in every session; kill-window removes one. */
function fakeTmux(windows: string[]) {
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

function register(app: ReturnType<typeof buildApp>, id: string, name: string, metadata: Record<string, unknown> = {}) {
  return app.request("/api/agents/register", {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id, name, metadata }),
  });
}

async function heartbeat(app: ReturnType<typeof buildApp>, id: string) {
  const res = await app.request("/api/agents/heartbeat", {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id, status: "idle" }),
  });
  return await res.json();
}

/** Run daemon realize passes 2s apart (as start.ts does), on a fake clock. */
function passes(store: SpawnerStore, exec: TmuxExec, n: number, start = Date.now()) {
  const interrupts = new Map<string, number>();
  let t = start;
  for (let i = 0; i < n; i++) {
    realizePending(store, {
      config: { ...TEST_CONFIG, tmuxSession: "team" }, daemonUrl: "http://x", fallbackCwd: process.cwd(),
      exec, now: () => t, interrupts,
    });
    t += 2_000;
  }
}

const dismissDirectives = (store: Store) => store.getLeaderDirectives().filter((d) => d.action === "dismiss");

test("UI dismiss of an `mpt agent` teammate closes its window once it deregisters", async () => {
  await withTeam({ tmuxSession: "team" }, async ({ app, store }) => {
    await register(app, "a1", "swift-ripley", { tmuxSession: "team", tmuxWindow: "swift-ripley" });
    const tmux = fakeTmux(["leader", "swift-ripley"]);

    await app.request("/api/agents/a1?dismiss=true", { method: "DELETE" });
    const [d] = dismissDirectives(store);
    assertEquals(d?.params.name, "swift-ripley");
    assertEquals(d?.params.tmuxSession, "team");

    // Still running: nothing happens to its window.
    passes(store, tmux.exec, 2);
    assertEquals(tmux.live.has("swift-ripley"), true);
    assertEquals(tmux.calls.some((c) => c[0] === "send-keys"), false);

    // The supervisor hears `dismissed`, stops, and deregisters (a plain DELETE).
    assertEquals((await heartbeat(app, "a1")).dismissed, true);
    const dereg = await app.request("/api/agents/a1", { method: "DELETE" });
    assertEquals(dereg.status, 200);

    passes(store, tmux.exec, 2); // C-c, then kill
    assertEquals(tmux.live.has("swift-ripley"), false);
    assertEquals(tmux.live.has("leader"), true);
    assertEquals(dismissDirectives(store), []);
  });
});

test("UI dismiss of a Pi teammate closes its window soon after it hears `dismissed`", async () => {
  await withTeam({ tmuxSession: "team" }, async ({ app, store }) => {
    // No metadata: falls back to its name and the configured session.
    await register(app, "p1", "brave-hicks");
    const tmux = fakeTmux(["brave-hicks"]);
    await app.request("/api/agents/p1?dismiss=true", { method: "DELETE" });
    assertEquals(store.dismissedAgentExited("p1"), false);

    // A Pi teammate exits ~0.5s after hearing it, without deregistering.
    assertEquals((await heartbeat(app, "p1")).dismissed, true);
    assertEquals(store.dismissedAgentExited("p1", 0), true);
    // (with the real exit grace, a moment later — modelled by a zero grace here)
    const exitedNow: SpawnerStore = {
      getLeaderDirectives: () => store.getLeaderDirectives(),
      updateLeaderDirective: (id, s, e) => store.updateLeaderDirective(id, s, e),
      getMembers: () => store.getMembers(),
      dismissedAgentExited: (id) => store.dismissedAgentExited(id, 0),
    };
    passes(exitedNow, tmux.exec, 2);
    assertEquals(tmux.calls.find((c) => c[0] === "kill-window"), ["kill-window", "-t", "team:brave-hicks"]);
  });
});

test("dismissing an already-offline teammate closes its window without waiting", async () => {
  await withTeam({ tmuxSession: "team" }, async ({ app, store }) => {
    await register(app, "a1", "swift-ripley");
    store.updateMemberStatus("a1", "offline");
    await app.request("/api/agents/a1?dismiss=true", { method: "DELETE" });
    assertEquals(store.dismissedAgentExited("a1"), true);
    const tmux = fakeTmux(["swift-ripley"]);
    passes(store, tmux.exec, 2);
    assertEquals(tmux.live.has("swift-ripley"), false);
  });
});

test("a plain self-deregister keeps its window (a quit or crash stays visible)", async () => {
  await withTeam({ tmuxSession: "team" }, async ({ app, store }) => {
    await register(app, "a1", "swift-ripley");
    await app.request("/api/agents/a1", { method: "DELETE" });
    assertEquals(dismissDirectives(store), []);

    // …and so does one that just stops heartbeating (reaped).
    await register(app, "a2", "brave-hicks");
    store.updateMemberStatus("a2", "offline");
    assertEquals(dismissDirectives(store), []);

    const tmux = fakeTmux(["swift-ripley", "brave-hicks"]);
    passes(store, tmux.exec, 5);
    assertEquals(tmux.calls.filter((c) => c[0] === "send-keys" || c[0] === "kill-window"), []);
  });
});

test("dismissing the leader never queues a window close", async () => {
  await withTeam({ tmuxSession: "team" }, async ({ app, store }) => {
    await register(app, "l1", "leader", { tmuxSession: "team", tmuxWindow: "leader" });
    await app.request("/api/agents/l1?dismiss=true", { method: "DELETE" });
    assertEquals(dismissDirectives(store), []);
  });
});

test("the leader is never handed a dismiss — the daemon realizes it, or fails it", async () => {
  await withTeam({ tmuxSession: "team" }, async ({ app, store }) => {
    await register(app, "a1", "swift-ripley");
    await app.request("/api/agents/a1?dismiss=true", { method: "DELETE" });
    const forLeader = async () =>
      ((await (await app.request("/api/leader/directives")).json()).directives as Array<{ action: string }>)
        .filter((d) => d.action === "dismiss" || d.action === "spawn");

    assertEquals(await forLeader(), [], "the daemon's to realize");
    store.setTmuxCapability({ canSpawn: false, reason: "no tmux", fix: "install tmux" });
    await heartbeat(app, "a1");
    await app.request("/api/agents/a1", { method: "DELETE" }); // deregisters on its way out
    assertEquals(await forLeader(), [], "even with tmux unreachable, there is no leader fallback");
  });
});

test("with tmux unreachable, a dismiss's window close fails with the reason — the agent still exits", async () => {
  await withTeam({ tmuxSession: "team" }, async ({ app, store }) => {
    await register(app, "a1", "swift-ripley");
    await app.request("/api/agents/a1?dismiss=true", { method: "DELETE" });
    const { exec, calls } = fakeTmux(["swift-ripley"]);
    const { failed } = realizePending(store, {
      config: { ...TEST_CONFIG, tmuxSession: "team" }, daemonUrl: "http://x", fallbackCwd: process.cwd(),
      exec, interrupts: new Map(), tmux: { canSpawn: false, reason: "tmux is not on this process's PATH", fix: "install tmux" },
    });
    assertEquals(failed.length, 1);
    assertEquals(failed[0]!.error.includes("tmux is not on this process's PATH — fix: install tmux"), true);
    assertEquals(calls, [], "tmux is never called");
    assertEquals(dismissDirectives(store), []);
    // The tombstone is what stops the agent; it doesn't need tmux.
    assertEquals((await heartbeat(app, "a1")).dismissed, true);
  });
});