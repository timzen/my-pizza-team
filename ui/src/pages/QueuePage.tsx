/**
 * QueuePage — The **Queue** tab on the home page (`/queue`): work in flight.
 *
 * Sits before the Inbox (`Queue | Inbox`) because it's the middle of a piece of
 * work's life (ideas start earlier, on the Thoughts nav page): the Inbox
 * reviews *finished* WorkItems;
 * this shows the non-terminal ones, grouped by what they need from you:
 *
 *   - **At risk** (MORIBUND) — its teammate went silent mid-work; nothing retries
 *     it automatically (DESIGN.md "Reaping"). Force-fail it, or force-fail and
 *     re-enqueue a fresh attempt.
 *   - **Waiting** (READY) — not picked up yet. Cancel it if it's not wanted. A
 *     hint explains a stall: distribution paused, or no idle teammate.
 *   - **Working** (IN_PROGRESS) — who has it (linked to their live view) and
 *     for how long.
 *
 * Every title links to the item's page. The dock's QueueSummary strip is the
 * always-visible summary of this page (and previews it on hover).
 */

import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { useQueue } from "@/hooks/useQueue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QUEUE_STATES, since, type QueueItem, type QueueState } from "@/lib/queue";
import { workItemPath } from "@/lib/work-item-link";
import { dirName, roleOf, type Teammate } from "@/lib/team";
import { AlertTriangle, Ban, FolderOpen, ListTodo, RotateCcw, X } from "lucide-react";

/** What each group is for, shown under its heading. */
const GROUP_HINT: Record<QueueState, string> = {
  MORIBUND: "Its teammate went silent mid-work. Nothing retries these automatically — decide what happens.",
  READY: "Queued, not picked up yet.",
  IN_PROGRESS: "Being worked on right now.",
};

export function QueuePage() {
  const queue = useQueue();
  const { data: agents } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: status } = useApi<{ paused?: boolean }>("/api/status", [], { pollInterval: 10_000 });

  const teammates = (agents?.agents || []).filter((a) => roleOf(a) === "teammate");
  const idle = teammates.filter((t) => t.status === "idle").length;
  const stall = stallReason(queue.counts.waiting, !!status?.paused, teammates.length, idle);

  if (queue.loaded && queue.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
        <ListTodo className="h-8 w-8" />
        <p className="text-sm">Nothing in flight — queued and running work shows up here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {stall && (
        <p className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />{stall}
        </p>
      )}
      {QUEUE_STATES.map(({ state, label, dot }) => {
        const items = queue.items.filter((i) => i.state === state);
        if (items.length === 0) return null;
        return (
          <section key={state} className="space-y-2">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <span className={`h-2 w-2 rounded-full ${dot}`} />{label} <span className="font-normal text-muted-foreground">({items.length})</span>
              </h2>
              <p className="text-xs text-muted-foreground">{GROUP_HINT[state]}</p>
            </div>
            <div className="space-y-2">
              {items.map((item) => (
                <QueueRow key={item.id} item={item} onCancel={queue.cancel} onForceFail={queue.forceFail} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Why waiting work isn't moving, when there's an obvious reason. */
function stallReason(waiting: number, paused: boolean, teammates: number, idle: number): string | null {
  if (waiting === 0) return null;
  if (paused) return "Task distribution is paused (⏸ in the nav), so waiting work won't be picked up.";
  if (teammates === 0) return "No teammates are online. Set a team size or spawn one from the Team tab.";
  if (idle === 0) return "Every teammate is busy. Raise the team size (Team tab) if waiting work should start sooner.";
  return null;
}

function QueueRow({
  item,
  onCancel,
  onForceFail,
}: {
  item: QueueItem;
  onCancel: (id: string) => void;
  onForceFail: (id: string, reEnqueue: boolean) => void;
}) {
  const dir = dirName(item.directory);
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-background p-3">
      <div className="min-w-0 flex-1">
        <Link to={workItemPath(item)} className="block truncate text-sm font-medium hover:underline" title={item.title}>
          {item.title}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {item.state === "READY" && <span>waiting {since(item.lastStateChangeAt)}</span>}
          {item.state !== "READY" && item.memberId && (
            <span>
              {item.state === "MORIBUND" ? "was held by " : ""}
              <Link to={`/teammates/${encodeURIComponent(item.memberId)}`} className="text-primary hover:underline">{item.memberId}</Link>
              {" · "}{since(item.lastStateChangeAt)}
            </span>
          )}
          <span>{item.parent?.kind === "story" ? item.parent.id : "solitary/scheduled"}</span>
          {dir && (
            <Badge variant="secondary" className="flex items-center gap-1 font-mono text-[10px]" title={item.directory ?? undefined}>
              <FolderOpen className="h-2.5 w-2.5" />{dir}
            </Badge>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.state === "READY" && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onCancel(item.id)} title="Cancel this queued item">
            <Ban className="mr-1 h-3 w-3" />Cancel
          </Button>
        )}
        {item.state === "MORIBUND" && (
          <>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onForceFail(item.id, false)} title="Force this abandoned item to FAILED">
              <X className="mr-1 h-3 w-3" />Force-fail
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onForceFail(item.id, true)} title="Force-fail and enqueue a fresh attempt">
              <RotateCcw className="mr-1 h-3 w-3" />Re-enqueue
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
