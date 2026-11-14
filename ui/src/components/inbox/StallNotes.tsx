/**
 * StallNotes — The Inbox's stalled-teammate notes (daemon/stall-notes.ts;
 * docs/DESIGN.md "Stalled Teammates"): **one note per stall episode** — a
 * teammate alive and working, but with no progress for longer than its
 * threshold — never one per check, however long it stays stalled.
 *
 * Each says who, on what (the tool and its preview), since when, and links to
 * the teammate's page (where Interrupt and Pair are) and to the work item.
 * Once progress resumes the note reads "(over)" — resolved, like a failover
 * note's end; it is not marked unread again, since a stall that cleared asks
 * nothing more. Like an Inbox row a note is unread until marked read
 * (`POST /api/stalls/notes/:id/read`); unread notes count toward the Inbox
 * badge (`/api/status` `unreadInboxCount`), so `onChanged` lets the host
 * refresh it. Renders nothing when there are none to show.
 *
 * Shown above the finished work on the desktop Inbox (pages/InboxPage) and the
 * phone's (mobile/MobileInbox, whose teammate links go to `/m/teammates/:id`
 * via `teammatePath`).
 */

import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import type { StallNoteView, StallNotesResponse } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { stallActivityText } from "@/lib/stall";
import { workItemPath } from "@/lib/work-item-link";

const time = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The desktop teammate page. */
const desktopTeammatePath = (id: string) => `/teammates/${encodeURIComponent(id)}`;

export function StallNotes({ unreadOnly, onChanged, teammatePath = desktopTeammatePath }: {
  unreadOnly: boolean;
  onChanged: () => void;
  /** Where a teammate's link goes (the phone view's own route on `/m`). */
  teammatePath?: (memberId: string) => string;
}) {
  const { data, refetch } = useApi<StallNotesResponse>(`/api/stalls/notes${unreadOnly ? "?read=false" : ""}`, [unreadOnly], { pollInterval: 15_000 });
  const notes = data?.notes ?? [];
  if (notes.length === 0) return null;

  const markRead = async (note: StallNoteView, read: boolean) => {
    await apiPost(`/api/stalls/notes/${encodeURIComponent(note.id)}/read?read=${read}`, {});
    refetch();
    onChanged();
  };

  return (
    <ul className="space-y-2" aria-label="Stalled teammate notes">
      {notes.map((note) => (
        <li key={note.id} className={`flex items-start gap-3 rounded-md border p-3 ${note.read || note.ended ? "border-border bg-background" : "border-amber-500/40 bg-amber-500/5"}`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className={`text-sm ${note.read ? "" : "font-medium"}`}>
              <Link to={teammatePath(note.memberId)} className="underline-offset-2 hover:underline">{note.memberName}</Link>
              {" "}stalled {note.ended ? "(over)" : "(still stalled)"}
              {!note.read && <span className="sr-only"> (unread)</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              No progress since <time dateTime={note.since}>{time(note.since)}</time>
              {" "}(threshold {note.stallMinutes}m): <span className="font-mono">{stallActivityText(note.activity)}</span>
              {note.ended && note.endedAt && <> · over by <time dateTime={note.endedAt}>{time(note.endedAt)}</time></>}
            </p>
            {note.workDefId && (
              <Link to={workItemPath({ ref: { workDefId: note.workDefId }, parent: note.parent })} className="block truncate text-xs text-primary hover:underline">
                ⚙️ {note.workItemTitle ?? note.workItemId}
              </Link>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { void markRead(note, !note.read); }}>
            {note.read ? "Mark unread" : "Mark read"}
          </Button>
        </li>
      ))}
    </ul>
  );
}
