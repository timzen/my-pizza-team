/**
 * tests/heartbeat-timeout.test.ts — Verifies agent heartbeat timeout and reaping.
 *
 * Tests that agents missing heartbeats for agentTimeoutSeconds are:
 * - Marked offline
 * - Have their claimed tasks released
 * - Logged as warnings
 *
 * Also that deregistering (`removeMember`) moves a member's in-flight items to
 * MORIBUND the same way, since the reaper never sees a member once it's gone.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, type TeamOptions } from "./_team.ts";

/** Leaves `agentTimeoutSeconds` unset, as a config.json without it would. */
const NO_TIMEOUT: TeamOptions = { beforeStore: (_teamDir, config) => { delete config.agentTimeoutSeconds; } };

test("reapOfflineAgents marks timed-out agents as offline", () => {
  return withTeam({ agentTimeoutSeconds: 5 }, ({ store }) => {
    // Register agent with a heartbeat in the past (6 seconds ago > 5s timeout)
    store.registerMember("a1", "neo", "/tmp");
    // Manually backdate the heartbeat
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() - 6000, "a1");

    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, ["a1"]);
    assertEquals(store.getMember("a1")?.status, "offline");
  });
});

test("reapOfflineAgents does not reap agents within timeout", () => {
  return withTeam({ agentTimeoutSeconds: 60 }, ({ store }) => {
    store.registerMember("a1", "neo", "/tmp");
    // Heartbeat is fresh (just registered)
    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, []);
    assertEquals(store.getMember("a1")?.status, "idle");
  });
});

test("reapOfflineAgents moves in-flight WorkItems to MORIBUND", () => {
  return withTeam({ agentTimeoutSeconds: 5 }, ({ store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "Story", "Desc", "open", [], [{ title: "T1", description: "D1" }]);
    const item = store.getNextWorkItem({ id: "a1" })!;
    store.claimWorkItem(item.id, "a1");
    assertEquals(store.getWorkItem(item.id)!.state, "IN_PROGRESS");

    // Backdate heartbeat
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() - 6000, "a1");

    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, ["a1"]);
    // The WorkItem is MORIBUND (not failed, not handed off); the lease is kept.
    assertEquals(store.getWorkItem(item.id)!.state, "MORIBUND");
    assertEquals(store.getAssignment("s1-1")?.memberId, "a1");
    assertEquals(store.getMember("a1")?.status, "offline");
  });
});

test("reapOfflineAgents skips already-offline agents", () => {
  return withTeam({ agentTimeoutSeconds: 5 }, ({ store }) => {
    store.registerMember("a1", "neo", "/tmp");
    // Mark offline first
    store.updateMemberStatus("a1", "offline");
    // Backdate heartbeat
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() - 6000, "a1");

    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, []); // Should not reap again
  });
});

test("agent comes back online after being reaped", () => {
  return withTeam({ agentTimeoutSeconds: 5 }, ({ store }) => {
    store.registerMember("a1", "neo", "/tmp");
    // Backdate and reap
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() - 6000, "a1");
    store.reapOfflineAgents();
    assertEquals(store.getMember("a1")?.status, "offline");

    // Agent sends heartbeat (comes back online)
    store.heartbeat("a1", "idle");
    assertEquals(store.getMember("a1")?.status, "idle");

    // Should not be reaped now
    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, []);
  });
});

test("reapOfflineAgents uses default timeout when not configured", () => {
  // Don't set agentTimeoutSeconds — should default to 90
  return withTeam({}, ({ store }) => {
    store.registerMember("a1", "neo", "/tmp");
    // Backdate by 60s — should NOT be reaped (default is 90s)
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() - 60000, "a1");

    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, []);

    // Backdate by 91s — should be reaped
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() - 91000, "a1");

    const reaped2 = store.reapOfflineAgents();
    assertEquals(reaped2, ["a1"]);
  }, NO_TIMEOUT);
});

test("removeMember moves a deregistered member's in-flight WorkItem to MORIBUND", () => {
  return withTeam({}, ({ store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "Story", "Desc", "open", [], [{ title: "T1", description: "D1" }]);
    const item = store.getNextWorkItem({ id: "a1" })!;
    store.claimWorkItem(item.id, "a1");

    // A Pi teammate deregistering on shutdown mid-item.
    store.removeMember("a1");
    assertEquals(store.getMember("a1"), null);
    const after = store.getWorkItem(item.id)!;
    assertEquals(after.state, "MORIBUND");
    // Not terminal: no retry enqueued, and a human can still force-fail it.
    assertEquals(store.getWorkItems({ workDefId: "s1-1" }).total, 1);
    assertEquals(store.forceFailWorkItem(item.id).ok, true);
    assertEquals(store.getWorkItem(item.id)!.state, "FAILED");
  });
});

test("removeMember of an idle member leaves WorkItems unchanged", () => {
  return withTeam({}, ({ store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/tmp");
    store.createStory("s1", "Story", "Desc", "open", [], [{ title: "T1", description: "D1" }]);
    const item = store.getNextWorkItem({ id: "a2" })!;
    store.claimWorkItem(item.id, "a2");

    store.removeMember("a1");
    const after = store.getWorkItem(item.id)!;
    assertEquals(after.state, "IN_PROGRESS");
    assertEquals(after.memberId, "a2");
  });
});

test("removeMember after failing the item (mpt agent's stop) leaves it FAILED", () => {
  return withTeam({}, ({ store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "Story", "Desc", "open", [], [{ title: "T1", description: "D1" }]);
    const item = store.getNextWorkItem({ id: "a1" })!;
    store.claimWorkItem(item.id, "a1");

    // AgentSupervisor.stop: fail the item in hand, then deregister.
    assertEquals(store.setWorkItemState(item.id, "FAILED").ok, true);
    const states = () => store.getWorkItems({ workDefId: "s1-1" }).items.map((wi) => [wi.id, wi.state, wi.lastStateChangeAt]);
    const before = states();
    store.removeMember("a1");
    assertEquals(store.getWorkItem(item.id)!.state, "FAILED");
    assertEquals(states(), before);
  });
});
