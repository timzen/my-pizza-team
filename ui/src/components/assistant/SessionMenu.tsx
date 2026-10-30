/**
 * SessionMenu — session history: browse, resume, snapshot, start a new chat.
 *
 * Chat v2 never deletes a conversation. Ending one (new chat, persona swap,
 * resume of another) snapshots it to `<teamDir>/assistant/sessions/<id>.md`, and
 * resuming switches the agent's Pi session back to it so in-agent context comes
 * along (docs/DESIGN.md "Assistant Chat Model"). Sessions without a recorded Pi session
 * file can still be read, but not truly resumed — the list says so. Each
 * session names the persona it ran as, linked to it on Config → Personas
 * (unlinked and marked "deleted" once the persona is gone).
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { usePersonas } from "@/hooks/usePersonas";
import { personaPath } from "@/lib/personas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { History, RotateCcw, SquarePen, Eye, FileText } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-types";

interface SessionMenuProps {
  /** The session currently being viewed (null = the active one). */
  viewingId: string | null;
  /** View a session's transcript without resuming it. */
  onView: (sessionId: string | null) => void;
  /** Called after a new chat / resume, so the page can refresh. */
  onChanged: () => void;
  /** Icon-only buttons, for the narrow dock header. */
  compact?: boolean;
}

export function SessionMenu({ viewingId, onView, onChanged, compact }: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, refetch } = useApi<{ sessions: AssistantSession[] }>("/api/assistant/sessions", [], { pollInterval: open ? 5000 : undefined });
  const sessions = data?.sessions || [];
  const library = usePersonas();

  const newChat = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiPost("/api/assistant/sessions/new");
      onView(null);
      onChanged();
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const resume = async (session: AssistantSession) => {
    if (busy) return;
    setBusy(true);
    try {
      await apiPost(`/api/assistant/sessions/${encodeURIComponent(session.id)}/resume`);
      onView(null);
      onChanged();
      await refetch();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size={compact ? "icon" : "sm"}
        className={compact ? "h-8 w-8" : undefined}
        onClick={newChat}
        disabled={busy}
        title="New chat (snapshots the current one first)"
      >
        <SquarePen className={compact ? "h-4 w-4" : "h-4 w-4 mr-1"} />{!compact && "New chat"}
      </Button>
      <Button
        variant="ghost"
        size={compact ? "icon" : "sm"}
        className={compact ? "h-8 w-8" : undefined}
        onClick={() => setOpen(true)}
        title="Session history"
      >
        <History className={compact ? "h-4 w-4" : "h-4 w-4 mr-1"} />{!compact && "History"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Chat history</DialogTitle>
            <DialogDescription>
              Every session is kept as a markdown snapshot. Resuming restores the assistant's context too.
            </DialogDescription>
          </DialogHeader>

          {sessions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No sessions yet.</p>
          ) : (
            <div className="grid gap-2 max-h-[60vh] overflow-y-auto">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`rounded-md border p-3 ${s.id === viewingId ? "border-primary/60 bg-accent/40" : "border-border"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {s.title || "(untitled)"}
                        {s.status === "active" && <span className="ml-2 text-xs text-primary">active</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {new Date(s.startedAt).toLocaleString()} · {s.messageCount} messages
                        {" · "}<SessionPersona session={s} library={library} onOpen={() => setOpen(false)} />
                        {!s.piSessionPath && " · context not restorable"}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" title="View transcript" onClick={() => { onView(s.status === "active" ? null : s.id); setOpen(false); }}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" title="Open markdown snapshot" onClick={() => window.open(`/api/assistant/sessions/${encodeURIComponent(s.id)}/snapshot`, "_blank")}>
                        <FileText className="h-4 w-4" />
                      </Button>
                      {s.status !== "active" && (
                        <Button variant="outline" size="sm" disabled={busy} title="Resume this session" onClick={() => resume(s)}>
                          <RotateCcw className="h-4 w-4 mr-1" />Resume
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The persona a session ran as: linked to it, or "default" (the built-in), or marked deleted. */
function SessionPersona({ session, library, onOpen }: {
  session: AssistantSession;
  library: Array<{ id: string }> | null;
  onOpen: () => void;
}) {
  const id = session.personaId ?? "builtin:assistant";
  const title = session.personaId ? session.personaTitle ?? session.personaId : "default";
  if (library && !library.some((p) => p.id === id)) return <span title="This persona has since been deleted">{title} (deleted)</span>;
  return <Link to={personaPath(id)} onClick={onOpen} className="hover:underline">{title}</Link>;
}
