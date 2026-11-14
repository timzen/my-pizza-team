/**
 * FailoverNotes — The Inbox's model-failover notes (daemon/failover-notes.ts;
 * docs/DESIGN.md "Model Failover"): **one note per failover episode**, never
 * one per agent, with a line for each thing that happened in it — tripped,
 * escalated, the chain exhausted, reverted or ended.
 *
 * Shown above the finished work on the desktop Inbox (pages/InboxPage) and the
 * phone's (mobile/MobileInbox). Like an Inbox row a note is unread until it's
 * marked read (`POST /api/failover/notes/:id/read`); a new line in its episode
 * marks it unread again. Unread notes count toward the Inbox badge
 * (`/api/status` `unreadInboxCount`), so `onChanged` lets the host refresh it.
 * Renders nothing when there are none to show.
 */

import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import type { FailoverNoteView, FailoverNotesResponse } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { ArrowRightLeft } from "lucide-react";

export function FailoverNotes({ unreadOnly, onChanged, settingsLink = true }: { unreadOnly: boolean; onChanged: () => void; settingsLink?: boolean }) {
  const { data, refetch } = useApi<FailoverNotesResponse>(`/api/failover/notes${unreadOnly ? "?read=false" : ""}`, [unreadOnly], { pollInterval: 15_000 });
  const notes = data?.notes ?? [];
  if (notes.length === 0) return null;

  const markRead = async (note: FailoverNoteView, read: boolean) => {
    await apiPost(`/api/failover/notes/${encodeURIComponent(note.id)}/read?read=${read}`, {});
    refetch();
    onChanged();
  };

  return (
    <ul className="space-y-2" aria-label="Model failover notes">
      {notes.map((note) => (
        <li key={note.id} className={`flex items-start gap-3 rounded-md border p-3 ${note.read ? "border-border bg-background" : "border-amber-500/40 bg-amber-500/5"}`}>
          <ArrowRightLeft className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className={`text-sm ${note.read ? "" : "font-medium"}`}>
              Model failover {note.ended ? "(over)" : "(in effect)"}
              {!note.read && <span className="sr-only"> (unread)</span>}
            </p>
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {note.lines.map((l, i) => (
                <li key={i}>
                  <time dateTime={l.at}>{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> · {l.text}
                </li>
              ))}
            </ul>
            {settingsLink && <Link to="/config/models" className="text-xs underline text-muted-foreground">Failover settings</Link>}
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { void markRead(note, !note.read); }}>
            {note.read ? "Mark unread" : "Mark read"}
          </Button>
        </li>
      ))}
    </ul>
  );
}
