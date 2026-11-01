/**
 * tests/teammate-pool.test.ts — The declared teammate pool (`minTeammates`).
 *
 * Team size is declared, not clicked: the daemon keeps at least `minTeammates`
 * generalist teammates online by queueing `spawn` directives for the shortfall.
 * Covers the default (half of maxTeammates when unset), the reconciler's
 * accounting (online + pending, role exclusions, the maxTeammates cap,
 * no-leader hold) and the GET/PUT /api/teammate-pool routes.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { makeTeam, withTeam, post, put } from "./_team.ts";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { resolveMinTeammates, type TeamConfig } from "../shared/types.ts";
import * as path from "node:path";

/** Register an online leader (only a leader can realize spawn directives). */
function registerLeader(app: ReturnType<typeof buildApp>, hostId = "h1") {
  return post(app, "/api/agents/register", { id: `leader-${hostId}`, name: "leader", hostId });
}

async function pendingSpawns(app: ReturnType<typeof buildApp>): Promise<unknown[]> {
  const body = await (await app.request("/api/spawn-requests")).json();
  return body.requests as unknown[];
}

test("unset: the default is half of maxTeammates (rounded down)", async () => {
  await withTeam({ minTeammates: undefined, maxTeammates: 4 }, async ({ app, store }) => {
    await registerLeader(app);
    const pool = store.getTeammatePool();
    assertEquals(pool.minTeammates, 2);
    assertEquals(pool.isDefault, true);
    assertEquals((await pendingSpawns(app)).length, 2);
  });
});

test("the default tracks maxTeammates and rounds down", () => {
  assertEquals(resolveMinTeammates({ maxTeammates: 5 }), 2);
  assertEquals(resolveMinTeammates({ maxTeammates: 1 }), 0);
  assertEquals(resolveMinTeammates({ maxTeammates: 0 }), 0);
  assertEquals(resolveMinTeammates({ maxTeammates: 6, minTeammates: 0 }), 0); // explicit 0 wins
  assertEquals(resolveMinTeammates({ maxTeammates: 2, minTeammates: 5 }), 2); // capped
});

test("the derived default is not written to config.json", () => {
  return withTeam({ minTeammates: undefined }, ({ store, teamDir }) => {
    store.saveConfig();
    const onDisk = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
    assertEquals("minTeammates" in onDisk, false);
  });
});

test("PUT null clears the declaration back to the default", async () => {
  await withTeam({ minTeammates: 0, maxTeammates: 4 }, async ({ app, store }) => {
    assertEquals(store.getTeammatePool().minTeammates, 0);
    const body = await (await put(app, "/api/teammate-pool", { minTeammates: null })).json();
    assertEquals(body.success, true);
    assertEquals(body.minTeammates, 2);
    assertEquals(body.isDefault, true);
  });
});

test("explicit zero: the daemon spawns nothing on its own", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, store }) => {
    await registerLeader(app);
    assertEquals(store.getTeammatePool().minTeammates, 0);
    assertEquals(store.getTeammatePool().isDefault, false);
    assertEquals(store.reconcileTeammatePool(), 0);
    assertEquals((await pendingSpawns(app)).length, 0);
  });
});

test("setting the minimum queues spawns for the shortfall", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app }) => {
    await registerLeader(app);
    const res = await put(app, "/api/teammate-pool", { minTeammates: 2 });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.minTeammates, 2);
    assertEquals(body.pending, 2);
    assertEquals((await pendingSpawns(app)).length, 2);
  });
});

test("pending spawns count toward the minimum (no duplicate batches)", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, store }) => {
    await registerLeader(app);
    store.setMinTeammates(2);
    // Nothing has been realized yet — reconciling again must not double up.
    assertEquals(store.reconcileTeammatePool(), 0);
    assertEquals((await pendingSpawns(app)).length, 2);
  });
});

test("online teammates count toward the minimum; the leader does not", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, store }) => {
    await registerLeader(app);
    await post(app, "/api/agents/register", { id: "t1", name: "swift-ripley" });
    await post(app, "/api/agents/register", { id: "t2", name: "calm-hopper" });

    const pool = store.getTeammatePool();
    assertEquals(pool.online, 2); // both teammates — the leader is a singleton, not pool

    store.setMinTeammates(3);
    // 2 online + 1 spawned = 3.
    assertEquals((await pendingSpawns(app)).length, 1);
  });
});

