/**
 * useQueue — The live work queue (non-terminal WorkItems) plus its recovery
 * actions: cancel a READY item; force-fail a MORIBUND one, optionally
 * re-enqueuing a fresh attempt (docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md).
 *
 * Used by the dock's summary strip (always mounted, so the counts are always
 * live) and by the Queue tab.
 */

import { useApi, apiPost } from "@/hooks/useApi";
import { countQueue, sortQueue, type QueueCounts, type QueueItem } from "@/lib/queue";

export interface QueueData {
  /** In attention order (at risk → waiting → working). */
  items: QueueItem[];
  counts: QueueCounts;
  loaded: boolean;
  cancel: (id: string) => Promise<void>;
  forceFail: (id: string, reEnqueue: boolean) => Promise<void>;
}

export function useQueue(): QueueData {
  const { data, refetch } = useApi<{ items: QueueItem[]; total: number }>(
    "/api/work-items?state=READY,IN_PROGRESS,MORIBUND", [], { pollInterval: 5000 },
  );
  const items = sortQueue(data?.items || []);
  return {
    items,
    counts: countQueue(items),
    loaded: data !== null,
    cancel: async (id) => {
      await apiPost(`/api/work-items/${encodeURIComponent(id)}/cancel`, {});
      refetch();
    },
    forceFail: async (id, reEnqueue) => {
      await apiPost(`/api/work-items/${encodeURIComponent(id)}/force-fail`, { reEnqueue });
      refetch();
    },
  };
}
