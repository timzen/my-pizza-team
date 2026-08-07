/**
 * TeammateSidebar — Persistent right-hand column: the team and the live queue.
 *
 * Two stacked sections, always visible so the team's state is glanceable:
 *
 *  1. **Team** — the connected agents, grouped by role. The leader `[L]` and
 *     assistant `[A]` are singletons; teammates `[Tn]` are the generalist pool.
 *     Each row shows status, name, current work, and its working directory
 *     (the only work-selection signal — no capability badges). Actions: reset
 *     session, dismiss.
 *  2. **Queue** — the non-terminal WorkItems (READY / IN_PROGRESS / MORIBUND)
 *     with recovery actions: cancel a READY item, or force-fail a MORIBUND one
 *     (optionally re-enqueuing a fresh attempt). Terminal items are reviewed in
 *     the Inbox, not here.
 *
 * Also surfaces pending spawn requests (/api/spawn-requests). Collapsible to a
 * slim icon rail (choice remembered in localStorage). Polls the daemon.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, apiDelete, apiPost } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, RotateCcw, FolderOpen, PanelRightClose, PanelRightOpen, Clock, X, UserPlus, Crown, Bot, User, Ban, AlertTriangle } from "lucide-react";

const COLLAPSE_KEY = "mpt.teammateSidebar.collapsed";

type Role = "leader" | "assistant" | "teammate";

interface Teammate {
  id: string;
  name: string;
  directory?: string | null;
  hostId?: string;
  status: string;
  /** taskId of the WorkItem this agent currently holds, if any. */
  currentWork?: string | null;
  lastHeartbeat: number;
}

type WorkItemState = "READY" | "IN_PROGRESS" | "MORIBUND" | "COMPLETE" | "FAILED" | "CANCELED";

interface WorkItem {
  id: string;
  title: string;
  state: WorkItemState;
  memberId?: string | null;
  directory?: string | null;
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

/** Classify an agent by name convention (leader / assistant / teammate). */
function roleOf(t: Teammate): Role {
  const n = t.name.toLowerCase();
  if (n.includes("leader")) return "leader";
  if (n.includes("assistant")) return "assistant";
  return "teammate";
}

export function TeammateSidebar() {
  const { data, refetch } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10_000 });
  const { data: spawnData, refetch: refetchSpawns } = useApi<{ requests: SpawnRequest[] }>("/api/spawn-requests", [], { pollInterval: 10_000 });
  const { data: queueData, refetch: refetchQueue } = useApi<{ items: WorkItem[]; total: number }>(
    "/api/work-items?state=READY,IN_PROGRESS,MORIBUND", [], { pollInterval: 5000 }
  );
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");

  const teammates = data?.agents || [];
  const online = teammates.filter((a) => a.status !== "offline");
  const offline = teammates.filter((a) => a.status === "offline");
  const pendingSpawns = spawnData?.requests || [];
  const queue = queueData?.items || [];

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  const dismiss = async (id: string) => {
    // `?dismiss=true` tombstones the id so the agent actually shuts down (a plain
    // DELETE would just remove it, and the agent would re-register on its next
    // heartbeat, treating it like a daemon restart).
    await apiDelete(`/api/agents/${encodeURIComponent(id)}?dismiss=true`);
    refetch();
  };

  // Reset a teammate's session (clears its context window) via a leader
  // directive the leader realizes as Pi's `/new` in the teammate's window.
  const reset = async (t: Teammate) => {
    if (!t.hostId) return;
    await apiPost(`/api/hosts/${encodeURIComponent(t.hostId)}/leader/directives`, { action: "reset-session", memberId: t.id });
  };

  const cancelSpawn = async (id: string) => {
    await apiDelete(`/api/spawn-requests/${encodeURIComponent(id)}`);
    refetchSpawns();
  };

  // Queue recovery actions (see docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md).
  const cancelItem = async (id: string) => {
    await apiPost(`/api/work-items/${encodeURIComponent(id)}/cancel`, {});
    refetchQueue();
  };
  const forceFail = async (id: string, reEnqueue: boolean) => {
    await apiPost(`/api/work-items/${encodeURIComponent(id)}/force-fail`, { reEnqueue });
    refetchQueue();
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
          <Button variant="outline" size="icon" className="h-8 w-8" title="Spawn teammate" render={<Link to="/spawn" />}>
            <UserPlus className="h-4 w-4" />
          </Button>
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
          {queue.length > 0 && (
            <>
              <div className="h-px w-6 bg-border my-1" />
              <div className="relative flex items-center justify-center h-6 w-6 text-muted-foreground" title={`${queue.length} item${queue.length === 1 ? "" : "s"} in the queue`}>
                <Clock className="h-4 w-4" />
                <span className="absolute -top-1 -right-1 min-w-3.5 h-3.5 px-0.5 rounded-full bg-primary text-[9px] leading-[14px] text-white text-center">{queue.length}</span>
              </div>
            </>
          )}
        </div>
      </aside>
    );
  }

  // ─── Expanded: full rows ───────────────────────────────────────────
  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-l border-border bg-muted/30">
      <div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold">
          Team <span className="text-muted-foreground font-normal">({online.length})</span>
        </h2>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" render={<Link to="/spawn" />}>
            <UserPlus className="h-4 w-4 mr-1" /> Spawn
          </Button>
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

        {/* Live queue: non-terminal WorkItems + recovery actions. */}
        <div className="pt-3 mt-1 border-t border-border">
          <p className="px-1 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Queue ({queue.length})
          </p>
          {queue.length === 0 && (
            <p className="px-1 text-xs text-muted-foreground">Nothing queued or in flight.</p>
          )}
          {queue.map((wi) => (
            <QueueRow key={wi.id} item={wi} onCancel={cancelItem} onForceFail={forceFail} />
          ))}
        </div>
      </div>
    </aside>
  );
}

