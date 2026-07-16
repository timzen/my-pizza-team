/**
 * TeammateSidebar — Persistent right-hand column listing connected teammates.
 *
 * Shown on every page so the team is always visible. Can be expanded (full
 * rows: status, name, current task, capabilities, reset/dismiss actions) or
 * collapsed to a slim icon rail (status avatars + a Spawn "+" at the top). The
 * collapsed/expanded choice is remembered in localStorage. Polls /api/agents.
 *
 * Also surfaces pending spawn requests (/api/spawn-requests) — spawn directives
 * no leader has realized/acked yet — so a stuck request is visible and can be
 * cancelled before it drives the leader to retry indefinitely.
 */

import { useState } from "react";
import { useApi, apiDelete, apiPost } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, RotateCcw, FolderOpen, PanelRightClose, PanelRightOpen, Clock, X } from "lucide-react";
import { SpawnDialog } from "@/components/board/SpawnDialog";

/** Well-known capability key for a teammate's working directory. */
const DIRECTORY_CAP = "directory";
const COLLAPSE_KEY = "mpt.teammateSidebar.collapsed";

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

/** A pending spawn request the leader hasn't realized/acked yet. */
interface SpawnRequest {
  id: string;
  hostId: string;
  name: string | null;
  cwd: string | null;
  createdAt: string;
}

export function TeammateSidebar() {
  const { data, refetch } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: spawnData, refetch: refetchSpawns } = useApi<{ requests: SpawnRequest[] }>("/api/spawn-requests", [], { pollInterval: 10_000 });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");

  const teammates = data?.agents || [];
  const online = teammates.filter((a) => a.status !== "offline");
  const offline = teammates.filter((a) => a.status === "offline");
  const pendingSpawns = spawnData?.requests || [];

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

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

  // Cancel a stuck spawn request so the leader stops retrying it.
  const cancelSpawn = async (id: string) => {
    await apiDelete(`/api/spawn-requests/${encodeURIComponent(id)}`);
    refetchSpawns();
  };

  // ─── Collapsed: slim icon rail ─────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="hidden lg:flex w-14 shrink-0 flex-col items-center border-l border-border bg-muted/30">
        <div className="h-14 flex items-center justify-center border-b border-border w-full shrink-0">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggle} title="Expand teammates">
            <PanelRightOpen className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto py-3 flex flex-col items-center gap-2 w-full">
          <SpawnDialog onSpawned={() => { refetch(); refetchSpawns(); }} compact />
          {pendingSpawns.length > 0 && (
            <div
              className="relative flex items-center justify-center h-6 w-6 text-muted-foreground"
              title={`${pendingSpawns.length} pending spawn request${pendingSpawns.length === 1 ? "" : "s"}`}
            >
              <Clock className="h-4 w-4 animate-pulse" />
              <span className="absolute -top-1 -right-1 min-w-3.5 h-3.5 px-0.5 rounded-full bg-amber-500 text-[9px] leading-[14px] text-white text-center">
                {pendingSpawns.length}
              </span>
            </div>
          )}
          <div className="h-px w-6 bg-border my-1" />
          {online.map((t) => (
            <TeammateAvatar key={t.id} teammate={t} />
          ))}
          {offline.map((t) => (
            <TeammateAvatar key={t.id} teammate={t} />
          ))}
        </div>
      </aside>
    );
  }

  // ─── Expanded: full rows ───────────────────────────────────────────
  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-l border-border bg-muted/30">
      <div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold">
          Teammates <span className="text-muted-foreground font-normal">({online.length})</span>
        </h2>
        <div className="flex items-center gap-1">
          <SpawnDialog onSpawned={() => { refetch(); refetchSpawns(); }} />
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggle} title="Collapse teammates">
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {pendingSpawns.length > 0 && (
          <div className="pb-1">
            <p className="px-1 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Pending spawns ({pendingSpawns.length})
            </p>
            {pendingSpawns.map((s) => (
              <SpawnRequestRow key={s.id} request={s} onCancel={cancelSpawn} />
            ))}
          </div>
        )}
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

/** A status-colored circle with the teammate's initial (collapsed rail). */
function TeammateAvatar({ teammate }: { teammate: Teammate }) {
  const title = `${teammate.name} · ${teammate.status}${teammate.currentTask ? ` · ⚙️ ${teammate.currentTask}` : ""}`;
  return (
    <div className="relative" title={title}>
      <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-medium uppercase bg-background border border-border ${teammate.status === "offline" ? "opacity-50" : ""}`}>
        {teammate.name.charAt(0)}
      </div>
      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-muted/30 ${DOT[teammate.status] || DOT.offline}`} />
    </div>
  );
}

/** A pending spawn request row with a cancel button (expanded sidebar). */
function SpawnRequestRow({ request, onCancel }: { request: SpawnRequest; onCancel: (id: string) => void }) {
  const dirName = request.cwd ? request.cwd.split("/").filter(Boolean).pop() : null;
  return (
    <div className="group rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-2.5">
      <div className="flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 shrink-0 text-amber-500 animate-pulse" />
        <span className="font-medium text-sm truncate flex-1">{request.name || "(unnamed)"}</span>
        <button
          onClick={() => onCancel(request.id)}
          className="text-muted-foreground hover:text-destructive p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Cancel spawn request"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground mt-1">pending · no leader has picked this up</p>
      {(dirName || request.cwd) && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1 max-w-full" title={request.cwd ?? undefined}>
            <FolderOpen className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{dirName || request.cwd}</span>
          </Badge>
        </div>
      )}
    </div>
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
