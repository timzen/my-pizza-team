/**
 * MobileInbox — The phone view's **Inbox** tab (`/m/inbox`): finished work
 * (COMPLETE / FAILED), unread by default.
 *
 * On the desktop a row opens the task's page, where the outcome is the last
 * comment of a long thread — too much for a phone. Here a row **opens in place**
 * and shows just that outcome: the closing `[done]` / `[failed]` comment the
 * teammate posted (lib/mobile.ts `inboxOutcome`), with **Open full** for the
 * whole page. Opening a row marks it read; rows you open stay on screen until
 * you leave or change the filter, even with "unread only" on
 * (lib/mobile.ts `mergeInboxRows`).
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/ui/markdown-view";
import { hasThreadTab, workItemPath, type LinkableWorkItem } from "@/lib/work-item-link";
import { since } from "@/lib/queue";
import { inboxOutcome, mergeInboxRows, outcomeBody } from "@/lib/mobile";
import { CheckCircle2, ExternalLink, Inbox as InboxIcon, XCircle } from "lucide-react";

interface WorkItem extends LinkableWorkItem {
  id: string;
  title: string;
  state: "COMPLETE" | "FAILED";
  read: boolean;
  memberId?: string | null;
  enqueuedAt: string;
  lastStateChangeAt: string;
}

interface Comment { from: string; body: string; at: string }

/** How many rows to show. A phone is for the latest; history is the desktop's. */
const LIMIT = 30;

export function MobileInbox({ active, onChanged }: { active: boolean; onChanged: () => void }) {
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  // Rows opened during this visit, kept on screen after they're marked read.
  const [retained, setRetained] = useState<WorkItem[]>([]);

  const params = new URLSearchParams({ state: "COMPLETE,FAILED", limit: String(LIMIT) });
  if (unreadOnly) params.set("read", "false");
  const { data, refetch } = useApi<{ items: WorkItem[]; total: number }>(`/api/work-items?${params}`, [unreadOnly], { pollInterval: 15_000 });

  // Leaving the tab ends the visit: forget the retained rows, close the open one.
  // (Adjusted during render, not in an effect, so there's no flash of stale rows.)
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) { setRetained([]); setOpenId(null); }
  }
  useEffect(() => { if (active) refetch(); }, [active, refetch]);

  const rows = mergeInboxRows(data?.items ?? [], retained);

  const markRead = async (item: WorkItem, read: boolean) => {
    await apiPost(`/api/work-items/${encodeURIComponent(item.id)}/read?read=${read}`, {});
    refetch();
    onChanged();
  };

  const toggleOpen = (item: WorkItem) => {
    if (openId === item.id) { setOpenId(null); return; }
    setOpenId(item.id);
    if (!item.read) {
      setRetained((prev) => [...prev.filter((r) => r.id !== item.id), { ...item, read: true }]);
      void markRead(item, true);
    }
  };

  const markAllRead = async () => {
    await Promise.all(rows.filter((r) => !r.read).map((r) => apiPost(`/api/work-items/${encodeURIComponent(r.id)}/read`, {})));
    refetch();
    onChanged();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => { setUnreadOnly(e.target.checked); setRetained([]); setOpenId(null); }} />
          Unread only
        </label>
        {rows.some((r) => !r.read) && <Button variant="ghost" size="sm" onClick={markAllRead}>Mark all read</Button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data && rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
            <InboxIcon className="h-8 w-8" />
            <p className="text-sm">{unreadOnly ? "Inbox zero — nothing to review." : "No finished work yet."}</p>
          </div>
        )}
        {rows.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            open={openId === item.id}
            onToggle={() => toggleOpen(item)}
            onMarkUnread={() => { setRetained((prev) => prev.filter((r) => r.id !== item.id)); setOpenId(null); void markRead(item, false); }}
          />
        ))}
        {(data?.total ?? 0) > LIMIT && (
          <p className="py-3 text-center text-xs text-muted-foreground">Showing the latest {LIMIT} of {data!.total} — older work is in the desktop Inbox.</p>
        )}
      </div>
    </div>
  );
}

function InboxRow({ item, open, onToggle, onMarkUnread }: {
  item: WorkItem;
  open: boolean;
  onToggle: () => void;
  onMarkUnread: () => void;
}) {
  const failed = item.state === "FAILED";
  return (
    <div className={`border-b border-border ${item.read ? "" : "bg-primary/5"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-3 py-2.5 text-left" aria-expanded={open}>
        {failed
          ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />}
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${open ? "" : "truncate"} ${item.read ? "" : "font-medium"}`}>{item.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {failed ? "Failed" : "Completed"}{item.memberId ? ` by ${item.memberId}` : ""} · {since(item.lastStateChangeAt)} ago
          </p>
        </div>
        {!item.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
      </button>
      {open && <Outcome item={item} onMarkUnread={onMarkUnread} />}
    </div>
  );
}

/** The opened row: the run's closing comment, and the ways out. */
function Outcome({ item, onMarkUnread }: { item: WorkItem; onMarkUnread: () => void }) {
  const { data } = useApi<{ comments: Comment[] }>(`/api/work-defs/${encodeURIComponent(item.ref.workDefId)}/comments`, [item.ref.workDefId]);
  const outcome = data ? inboxOutcome(data.comments, item) : null;
  const full = hasThreadTab(item) ? `${workItemPath(item)}?tab=thread` : workItemPath(item);

  return (
    <div className="space-y-2 px-3 pb-3 pl-10">
      {!data && <p className="text-xs text-muted-foreground">Loading…</p>}
      {data && !outcome && <p className="text-xs text-muted-foreground">No summary was posted for this run.</p>}
      {outcome && (
        <div className="max-h-96 overflow-y-auto rounded-md border border-border bg-background p-3">
          <MarkdownView content={outcomeBody(outcome.body)} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-7" render={<Link to={full} />}>
          <ExternalLink className="mr-1 h-3.5 w-3.5" />Open full
        </Button>
        <Button variant="ghost" size="sm" className="h-7" onClick={onMarkUnread}>Mark unread</Button>
      </div>
    </div>
  );
}
