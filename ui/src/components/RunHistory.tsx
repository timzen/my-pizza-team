/**
 * RunHistory — A WorkDef's runs, newest first (`GET
 * /api/work-items?workDefId=`): each run's state, who worked it, when, and the
 * persona it worked with — the snapshot recorded at claim, so a persona edited
 * or deleted since doesn't rewrite it (docs/DESIGN.md "The in-flight persona").
 * Shown on the WorkDef and board-task Details tabs; polls while open so an
 * in-flight run's chip appears as it's claimed.
 */

import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { PersonaChip } from "@/components/personas/PersonaChip";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { PersonaRef } from "@/lib/personas";

/** The slice of `WorkItemView` a run row reads. */
interface RunItem {
  id: string;
  state: string;
  memberId?: string;
  enqueuedAt: string;
  lastStateChangeAt: string;
  attempt: number;
  error?: string;
  persona?: PersonaRef;
}

/** How many runs to show (the rest are in the Inbox). */
const LIMIT = 10;

const STATE_TONE: Record<string, string> = {
  IN_PROGRESS: "border-green-500/50 text-green-600",
  MORIBUND: "border-amber-500/50 text-amber-600",
  COMPLETE: "border-emerald-500/50 text-emerald-600",
  FAILED: "border-red-500/50 text-red-600",
};

export function RunHistory({ workDefId }: { workDefId: string }) {
  const { data } = useApi<{ items: RunItem[]; total: number }>(
    `/api/work-items?workDefId=${encodeURIComponent(workDefId)}&limit=${LIMIT}`, [workDefId], { pollInterval: 10_000 },
  );
  const items = data?.items ?? [];
  return (
    <div>
      <div className="mb-2 pb-1 border-b border-border"><Label>Runs</Label></div>
      {data && items.length === 0 && <p className="text-sm italic text-muted-foreground">Not run yet.</p>}
      <ul className="space-y-1">
        {items.map((wi) => (
          <li key={wi.id} className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className={`text-[10px] ${STATE_TONE[wi.state] ?? "text-muted-foreground"}`}>{wi.state.toLowerCase().replace("_", " ")}</Badge>
            <span className="text-muted-foreground" title={`Enqueued ${new Date(wi.enqueuedAt).toLocaleString()}`}>{new Date(wi.lastStateChangeAt).toLocaleString()}</span>
            {wi.attempt > 1 && <span className="text-muted-foreground">attempt {wi.attempt}</span>}
            {wi.memberId && <Link to={`/teammates/${encodeURIComponent(wi.memberId)}`} className="text-primary hover:underline">{wi.memberId}</Link>}
            <PersonaChip persona={wi.persona} />
            {wi.error && <span className="truncate text-destructive" title={wi.error}>{wi.error}</span>}
          </li>
        ))}
      </ul>
      {data && data.total > items.length && <p className="mt-1 text-[11px] text-muted-foreground">{data.total - items.length} earlier runs not shown.</p>}
    </div>
  );
}
