/**
 * useTeamData — Everything the Team tab (and the dock's collapsed rail) shows:
 * connected agents, pending spawns, the live work queue, and the teammate pool,
 * plus the actions on them.
 *
 * Owned by the SideDock rather than the Team panel so the data (and the badges
 * derived from it — online count, queue size, "needs attention") stay live
 * while you're on the Assistant tab or the dock is collapsed.
 */

import { useApi, apiDelete, apiPost } from "@/hooks/useApi";
import type { TeammatePool } from "@/components/TeamSizeDialog";
import type { QueueItem, SpawnRequest, Teammate } from "@/lib/team";

export interface TeamData {
  teammates: Teammate[];
  online: Teammate[];
  offline: Teammate[];
  pendingSpawns: SpawnRequest[];
  queue: QueueItem[];
  pool: TeammatePool | null;
  /** A declared size nothing can realize yet (no leader to act on spawns). */
  poolBlocked: boolean;
  /** Something wants a human: an at-risk (MORIBUND) item or a blocked pool. */
  needsAttention: boolean;
  dismiss: (id: string) => Promise<void>;
  reset: (t: Teammate) => Promise<void>;
  cancelSpawn: (id: string) => Promise<void>;
  cancelItem: (id: string) => Promise<void>;
  forceFail: (id: string, reEnqueue: boolean) => Promise<void>;
  refetchPool: () => void;
  refetchSpawns: () => void;
}

export function useTeamData(): TeamData {
  const { data, refetch } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: spawnData, refetch: refetchSpawns } = useApi<{ requests: SpawnRequest[] }>("/api/spawn-requests", [], { pollInterval: 10_000 });
  const { data: queueData, refetch: refetchQueue } = useApi<{ items: QueueItem[]; total: number }>(
    "/api/work-items?state=READY,IN_PROGRESS,MORIBUND", [], { pollInterval: 5000 },
  );
  const { data: pool, refetch: refetchPool } = useApi<TeammatePool>("/api/teammate-pool", [], { pollInterval: 10_000 });

  const teammates = data?.agents || [];
  const queue = queueData?.items || [];
  const poolBlocked = !!pool && pool.minTeammates > 0 && !pool.leaderPresent;

  return {
    teammates,
    online: teammates.filter((a) => a.status !== "offline"),
    offline: teammates.filter((a) => a.status === "offline"),
    pendingSpawns: spawnData?.requests || [],
    queue,
    pool,
    poolBlocked,
    needsAttention: poolBlocked || queue.some((q) => q.state === "MORIBUND"),

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
    // Queue recovery actions (see docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md).
    cancelItem: async (id) => {
      await apiPost(`/api/work-items/${encodeURIComponent(id)}/cancel`, {});
      refetchQueue();
    },
    forceFail: async (id, reEnqueue) => {
      await apiPost(`/api/work-items/${encodeURIComponent(id)}/force-fail`, { reEnqueue });
      refetchQueue();
    },
    refetchPool,
    refetchSpawns,
  };
}
