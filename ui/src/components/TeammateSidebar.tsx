/**
 * TeammateSidebar — Persistent right-hand column listing connected teammates.
 *
 * Shown on every page so the team is always visible. Condensed per-teammate
 * rows (status, name, current task, capabilities) with per-teammate reset /
 * dismiss actions, plus a Spawn button at the top. Polls /api/agents.
 */

import { useApi, apiDelete, apiPost } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { Trash2, RotateCcw, FolderOpen } from "lucide-react";
import { SpawnDialog } from "@/components/board/SpawnDialog";

/** Well-known capability key for a teammate's working directory. */
const DIRECTORY_CAP = "directory";

interface Teammate {
  id: string;
  name: string;
  capabilities: Record<string, string | null>;
  workMode: string;
  assignedStoryId?: string;
  hostId?: string;
  status: string;
  currentTask: string | null;
  lastHeartbeat: number;
}

const DOT: Record<string, string> = {
  idle: "bg-muted-foreground/50",
  working: "bg-green-500",
  pairing: "bg-blue-500",
  offline: "bg-red-500",
};

export function TeammateSidebar() {
  const { data, refetch } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10_000 });
  const teammates = data?.agents || [];
  const online = teammates.filter((a) => a.status !== "offline");
  const offline = teammates.filter((a) => a.status === "offline");

  const dismiss = async (id: string) => {
    await apiDelete(`/api/agents/${encodeURIComponent(id)}`);
    refetch();
  };

  // Reset a teammate's session (clears its context window) via a leader
  // directive the leader realizes as Pi's `/new` in the teammate's window.
  const reset = async (t: Teammate) => {
    if (!t.hostId) return;
    await apiPost(`/api/hosts/${encodeURIComponent(t.hostId)}/leader/directives`, { action: "reset-session", memberId: t.id });
  };

  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-l border-border bg-muted/30">
      <div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold">
          Teammates <span className="text-muted-foreground font-normal">({online.length})</span>
        </h2>
        <SpawnDialog onSpawned={refetch} />
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {online.map((t) => (
          <TeammateRow key={t.id} teammate={t} onDismiss={dismiss} onReset={reset} />
        ))}

        {offline.length > 0 && (
          <div className="pt-2">
            <p className="px-1 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Offline</p>
            {offline.map((t) => (
              <TeammateRow key={t.id} teammate={t} onDismiss={dismiss} />
            ))}
          </div>
        )}

        {teammates.length === 0 && (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No teammates yet. Spawn one above.
          </p>
        )}
      </div>
    </aside>
  );
}

function TeammateRow({
  teammate,
  onDismiss,
  onReset,
}: {
  teammate: Teammate;
  onDismiss: (id: string) => void;
  onReset?: (t: Teammate) => void;
}) {
  const caps = teammate.capabilities || {};
  const directory = typeof caps[DIRECTORY_CAP] === "string" ? (caps[DIRECTORY_CAP] as string) : null;
  const dirName = directory ? directory.split("/").filter(Boolean).pop() : null;
  const otherCaps = Object.entries(caps).filter(([k]) => k !== DIRECTORY_CAP);

  return (
    <div className={`group rounded-md border border-border bg-background p-2.5 ${teammate.status === "offline" ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full shrink-0 ${DOT[teammate.status] || DOT.offline}`} title={teammate.status} />
        <span className="font-medium text-sm truncate flex-1">{teammate.name}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onReset && teammate.hostId && (
            <button onClick={() => onReset(teammate)} className="text-muted-foreground hover:text-foreground p-0.5" title="Reset session (clears context window)">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button onClick={() => onDismiss(teammate.id)} className="text-muted-foreground hover:text-destructive p-0.5" title="Dismiss teammate">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {teammate.currentTask && (
        <p className="text-xs text-muted-foreground mt-1 truncate" title={teammate.currentTask}>⚙️ {teammate.currentTask}</p>
      )}

      {(dirName || otherCaps.length > 0) && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          {dirName && (
            <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1 max-w-full" title={directory ?? undefined}>
              <FolderOpen className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{dirName}</span>
            </Badge>
          )}
          {otherCaps.map(([k, v]) => (
            <Badge key={k} variant="outline" className="text-[10px] font-mono">{v ? `${k}: ${v}` : k}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}
