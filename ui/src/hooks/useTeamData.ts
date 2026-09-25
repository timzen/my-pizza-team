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
import { roleOf, type SpawnRequest, type Teammate } from "@/lib/team";

export interface TeamData {
  /** Pool teammates (never the leader). */
  teammates: Teammate[];
  online: Teammate[];
  offline: Teammate[];
  pendingSpawns: SpawnRequest[];
  pool: TeammatePool | null;
  /** A declared size nothing can realize yet (no leader to act on spawns). */
  poolBlocked: boolean;
  /** The team wants a human: a declared size it can't meet (at-risk work is the queue strip's job). */
  needsAttention: boolean;
  dismiss: (id: string) => Promise<void>;
  reset: (t: Teammate) => Promise<void>;
  cancelSpawn: (id: string) => Promise<void>;
  refetchPool: () => void;
  refetchSpawns: () => void;
}

export function useTeamData(): TeamData {
  const { data, refetch } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: spawnData, refetch: refetchSpawns } = useApi<{ requests: SpawnRequest[] }>("/api/spawn-requests", [], { pollInterval: 10_000 });
  const { data: pool, refetch: refetchPool } = useApi<TeammatePool>("/api/teammate-pool", [], { pollInterval: 10_000 });

  const teammates = (data?.agents || []).filter((a) => roleOf(a) === "teammate");
  const poolBlocked = !!pool && pool.minTeammates > 0 && !pool.leaderPresent;

  return {
    teammates,
    online: teammates.filter((a) => a.status !== "offline"),
    offline: teammates.filter((a) => a.status === "offline"),
    pendingSpawns: spawnData?.requests || [],
    pool,
    poolBlocked,
    needsAttention: poolBlocked,

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
      if (!t.hostId) return;
      await apiPost(`/api/hosts/${encodeURIComponent(t.hostId)}/leader/directives`, { action: "reset-session", memberId: t.id });
    },
    cancelSpawn: async (id) => {
      await apiDelete(`/api/spawn-requests/${encodeURIComponent(id)}`);
      refetchSpawns();
    },
    refetchPool,
    refetchSpawns,
  };
}
