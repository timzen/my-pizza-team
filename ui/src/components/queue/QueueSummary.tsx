/**
 * QueueSummary — The dock's always-visible queue strip (above Start work).
 *
 *   ⏱ Queue   ● 1 at risk · 2 waiting · 1 working        ›
 *
 * The queue is work *in flight*, and what needs to be glanceable is the
 * summary, not the list — so the strip carries the counts (at risk in amber:
 * it's the one state that needs you) and links to the full **Queue** tab on the
 * home page (`/queue`), where the recovery actions live. **Hovering** (or
 * focusing) the strip previews the list — each item's status, title, and who
 * holds it — with rows that link to the item.
 *
 * The preview is plain CSS (`group-hover` / `group-focus-within`) so it needs
 * no popover machinery; it's rendered inside the strip's hover target (padding,
 * not margin, bridges the gap) so moving onto it doesn't dismiss it.
 */

import { Link, useMatch } from "react-router-dom";
import type { QueueData } from "@/hooks/useQueue";
import { queueStateInfo, since } from "@/lib/queue";
import { workItemPath } from "@/lib/work-item-link";
import { ChevronRight, ListTodo } from "lucide-react";

/** Rows shown in the hover preview before "and N more". */
const PREVIEW_MAX = 12;

export function QueueSummary({ queue }: { queue: QueueData }) {
  const { items, counts } = queue;
  const onQueuePage = useMatch("/queue") !== null;
  const shown = items.slice(0, PREVIEW_MAX);

  return (
    <div className="group relative shrink-0 border-t border-border px-2 py-1.5">
      <Link
        to="/queue"
        className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted ${onQueuePage ? "bg-muted" : ""}`}
        title="Open the Queue"
      >
        <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium uppercase tracking-wide text-muted-foreground">Queue</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          {counts.total === 0 && <span className="text-muted-foreground">nothing in flight</span>}
          {counts.atRisk > 0 && (
            <span className="flex items-center gap-1 font-medium text-amber-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{counts.atRisk} at risk
            </span>
          )}
          {[
            counts.waiting > 0 && `${counts.waiting} waiting`,
            counts.working > 0 && `${counts.working} working`,
          ].filter(Boolean).map((part) => (
            <span key={part as string} className="text-muted-foreground before:mr-1.5 before:content-['·'] first:before:hidden">{part}</span>
          ))}
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </Link>

      {items.length > 0 && (
        // pb bridges strip → preview so the hover survives the gap.
        <div className="invisible absolute inset-x-2 bottom-full z-30 pb-1 opacity-0 transition-opacity delay-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
          <div className="max-h-80 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
            {shown.map((item) => {
              const info = queueStateInfo(item.state);
              return (
                <Link key={item.id} to={workItemPath(item)} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${info.dot}`} title={info.label} />
                  <span className="min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {item.state === "READY" ? `waiting ${since(item.lastStateChangeAt)}` : item.memberId ?? info.label.toLowerCase()}
                  </span>
                </Link>
              );
            })}
            {items.length > shown.length && (
              <Link to="/queue" className="block px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                and {items.length - shown.length} more…
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
