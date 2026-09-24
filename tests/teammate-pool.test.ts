/**
 * tests/teammate-pool.test.ts — The declared teammate pool (`minTeammates`).
 *
 * Team size is declared, not clicked: the daemon keeps at least `minTeammates`
 * generalist teammates online by queueing `spawn` directives for the shortfall.
 * Covers the default (half of maxTeammates when unset), the reconciler's
 * accounting (online + pending, role exclusions, the maxTeammates cap,
 * no-leader hold) and the GET/PUT /api/teammate-pool routes.
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, resolveMinTeammates, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

/**
 * Fresh store + app with an isolated config (routes mutate it, so never share).
 * Pins `minTeammates: 0` unless overridden so each test starts from an empty
 * pool; the default-size tests pass `minTeammates: undefined` explicitly.
 */
function setup(overrides: Partial<TeamConfig> = {}) {
  overrides = { minTeammates: 0, ...overrides };
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-pool-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(DEFAULT_CONFIG), ...overrides };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir, config };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
}

function post(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function put(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** Register an online leader (only a leader can realize spawn directives). */
function registerLeader(app: ReturnType<typeof buildApp>, hostId = "h1") {
  return post(app, "/api/agents/register", { id: `leader-${hostId}`, name: "leader", hostId });
}

async function pendingSpawns(app: ReturnType<typeof buildApp>): Promise<unknown[]> {
  const body = await (await app.request("/api/spawn-requests")).json();
  return body.requests as unknown[];
}

Deno.test("unset: the default is half of maxTeammates (rounded down)", async () => {
  const { app, store, teamDir } = setup({ minTeammates: undefined, maxTeammates: 4 });
  try {
    await registerLeader(app);
    const pool = store.getTeammatePool();
    assertEquals(pool.minTeammates, 2);
    assertEquals(pool.isDefault, true);
    assertEquals((await pendingSpawns(app)).length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("the default tracks maxTeammates and rounds down", () => {
  assertEquals(resolveMinTeammates({ maxTeammates: 5 }), 2);
  assertEquals(resolveMinTeammates({ maxTeammates: 1 }), 0);
  assertEquals(resolveMinTeammates({ maxTeammates: 0 }), 0);
  assertEquals(resolveMinTeammates({ maxTeammates: 6, minTeammates: 0 }), 0); // explicit 0 wins
  assertEquals(resolveMinTeammates({ maxTeammates: 2, minTeammates: 5 }), 2); // capped
});

Deno.test("the derived default is not written to config.json", () => {
  const { store, teamDir } = setup({ minTeammates: undefined });
  try {
    store.saveConfig();
    const onDisk = JSON.parse(Deno.readTextFileSync(path.join(teamDir, "config.json")));
    assertEquals("minTeammates" in onDisk, false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("PUT null clears the declaration back to the default", async () => {
  const { app, store, teamDir } = setup({ maxTeammates: 4 });
  try {
    assertEquals(store.getTeammatePool().minTeammates, 0);
    const body = await (await put(app, "/api/teammate-pool", { minTeammates: null })).json();
    assertEquals(body.success, true);
    assertEquals(body.minTeammates, 2);
    assertEquals(body.isDefault, true);
  } finally { cleanup(teamDir, store); }
});

Deno.test("explicit zero: the daemon spawns nothing on its own", async () => {
  const { app, store, teamDir } = setup();
  try {
    await registerLeader(app);
    assertEquals(store.getTeammatePool().minTeammates, 0);
    assertEquals(store.getTeammatePool().isDefault, false);
    assertEquals(store.reconcileTeammatePool(), 0);
    assertEquals((await pendingSpawns(app)).length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("setting the minimum queues spawns for the shortfall", async () => {
  const { app, store, teamDir } = setup();
  try {
    await registerLeader(app);
    const res = await put(app, "/api/teammate-pool", { minTeammates: 2 });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.minTeammates, 2);
    assertEquals(body.pending, 2);
    assertEquals((await pendingSpawns(app)).length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("pending spawns count toward the minimum (no duplicate batches)", async () => {
  const { app, store, teamDir } = setup();
  try {
    await registerLeader(app);
    store.setMinTeammates(2);
    // Nothing has been realized yet — reconciling again must not double up.
    assertEquals(store.reconcileTeammatePool(), 0);
    assertEquals((await pendingSpawns(app)).length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("online teammates count toward the minimum; the leader does not", async () => {
  const { app, store, teamDir } = setup();
  try {
    await registerLeader(app);
    await post(app, "/api/agents/register", { id: "t1", name: "swift-ripley", hostId: "h1" });
    await post(app, "/api/agents/register", { id: "t2", name: "calm-hopper", hostId: "h1" });

    const pool = store.getTeammatePool();
    assertEquals(pool.online, 2); // both teammates — the leader is a singleton, not pool

    store.setMinTeammates(3);
    // 2 online + 1 spawned = 3.
    assertEquals((await pendingSpawns(app)).length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("the target is capped by maxTeammates", async () => {
  const { app, store, teamDir } = setup({ maxTeammates: 2 });
  try {
    await registerLeader(app);
    assertEquals(store.setMinTeammates(5), 2); // clamped on the way in
    assertEquals((await pendingSpawns(app)).length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("no leader online: the pool waits instead of queueing unrealizable spawns", async () => {
  const { app, store, teamDir } = setup();
  try {
    assertEquals(store.getTeammatePool().leaderPresent, false);
    store.setMinTeammates(2);
    assertEquals((await pendingSpawns(app)).length, 0);

    // A leader arriving fills the pool immediately (no waiting for the tick).
    await registerLeader(app);
    assertEquals((await pendingSpawns(app)).length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a teammate that goes offline is replaced on the next reconcile", async () => {
  const { app, store, teamDir } = setup();
  try {
    await registerLeader(app);
    await post(app, "/api/agents/register", { id: "t1", name: "swift-ripley", hostId: "h1" });
    store.setMinTeammates(1);
    assertEquals((await pendingSpawns(app)).length, 0); // already satisfied

    // Dismissed (or reaped) — the pool is short again.
    await app.request("/api/agents/t1?dismiss=true", { method: "DELETE" });
    assertEquals(store.reconcileTeammatePool(), 1);
    assertEquals((await pendingSpawns(app)).length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("the minimum is persisted to config.json (applied at startup)", async () => {
  const { app, store, teamDir } = setup();
  try {
    await registerLeader(app);
    await put(app, "/api/teammate-pool", { minTeammates: 3 });
    const onDisk = JSON.parse(Deno.readTextFileSync(path.join(teamDir, "config.json")));
    assertEquals(onDisk.minTeammates, 3);
  } finally { cleanup(teamDir, store); }
});

Deno.test("PUT rejects non-integer / negative sizes", async () => {
  const { app, store, teamDir } = setup();
  try {
    assertEquals((await put(app, "/api/teammate-pool", { minTeammates: -1 })).status, 400);
    assertEquals((await put(app, "/api/teammate-pool", { minTeammates: 1.5 })).status, 400);
    assertEquals((await put(app, "/api/teammate-pool", {})).status, 400);
    assertEquals(store.getTeammatePool().minTeammates, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/teammate-pool reports the live pool", async () => {
  const { app, store, teamDir } = setup({ maxTeammates: 4 });
  try {
    await registerLeader(app);
    await post(app, "/api/agents/register", { id: "t1", name: "swift-ripley", hostId: "h1" });
    store.setMinTeammates(2);

    const body = await (await app.request("/api/teammate-pool")).json();
    assertEquals(body.minTeammates, 2);
    assertEquals(body.maxTeammates, 4);
    assertEquals(body.online, 1);
    assertEquals(body.pending, 1);
    assertEquals(body.leaderPresent, true);
  } finally { cleanup(teamDir, store); }
});

Deno.test("PUT /api/config also carries minTeammates (and keeps 0 meaningful)", async () => {
  const { app, store, teamDir, config } = setup();
  try {
    await registerLeader(app);
    const workflows = { default: { states: [{ name: "in_progress", type: "agent" }] } };
    const res = await put(app, "/api/config", { defaultWorkflow: "default", workflows, minTeammates: 2 });
    assertEquals(res.status, 200);
    assertEquals(config.minTeammates, 2);
    assertEquals((await pendingSpawns(app)).length, 2);

    // Back to zero: `0` must not be swallowed as "unset".
    await put(app, "/api/config", { defaultWorkflow: "default", workflows, minTeammates: 0 });
    assertEquals(config.minTeammates, 0);
  } finally { cleanup(teamDir, store); }
});
