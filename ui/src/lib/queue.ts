/**
 * lib/queue.ts — The live work queue: non-terminal WorkItems (READY /
 * IN_PROGRESS / MORIBUND), shared by the Queue tab (pages/QueuePage) and the
 * dock's summary strip (components/queue/QueueSummary). Terminal items are
 * reviewed in the Inbox; this is work *in flight*.
 */

import type { LinkableWorkItem } from "@/lib/work-item-link";

export type QueueState = "READY" | "IN_PROGRESS" | "MORIBUND";

export interface QueueItem extends LinkableWorkItem {
  id: string;
  title: string;
  state: QueueState;
  /** The teammate holding it (IN_PROGRESS / MORIBUND). */
  memberId?: string | null;
  directory?: string | null;
  enqueuedAt: string;
  lastStateChangeAt: string;
}

/** Human labels + colors per state, in the order they're worth your attention. */
export const QUEUE_STATES: Array<{ state: QueueState; label: string; dot: string; chip: string }> = [
  { state: "MORIBUND", label: "At risk", dot: "bg-amber-500", chip: "text-amber-600 border-amber-500/50" },
  { state: "READY", label: "Waiting", dot: "bg-muted-foreground/50", chip: "text-muted-foreground" },
  { state: "IN_PROGRESS", label: "Working", dot: "bg-green-500", chip: "text-green-600 border-green-500/50" },
];

export function queueStateInfo(state: QueueState) {
  return QUEUE_STATES.find((s) => s.state === state) ?? QUEUE_STATES[1]!;
}

export interface QueueCounts {
  atRisk: number;
  waiting: number;
  working: number;
  total: number;
}

export function countQueue(items: QueueItem[]): QueueCounts {
  const atRisk = items.filter((i) => i.state === "MORIBUND").length;
  const waiting = items.filter((i) => i.state === "READY").length;
  const working = items.filter((i) => i.state === "IN_PROGRESS").length;
  return { atRisk, waiting, working, total: items.length };
}

/** Attention order: at risk, then waiting (oldest first), then working. */
export function sortQueue(items: QueueItem[]): QueueItem[] {
  const rank = (s: QueueState) => QUEUE_STATES.findIndex((x) => x.state === s);
  return [...items].sort((a, b) => rank(a.state) - rank(b.state) || a.lastStateChangeAt.localeCompare(b.lastStateChangeAt));
}

/** "4m", "2h", "3d" since an ISO timestamp (for "waiting 12m"). */
export function since(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
