/**
 * tests/one-leader.test.ts — Only one live leader: a second leader registration is refused.
 *
 * The failure this exists to prevent (docs/DESIGN.md "One Host, One Leader"): after
 * a herdr restart, teammate panes came back as bare `pi` in the team directory, the
 * extension's role detection made each one a leader, and all of them registered as
 * `leader` alongside the real one — every chat message was answered four times.
 *
 * Every Pi leader registers under the same id ("leader"), so the per-process
 * `instanceId` is what tells a reconnect of the live leader (accepted) from a
 * second process (refused with 409 `leader_already_connected`). Once the live
 * leader is offline or past the reaper's threshold, a new one takes over.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { post, withTeam, type App } from "./_team.ts";
import { LEADER_ALREADY_CONNECTED, PROTOCOL_VERSION } from "../shared/protocol.ts";
import type { Store } from "../daemon/store.ts";

/** Register a Pi leader process (`instance`) over the route, as the extension does. */
const registerLeader = (app: App, instance: string, id = "leader") =>
  post(app, "/api/agents/register", { id, name: "leader", directory: "/tmp", protocolVersion: PROTOCOL_VERSION, harness: "pi", instanceId: instance });

/** Backdate a member's heartbeat by `ms` (the reaper's view of a quiet agent). */
function backdate(store: Store, id: string, ms: number): void {
  (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
    .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
    .run(Date.now() - ms, id);
}

test("a second leader is refused while the first is live, with a typed 409", () => {
  return withTeam({ agentTimeoutSeconds: 60 }, async ({ app, store }) => {
    assertEquals((await registerLeader(app, "proc-a")).status, 200);

    const res = await registerLeader(app, "proc-b");
    assertEquals(res.status, 409);
    const body = await res.json() as { success: boolean; code: string; error: string };
    assertEquals(body.success, false);
    assertEquals(body.code, LEADER_ALREADY_CONNECTED);
    assertEquals(typeof body.error, "string");

    // The live leader is untouched: still one leader, still the first process.
    const leaders = store.getMembers().filter((m) => m.name === "leader");
    assertEquals(leaders.length, 1);
    assertEquals(store.leaderRegistrationConflict("leader", "leader", "proc-a"), null);
  });
});

test("a second leader under a different member id is refused too", () => {
  return withTeam({ agentTimeoutSeconds: 60 }, async ({ app, store }) => {
    assertEquals((await registerLeader(app, "proc-a")).status, 200);
    assertEquals((await registerLeader(app, "proc-b", "leader-2")).status, 409);
    assertEquals(store.getMember("leader-2"), null);
  });
});

test("the same process reconnecting is accepted", () => {
  return withTeam({ agentTimeoutSeconds: 60 }, async ({ app, store }) => {
    assertEquals((await registerLeader(app, "proc-a")).status, 200);
    // A heartbeat-driven re-register (daemon forgot us) or a chat session roll.
    assertEquals((await registerLeader(app, "proc-a")).status, 200);
    assertEquals(store.getMember("leader")?.status, "idle");
  });
});

test("a new leader takes over once the first goes offline (reaped)", () => {
  return withTeam({ agentTimeoutSeconds: 5 }, async ({ app, store }) => {
    assertEquals((await registerLeader(app, "proc-a")).status, 200);
    backdate(store, "leader", 6_000);
    assertEquals(store.reapOfflineAgents(), ["leader"]);

    assertEquals((await registerLeader(app, "proc-b")).status, 200);
    assertEquals(store.getMember("leader")?.status, "idle");
    // …and now the old process is the one refused, should it come back.
    assertEquals((await registerLeader(app, "proc-a")).status, 409);
  });
});

test("a leader past the reaper's threshold, not yet reaped, no longer blocks a takeover", () => {
  return withTeam({ agentTimeoutSeconds: 5 }, async ({ app, store }) => {
    assertEquals((await registerLeader(app, "proc-a")).status, 200);
    backdate(store, "leader", 6_000);
    assertEquals((await registerLeader(app, "proc-b")).status, 200);
  });
});

test("a leader that deregistered (clean shutdown) is replaced at once", () => {
  return withTeam({ agentTimeoutSeconds: 60 }, async ({ app, store }) => {
    assertEquals((await registerLeader(app, "proc-a")).status, 200);
    store.removeMember("leader");
    assertEquals((await registerLeader(app, "proc-b")).status, 200);
  });
});

test("a harness that sends no instance id keeps the old behavior (re-register accepted)", () => {
  return withTeam({ agentTimeoutSeconds: 60 }, async ({ app }) => {
    const legacy = () => post(app, "/api/agents/register", { id: "leader", name: "leader", protocolVersion: PROTOCOL_VERSION });
    assertEquals((await legacy()).status, 200);
    assertEquals((await legacy()).status, 200);
  });
});

test("teammates are never subject to the guard", () => {
  return withTeam({ agentTimeoutSeconds: 60 }, async ({ app }) => {
    assertEquals((await registerLeader(app, "proc-a")).status, 200);
    const tm = (instanceId: string) => post(app, "/api/agents/register", { id: "swift-ripley", name: "swift-ripley", protocolVersion: PROTOCOL_VERSION, instanceId });
    assertEquals((await tm("proc-t1")).status, 200);
    assertEquals((await tm("proc-t2")).status, 200);
  });
});
