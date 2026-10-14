/**
 * tests/dismiss-window.test.ts — a UI dismiss closes the teammate's tmux window.
 *
 * Spawn types the harness command into the window's shell, so a dismissed harness
 * exiting by itself leaves a shell prompt behind. `DELETE /api/agents/:id?dismiss=true`
 * therefore queues a `dismiss` directive that the spawner realizes once the agent has
 * gone (daemon/spawner.ts realizeDismiss). These drive the real route and store with a
 * fake tmux, end to end, and pin the exits that must *keep* their window.
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { realizePending, type SpawnerStore } from "../daemon/spawner.ts";
import type { ExecResult, TmuxExec } from "../daemon/tmux.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-dismiss-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...TEST_CONFIG, tmuxSession: "team" };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir, config };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

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
      config: { ...TEST_CONFIG, tmuxSession: "team" }, daemonUrl: "http://x", fallbackCwd: Deno.cwd(),
      exec, now: () => t, interrupts,
    });
    t += 2_000;
  }
}

const dismissDirectives = (store: Store) => store.getLeaderDirectives().filter((d) => d.action === "dismiss");

Deno.test("UI dismiss of an `mpt agent` teammate closes its window once it deregisters", async () => {
  const { app, store, teamDir } = setup();
  try {
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
  } finally { cleanup(teamDir, store); }
});

Deno.test("UI dismiss of a Pi teammate closes its window soon after it hears `dismissed`", async () => {
  const { app, store, teamDir } = setup();
  try {
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
  } finally { cleanup(teamDir, store); }
});

Deno.test("dismissing an already-offline teammate closes its window without waiting", async () => {
  const { app, store, teamDir } = setup();
  try {
    await register(app, "a1", "swift-ripley");
    store.updateMemberStatus("a1", "offline");
    await app.request("/api/agents/a1?dismiss=true", { method: "DELETE" });
    assertEquals(store.dismissedAgentExited("a1"), true);
    const tmux = fakeTmux(["swift-ripley"]);
    passes(store, tmux.exec, 2);
    assertEquals(tmux.live.has("swift-ripley"), false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a plain self-deregister keeps its window (a quit or crash stays visible)", async () => {
  const { app, store, teamDir } = setup();
  try {
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
  } finally { cleanup(teamDir, store); }
});

Deno.test("dismissing the leader never queues a window close", async () => {
  const { app, store, teamDir } = setup();
  try {
    await register(app, "l1", "leader", { tmuxSession: "team", tmuxWindow: "leader" });
    await app.request("/api/agents/l1?dismiss=true", { method: "DELETE" });
    assertEquals(dismissDirectives(store), []);
  } finally { cleanup(teamDir, store); }
});

Deno.test("the leader sees a dismiss only when the daemon can't drive tmux, and only once it's ready", async () => {
  const { app, store, teamDir } = setup();
  try {
    await register(app, "a1", "swift-ripley");
    await app.request("/api/agents/a1?dismiss=true", { method: "DELETE" });
    const forLeader = async () =>
      ((await (await app.request("/api/leader/directives")).json()).directives as Array<{ action: string }>)
        .filter((d) => d.action === "dismiss");

    store.setSpawnCapability({ canSpawn: true });
    assertEquals(await forLeader(), [], "the daemon's to realize");

    store.setSpawnCapability({ canSpawn: false, reason: "no tmux" });
    assertEquals(await forLeader(), [], "held back while the agent is still running");

    await heartbeat(app, "a1");
    await app.request("/api/agents/a1", { method: "DELETE" }); // deregisters on its way out
    assertEquals((await forLeader()).length, 1);
  } finally { cleanup(teamDir, store); }
});