test("the target is capped by maxTeammates", async () => {
  await withTeam({ minTeammates: 0, maxTeammates: 2 }, async ({ app, store }) => {
    await registerLeader(app);
    assertEquals(store.setMinTeammates(5), 2); // clamped on the way in
    assertEquals((await pendingSpawns(app)).length, 2);
  });
});

test("no leader online: the pool waits — even when the daemon could spawn", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, store }) => {
    assertEquals(store.getTeammatePool().leaderPresent, false);
    // Deliberate: the team starts when its leader does (reconcileTeammatePool),
    // so a daemon launched at login doesn't open agent windows on its own.
    store.setSpawnCapability({ canSpawn: true });
    store.setMinTeammates(2);
    store.reconcileTeammatePool();
    assertEquals((await pendingSpawns(app)).length, 0);

    // A leader arriving fills the pool immediately (no waiting for the tick).
    await registerLeader(app);
    assertEquals((await pendingSpawns(app)).length, 2);
  });
});

test("a teammate that goes offline is replaced on the next reconcile", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, store }) => {
    await registerLeader(app);
    await post(app, "/api/agents/register", { id: "t1", name: "swift-ripley" });
    store.setMinTeammates(1);
    assertEquals((await pendingSpawns(app)).length, 0); // already satisfied

    // Dismissed (or reaped) — the pool is short again.
    await app.request("/api/agents/t1?dismiss=true", { method: "DELETE" });
    assertEquals(store.reconcileTeammatePool(), 1);
    assertEquals((await pendingSpawns(app)).length, 1);
  });
});

test("the minimum is persisted to config.json (applied at startup)", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, teamDir }) => {
    await registerLeader(app);
    await put(app, "/api/teammate-pool", { minTeammates: 3 });
    const onDisk = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
    assertEquals(onDisk.minTeammates, 3);
  });
});

test("PUT rejects non-integer / negative sizes", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, store }) => {
    assertEquals((await put(app, "/api/teammate-pool", { minTeammates: -1 })).status, 400);
    assertEquals((await put(app, "/api/teammate-pool", { minTeammates: 1.5 })).status, 400);
    assertEquals((await put(app, "/api/teammate-pool", {})).status, 400);
    assertEquals(store.getTeammatePool().minTeammates, 0);
  });
});

test("GET /api/teammate-pool reports the live pool", async () => {
  await withTeam({ minTeammates: 0, maxTeammates: 4 }, async ({ app, store }) => {
    await registerLeader(app);
    await post(app, "/api/agents/register", { id: "t1", name: "swift-ripley" });
    store.setMinTeammates(2);

    const body = await (await app.request("/api/teammate-pool")).json();
    assertEquals(body.minTeammates, 2);
    assertEquals(body.maxTeammates, 4);
    assertEquals(body.online, 1);
    assertEquals(body.pending, 1);
    assertEquals(body.leaderPresent, true);
  });
});

test("PUT /api/config also carries minTeammates (and keeps 0 meaningful)", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, config }) => {
    await registerLeader(app);
    const workflows = { default: { states: [{ name: "in_progress", type: "agent" }] } };
    const res = await put(app, "/api/config", { defaultWorkflow: "default", workflows, minTeammates: 2 });
    assertEquals(res.status, 200);
    assertEquals(config.minTeammates, 2);
    assertEquals((await pendingSpawns(app)).length, 2);

    // Back to zero: `0` must not be swallowed as "unset".
    await put(app, "/api/config", { defaultWorkflow: "default", workflows, minTeammates: 0 });
    assertEquals(config.minTeammates, 0);
  });
});

test("a pending spawn for the retired assistant role is cancelled at boot", async () => {
  // A database from before the leader became the chat agent can hold one. It must
  // not count toward the team size, be listed as pending, or be realized.
  const first = makeTeam({ minTeammates: 0 });
  first.store.createLeaderDirective("spawn", { params: { reason: "assistant", name: "assistant" } });
  first.store.createLeaderDirective("spawn", { params: { reason: "teammate" } });
  first.store.close();

  // Reopen the same team dir: boot cancels the assistant spawn.
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), minTeammates: 0 };
  const store = new Store(first.teamDir, config);
  const app = buildApp(store, config, first.teamDir);
  try {
    const pending = await pendingSpawns(app) as Array<{ name?: string }>;
    assertEquals(pending.length, 1, "only the teammate spawn is still pending");
    assertEquals(store.getTeammatePool().pending, 1);
  } finally {
    store.close();
    try { fs.rmSync(first.teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
