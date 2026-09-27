/**
 * useTeamData — Everything the Team tab (and the dock's collapsed rail) shows:
 * connected agents, pending spawns, the live work queue, and the teammate pool,
 * plus the actions on them.
 *
 * Owned by the SideDock rather than the Team panel so the data (and the badges
 * derived from it — online count, "needs attention") stay live
 * while you're on the Assistant tab or the dock is collapsed.
 *
 * **Teammates only — the leader is left out.** The leader is the agent behind
 * the Assistant tab (its presence is the status dot there), so listing and
 * counting it on the Team tab too was double-booking one agent. It still
 * matters to the team indirectly: `poolBlocked` is "no leader to spawn".
 */

import { useApi, apiDelete, apiPost } from "@/hooks/useApi";
import type { TeammatePool } from "@/components/TeamSizeDialog";
import { harnessSkew, roleOf, type FailedSpawn, type SpawnRequest, type Teammate } from "@/lib/team";

export interface TeamData {
  /** Pool teammates (never the leader). */
  teammates: Teammate[];
  online: Teammate[];
  offline: Teammate[];
  pendingSpawns: SpawnRequest[];
  /** Spawns the daemon tried and couldn't complete, newest first. */
  failedSpawns: FailedSpawn[];
  pool: TeammatePool | null;
  /** A declared size nothing can realize yet (no leader to act on spawns). */
  poolBlocked: boolean;
  /** The team wants a human: a declared size it can't meet (at-risk work is the queue strip's job). */
  needsAttention: boolean;
  /** The daemon's build version, for comparing against each agent's harness. */
  daemonVersion?: string;
  /**
   * Agents whose extension is behind the daemon. Restarting them is the fix; until
   * then they keep working while quietly skipping anything the newer protocol
   * added (docs/DESIGN.md "One Protocol, One Version").
   */
  skewed: Array<{ teammate: Teammate; reason: string }>;
  dismiss: (id: string) => Promise<void>;
  reset: (t: Teammate) => Promise<void>;
  /**
   * Roll every skewed agent's session so it picks up a newer extension.
   *
   * After `mpt upgrade` the extension on disk is new but running agents still hold
   * the old code, so the skew banner appears and nothing clears it on its own. This
   * is that remedy (P2-9). Returns how many were asked.
   */
  restartSkewed: () => Promise<number>;
  cancelSpawn: (id: string) => Promise<void>;
  refetchPool: () => void;
  refetchSpawns: () => void;
}

export function useTeamData(): TeamData {
  const { data, refetch } = useApi<{ agents: Teammate[]; daemonVersion?: string }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: spawnData, refetch: refetchSpawns } = useApi<{ requests: SpawnRequest[]; failed: FailedSpawn[] }>("/api/spawn-requests", [], { pollInterval: 10_000 });
  const { data: pool, refetch: refetchPool } = useApi<TeammatePool>("/api/teammate-pool", [], { pollInterval: 10_000 });

  const teammates = (data?.agents || []).filter((a) => roleOf(a) === "teammate");
  const poolBlocked = !!pool && pool.minTeammates > 0 && !pool.leaderPresent;

  // Skew covers *every* agent including the leader: the leader answers the chat,
  // so a stale leader is the most user-visible kind of drift.
  const skewed = (data?.agents || [])
    .map((t) => {
      const skew = harnessSkew(t, data?.daemonVersion);
      return skew ? { teammate: t, reason: skew.reason } : null;
    })
    .filter((x): x is { teammate: Teammate; reason: string } => x !== null);

  return {
    teammates,
    online: teammates.filter((a) => a.status !== "offline"),
    offline: teammates.filter((a) => a.status === "offline"),
    pendingSpawns: spawnData?.requests || [],
    failedSpawns: spawnData?.failed || [],
    pool,
    poolBlocked,
    // A failed spawn wants a human as much as an unmet size does: the team is short
    // and will stay short until someone looks.
    needsAttention: poolBlocked || (spawnData?.failed?.length ?? 0) > 0,
    daemonVersion: data?.daemonVersion,
    skewed,

    // `?dismiss=true` tombstones the id so the agent actually shuts down (a plain
    // DELETE would just remove it, and the agent would re-register on its next
    // heartbeat, treating it like a daemon restart).
    dismiss: async (id) => {
      await apiDelete(`/api/agents/${encodeURIComponent(id)}?dismiss=true`);
      refetch();
    },
    // Reset a teammate's session (clears its context window) via a leader
    // directive the leader realizes as Pi's `/new` in the teammate's window.
    reset: async (t) => {
      await apiPost("/api/leader/directives", { action: "reset-session", memberId: t.id });
    },
    // Only the skewed ones: resetting a healthy agent would throw away its context
    // window for nothing.
    restartSkewed: async () => {
      for (const { teammate } of skewed) {
        await apiPost("/api/leader/directives", { action: "reset-session", memberId: teammate.id });
      }
      return skewed.length;
    },
    cancelSpawn: async (id) => {
      await apiDelete(`/api/spawn-requests/${encodeURIComponent(id)}`);
      refetchSpawns();
    },
    refetchPool,
    refetchSpawns,
  };
}
