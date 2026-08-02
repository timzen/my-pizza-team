/**
 * InboxPage — Review queue for completed work.
 *
 * The Inbox lists terminal WorkItems that finished (COMPLETE / FAILED) so a
 * human can review the outcome and jump to the ref (task or WorkDef) where the
 * rich detail lives. CANCELED items are noise (a human already discarded them),
 * so they're excluded. Defaults to unread; a toggle shows everything. Reviewing
 * an item marks it read. Paginated so a busy team's history stays fast.
 *
 * Embedded in the Root page's "Inbox" tab (see RootPage). Polls /api/work-items.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Inbox as InboxIcon } from "lucide-react";

type WorkItemState = "READY" | "IN_PROGRESS" | "MORIBUND" | "COMPLETE" | "FAILED" | "CANCELED";
type WorkItemRef =
  | { kind: "task"; storyId: string; taskId: string }
  | { kind: "workdef"; workDefId: string };

interface WorkItem {
  id: string;
  title: string;
  ref: WorkItemRef;
  directory?: string | null;
  state: WorkItemState;
  read: boolean;
  memberId?: string | null;
  enqueuedAt: string;
  lastStateChangeAt: string;
}

const PAGE_SIZE = 20;

/** The detail route for a WorkItem's ref (where the completion comments live). */
function refLink(ref: WorkItemRef): string {
  return ref.kind === "task"
    ? `/task/${encodeURIComponent(ref.storyId)}/${encodeURIComponent(ref.taskId)}`
    : `/work-defs/${encodeURIComponent(ref.workDefId)}`;
}

export function InboxPage() {
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [offset, setOffset] = useState(0);

  // COMPLETE + FAILED only (CANCELED is discarded work, never surfaced here).
  const params = new URLSearchParams({ state: "COMPLETE,FAILED", limit: String(PAGE_SIZE), offset: String(offset) });
  if (unreadOnly) params.set("read", "false");
  const { data, refetch } = useApi<{ items: WorkItem[]; total: number }>(
    `/api/work-items?${params.toString()}`,
    [unreadOnly, offset],
    { pollInterval: 10_000 }
  );

  const items = data?.items || [];
  const total = data?.total || 0;

  const markRead = async (id: string, read: boolean) => {
    await apiPost(`/api/work-items/${encodeURIComponent(id)}/read?read=${read}`, {});
    refetch();
  };

  const markAllRead = async () => {
    await Promise.all(items.filter(i => !i.read).map(i => apiPost(`/api/work-items/${encodeURIComponent(i.id)}/read`, {})));
    refetch();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={unreadOnly} onChange={e => { setUnreadOnly(e.target.checked); setOffset(0); }} />
          Unread only
        </label>
        {items.some(i => !i.read) && (
          <Button variant="ghost" size="sm" onClick={markAllRead}>Mark all read</Button>
        )}
      </div>

      {items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <InboxIcon className="h-8 w-8" />
          <p className="text-sm">{unreadOnly ? "Inbox zero — nothing to review." : "No completed work yet."}</p>
        </div>
      )}

      <div className="space-y-2">
        {items.map(item => (
          <InboxRow key={item.id} item={item} onMarkRead={markRead} />
        ))}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Newer</Button>
          <span className="text-xs text-muted-foreground">{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
          <Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Older</Button>
        </div>
      )}
    </div>
  );
}

function InboxRow({ item, onMarkRead }: { item: WorkItem; onMarkRead: (id: string, read: boolean) => void }) {
  const failed = item.state === "FAILED";
  const when = new Date(item.lastStateChangeAt).toLocaleString();

  return (
    <Link
      to={refLink(item.ref)}
      onClick={() => { if (!item.read) onMarkRead(item.id, true); }}
      className={`flex items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50 ${
        item.read ? "border-border bg-background" : "border-primary/30 bg-primary/5"
      }`}
    >
      {failed
        ? <XCircle className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
        : <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-green-600" />}
      <div className="min-w-0 flex-1">
        <p className={`text-sm truncate ${item.read ? "" : "font-medium"}`}>{item.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {failed ? "Failed" : "Completed"}
          {item.memberId ? ` by ${item.memberId}` : ""} · {when}
          {" · "}{item.ref.kind === "task" ? item.ref.storyId : "scheduled/solitary"}
        </p>
      </div>
      {!item.read && <span className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1.5" />}
    </Link>
  );
}
