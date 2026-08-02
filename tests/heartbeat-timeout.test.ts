/**
 * tests/heartbeat-timeout.test.ts — Verifies agent heartbeat timeout and reaping.
 *
 * Tests that agents missing heartbeats for agentTimeoutSeconds are:
 * - Marked offline
 * - Have their claimed tasks released
 * - Logged as warnings
 */

import { assertEquals } from "@std/assert";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

function createTempTeamDir(): string {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-heartbeat-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  return teamDir;
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

Deno.test("reapOfflineAgents marks timed-out agents as offline", () => {
  const teamDir = createTempTeamDir();
  const config: TeamConfig = { ...DEFAULT_CONFIG, agentTimeoutSeconds: 5 };
  const store = new Store(teamDir, config);
  try {
    // Register agent with a heartbeat in the past (6 seconds ago > 5s timeout)
    store.registerMember("a1", "neo", "/tmp");
    // Manually backdate the heartbeat
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() - 6000, "a1");

    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, ["a1"]);
    assertEquals(store.getMember("a1")?.status, "offline");
  } finally { cleanup(teamDir, store); }
});

Deno.test("reapOfflineAgents does not reap agents within timeout", () => {
  const teamDir = createTempTeamDir();
  const config: TeamConfig = { ...DEFAULT_CONFIG, agentTimeoutSeconds: 60 };
  const store = new Store(teamDir, config);
  try {
    store.registerMember("a1", "neo", "/tmp");
    // Heartbeat is fresh (just registered)
    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, []);
    assertEquals(store.getMember("a1")?.status, "idle");
  } finally { cleanup(teamDir, store); }
});

Deno.test("reapOfflineAgents moves in-flight WorkItems to MORIBUND", () => {
  const teamDir = createTempTeamDir();
  const config: TeamConfig = { ...DEFAULT_CONFIG, agentTimeoutSeconds: 5 };
  const store = new Store(teamDir, config);
  try {
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
  } finally { cleanup(teamDir, store); }
});

Deno.test("reapOfflineAgents skips already-offline agents", () => {
  const teamDir = createTempTeamDir();
  const config: TeamConfig = { ...DEFAULT_CONFIG, agentTimeoutSeconds: 5 };
  const store = new Store(teamDir, config);
  try {
    store.registerMember("a1", "neo", "/tmp");
    // Mark offline first
    store.updateMemberStatus("a1", "offline");
    // Backdate heartbeat
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE members SET last_heartbeat = ? WHERE id = ?")
      .run(Date.now() - 6000, "a1");

    const reaped = store.reapOfflineAgents();
    assertEquals(reaped, []); // Should not reap again
  } finally { cleanup(teamDir, store); }
});

Deno.test("agent comes back online after being reaped", () => {
  const teamDir = createTempTeamDir();
  const config: TeamConfig = { ...DEFAULT_CONFIG, agentTimeoutSeconds: 5 };
  const store = new Store(teamDir, config);
  try {
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
  } finally { cleanup(teamDir, store); }
});

Deno.test("reapOfflineAgents uses default timeout when not configured", () => {
  const teamDir = createTempTeamDir();
  // Don't set agentTimeoutSeconds — should default to 90
  const config: TeamConfig = { ...DEFAULT_CONFIG };
  delete config.agentTimeoutSeconds;
  const store = new Store(teamDir, config);
  try {
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
  } finally { cleanup(teamDir, store); }
});
