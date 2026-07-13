/**
 * TeammatesPage — Teammates panel showing connected teammates with status,
 * host, capabilities, heartbeat, and current task assignment.
 *
 * We settled on the term "Teammates" (not "Agents") throughout the UI since
 * the product is my-pizza-team. The route stays /team.
 */

import { useApi, apiDelete, apiPost } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Wifi, WifiOff, Clock, FolderOpen, Server, Trash2, RotateCcw } from "lucide-react";
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

const STATUS_CONFIG: Record<string, { color: string; icon: typeof Wifi }> = {
  idle: { color: "bg-muted text-muted-foreground", icon: Wifi },
  working: { color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200", icon: Wifi },
  pairing: { color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200", icon: Wifi },
  offline: { color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200", icon: WifiOff },
};

function formatHeartbeat(ts: number): string {
  const ago = Math.round((Date.now() - ts) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.round(ago / 60)}m ago`;
  return `${Math.round(ago / 3600)}h ago`;
}

export function TeammatesPage() {
  const { data, refetch } = useApi<{ agents: Teammate[] }>("/api/agents", [], { pollInterval: 10_000 });
  const teammates = data?.agents || [];

  const online = teammates.filter(a => a.status !== "offline");
  const offline = teammates.filter(a => a.status === "offline");

  async function dismissTeammate(id: string) {
    await apiDelete(`/api/agents/${encodeURIComponent(id)}`);
    refetch();
  }

  async function dismissAllOffline() {
    await Promise.all(offline.map(a => apiDelete(`/api/agents/${encodeURIComponent(a.id)}`)));
    refetch();
  }

  /**
   * Reset a teammate's session (clears its context window). We express this as
   * a `reset-session` leader directive targeting the teammate; the leader
   * realizes it as Pi's `/new` in the teammate's tmux window.
   */
  async function resetSession(teammate: Teammate) {
    if (!teammate.hostId) return;
    await apiPost(`/api/hosts/${encodeURIComponent(teammate.hostId)}/leader/directives`, {
      action: "reset-session",
      memberId: teammate.id,
    });
  }

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          <h1 className="text-2xl font-bold">Teammates</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            {online.length} online · {offline.length} offline
          </div>
          <SpawnDialog />
        </div>
      </div>

      {/* Online Teammates */}
      {online.length > 0 && (
        <div className="space-y-2">
          {online.map(teammate => (
            <TeammateCard key={teammate.id} teammate={teammate} onDismiss={dismissTeammate} onReset={resetSession} />
          ))}
        </div>
      )}

      {/* Offline Teammates */}
      {offline.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Offline</h2>
            <Button variant="ghost" size="sm" className="text-xs text-red-600 hover:text-red-700" onClick={dismissAllOffline}>
              <Trash2 className="h-3 w-3 mr-1" />
              Dismiss all
            </Button>
          </div>
          {offline.map(teammate => (
            <TeammateCard key={teammate.id} teammate={teammate} onDismiss={dismissTeammate} />
          ))}
        </div>
      )}

      {teammates.length === 0 && (
        <p className="text-center text-muted-foreground py-8">
          No teammates registered. Spawn one above or from the Board, or register via the API.
        </p>
      )}
    </div>
  );
}

function TeammateCard({
  teammate,
  onDismiss,
  onReset,
}: {
  teammate: Teammate;
  onDismiss?: (id: string) => void;
  onReset?: (teammate: Teammate) => void;
}) {
  const statusCfg = STATUS_CONFIG[teammate.status] || STATUS_CONFIG.offline;
  const StatusIcon = statusCfg.icon;

  // Split capabilities so the directory reads as one capability among many.
  const caps = teammate.capabilities || {};
  const directory = typeof caps[DIRECTORY_CAP] === "string" ? caps[DIRECTORY_CAP] : null;
  const otherCaps = Object.entries(caps).filter(([k]) => k !== DIRECTORY_CAP);

  return (
    <Card className={teammate.status === "offline" ? "opacity-60" : ""}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          {/* Status icon */}
          <StatusIcon className={`h-4 w-4 ${teammate.status === "offline" ? "text-red-500" : "text-green-500"}`} />

          {/* Name & status badge */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate">{teammate.name}</span>
              <Badge variant="secondary" className={`text-xs ${statusCfg.color}`}>
                {teammate.status}
              </Badge>
              {teammate.currentTask && (
                <Badge variant="outline" className="text-xs">
                  ⚙️ {teammate.currentTask}
                </Badge>
              )}
            </div>

            {/* Meta row: host, assigned story, heartbeat */}
            <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground flex-wrap">
              {teammate.hostId && (
                <span className="flex items-center gap-1">
                  <Server className="h-3 w-3" />
                  {teammate.hostId}
                </span>
              )}
              {teammate.workMode === "assigned-story" && teammate.assignedStoryId && (
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {teammate.assignedStoryId}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatHeartbeat(teammate.lastHeartbeat)}
              </span>
            </div>

            {/* Capabilities row: directory is just one capability among several */}
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="text-xs text-muted-foreground mr-0.5">Capabilities:</span>
              {directory && (
                <Badge variant="secondary" className="text-xs font-mono flex items-center gap-1">
                  <FolderOpen className="h-3 w-3" />
                  <span className="truncate max-w-[220px]">{directory}</span>
                </Badge>
              )}
              {otherCaps.map(([key, val]) => (
                <Badge key={key} variant="outline" className="text-xs font-mono">
                  {val ? `${key}: ${val}` : key}
                </Badge>
              ))}
              {!directory && otherCaps.length === 0 && (
                <span className="text-xs text-muted-foreground italic">none</span>
              )}
            </div>
          </div>

          {/* Actions: reset session, dismiss */}
          <div className="flex items-center gap-1 self-start">
            {onReset && teammate.hostId && teammate.status !== "offline" && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onReset(teammate)}
                title="Reset session (clears the teammate's context window)"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            )}
            {onDismiss && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                onClick={() => onDismiss(teammate.id)}
                title="Remove this teammate"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