/** Role icon for the collapsed rail / row prefix. */
function RoleIcon({ role, className }: { role: Role; className?: string }) {
  if (role === "leader") return <Crown className={className} />;
  if (role === "assistant") return <Bot className={className} />;
  return <User className={className} />;
}

/** A status-colored circle with a role icon (collapsed rail). */
function TeammateAvatar({ teammate }: { teammate: Teammate }) {
  const role = roleOf(teammate);
  const title = `${teammate.name} · ${teammate.status}${teammate.currentWork ? ` · ⚙️ ${teammate.currentWork}` : ""}`;
  return (
    <div className="relative" title={title}>
      <div className={`h-8 w-8 rounded-full flex items-center justify-center bg-background border border-border ${teammate.status === "offline" ? "opacity-50" : ""}`}>
        <RoleIcon role={role} className="h-4 w-4" />
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
  const role = roleOf(teammate);
  const directory = teammate.directory || null;
  const dirName = directory ? directory.split("/").filter(Boolean).pop() : null;

  return (
    <div className={`group rounded-md border border-border bg-background p-2.5 ${teammate.status === "offline" ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full shrink-0 ${DOT[teammate.status] || DOT.offline}`} title={teammate.status} />
        <RoleIcon role={role} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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

      {teammate.currentWork && (
        <p className="text-xs text-muted-foreground mt-1 truncate" title={teammate.currentWork}>⚙️ {teammate.currentWork}</p>
      )}

      {dirName && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1 max-w-full" title={directory ?? undefined}>
            <FolderOpen className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{dirName}</span>
          </Badge>
        </div>
      )}
    </div>
  );
}

const QUEUE_CHIP: Record<string, { label: string; cls: string }> = {
  READY: { label: "queued", cls: "text-muted-foreground" },
  IN_PROGRESS: { label: "working", cls: "text-green-600 border-green-500/50" },
  MORIBUND: { label: "at risk", cls: "text-amber-600 border-amber-500/50" },
};

/** A non-terminal WorkItem with state-appropriate recovery actions. */
function QueueRow({
  item,
  onCancel,
  onForceFail,
}: {
  item: WorkItem;
  onCancel: (id: string) => void;
  onForceFail: (id: string, reEnqueue: boolean) => void;
}) {
  const chip = QUEUE_CHIP[item.state] || QUEUE_CHIP.READY!;
  return (
    <div className="group rounded-md border border-border bg-background p-2.5 mb-2">
      <div className="flex items-center gap-2">
        {item.state === "MORIBUND" && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
        <span className="text-sm truncate flex-1" title={item.title}>{item.title}</span>
        <Badge variant="outline" className={`text-[10px] px-1 py-0 shrink-0 ${chip.cls}`}>{chip.label}</Badge>
      </div>
      {item.memberId && (
        <p className="text-[11px] text-muted-foreground mt-1 truncate">held by {item.memberId}</p>
      )}
      <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {item.state === "READY" && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onCancel(item.id)} title="Cancel this queued item">
            <Ban className="h-3 w-3 mr-1" />Cancel
          </Button>
        )}
        {item.state === "MORIBUND" && (
          <>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onForceFail(item.id, false)} title="Force this abandoned item to FAILED">
              <X className="h-3 w-3 mr-1" />Force-fail
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onForceFail(item.id, true)} title="Force-fail and enqueue a fresh attempt">
              <RotateCcw className="h-3 w-3 mr-1" />Re-enqueue
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
