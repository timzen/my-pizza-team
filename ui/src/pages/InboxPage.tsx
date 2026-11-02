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
 *
 * Two different empties (docs/DESIGN.md "An Empty Screen Teaches"): **Inbox
 * zero** — everything finished has been read (with "Show all") — and **nothing
 * has finished yet**, which explains what lands here and offers the next step
 * (`InboxEmpty`, shared with the phone view). Telling them apart while "Unread
 * only" is on takes one more count, asked only while the page is empty.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { notifyInboxChanged } from "@/lib/inbox";
import { hasThreadTab, workItemPath } from "@/lib/work-item-link";
import type { WorkItemView } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { EmptyState, StartWorkActions } from "@/components/ui/empty-state";
import { useEverFinished } from "@/hooks/useEverFinished";
import { CheckCircle2, XCircle, Inbox as InboxIcon, CheckCheck } from "lucide-react";

type WorkItem = WorkItemView;

const PAGE_SIZE = 20;

/** The detail route for a WorkItem: board tasks open their task page, standalone
 *  work opens its WorkDef page (comments/outcome live on the ref either way).
 *  Deep-links to the **Thread** tab since the inbox is about a completed run's
 *  outcome, which lives in the comments — except an auto-triage run, whose page
 *  *is* its analysis (docs/DESIGN.md "Auto Triage"), and a triage-mode external
 *  item's run, which opens that item's Triage tab ("External sources" — "Triage mode"). */
function refLink(item: WorkItem): string {
  return hasThreadTab(item) ? `${workItemPath(item)}?tab=thread` : workItemPath(item);
}

/** What the row says this work belonged to. */
function parentLabel(item: WorkItem): string {
  if (item.parent?.kind === "story") return item.parent.id;
  if (item.parent?.kind === "thought") return "auto triage";
  if (item.triage) return `triage · ${item.parent?.source ?? "external"}`;
  if (item.parent?.kind === "external") return item.parent.source ?? "external";
  return "scheduled/solitary";
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
  // Empty while "Unread only": all read (Inbox zero), or nothing ever finished?
  const everFinished = useEverFinished(!!data && items.length === 0 && unreadOnly);

  const markRead = async (id: string, read: boolean) => {
    await apiPost(`/api/work-items/${encodeURIComponent(id)}/read?read=${read}`, {});
    refetch();
    notifyInboxChanged();
  };

  const markAllRead = async () => {
    await Promise.all(items.filter(i => !i.read).map(i => apiPost(`/api/work-items/${encodeURIComponent(i.id)}/read`, {})));
    refetch();
    notifyInboxChanged();
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

      {data && items.length === 0 && (!unreadOnly || everFinished !== null) && (
        <InboxEmpty
          zero={unreadOnly && everFinished === true}
          onShowAll={() => { setUnreadOnly(false); setOffset(0); }}
        />
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

/**
 * The Inbox's empty states: **Inbox zero** (`zero` — everything's been read;
 * offers the read ones), or nothing has finished yet (offers starting work).
 * The phone view passes `desktopLinks={false}`: its only way to start work is
 * the chat.
 */
export function InboxEmpty({ zero, onShowAll, desktopLinks = true }: { zero: boolean; onShowAll: () => void; desktopLinks?: boolean }) {
  if (zero) {
    return (
      <EmptyState kind="inboxZero" icon={CheckCheck}>
        <Button variant="outline" size="sm" onClick={onShowAll}>Show read items</Button>
      </EmptyState>
    );
  }
  return (
    <EmptyState kind="inbox" icon={InboxIcon}><StartWorkActions desktopLinks={desktopLinks} /></EmptyState>
  );
}

function InboxRow({ item, onMarkRead }: { item: WorkItem; onMarkRead: (id: string, read: boolean) => void }) {
  const failed = item.state === "FAILED";
  const when = new Date(item.lastStateChangeAt).toLocaleString();

  return (
    <Link
      to={refLink(item)}
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
          {" · "}{parentLabel(item)}
        </p>
        {failed && item.error && (
          <p className="text-xs text-destructive mt-0.5 truncate" title={item.error}>
            Session error{item.attempt && item.attempt > 1 ? ` (attempt ${item.attempt})` : ""}: {item.error}
          </p>
        )}
      </div>
      {!item.read && <span className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1.5" />}
    </Link>
  );
}
