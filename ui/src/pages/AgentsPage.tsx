/**
 * AgentsPage — Agents panel showing connected agents with status,
 * host, heartbeat, and current task assignment.
 */

import { useApi, apiDelete } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bot, Wifi, WifiOff, Clock, FolderOpen, Server, Trash2 } from "lucide-react";
import { SpawnDialog } from "@/components/board/SpawnDialog";

interface Agent {
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

export function AgentsPage() {
  const { data, refetch } = useApi<{ agents: Agent[] }>("/api/agents", [], { pollInterval: 10_000 });
  const agents = data?.agents || [];

  const online = agents.filter(a => a.status !== "offline");
  const offline = agents.filter(a => a.status === "offline");

  async function dismissAgent(id: string) {
    await apiDelete(`/api/agents/${encodeURIComponent(id)}`);
    refetch();
  }

  async function dismissAllOffline() {
    await Promise.all(offline.map(a => apiDelete(`/api/agents/${encodeURIComponent(a.id)}`)));
    refetch();
  }

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5" />
          <h1 className="text-2xl font-bold">Agents</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            {online.length} online · {offline.length} offline
          </div>
          <SpawnDialog />
        </div>
      </div>

      {/* Online Agents */}
      {online.length > 0 && (
        <div className="space-y-2">
          {online.map(agent => (
            <AgentCard key={agent.id} agent={agent} onDismiss={dismissAgent} />
          ))}
        </div>
      )}

      {/* Offline Agents */}
      {offline.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Offline</h2>
            <Button variant="ghost" size="sm" className="text-xs text-red-600 hover:text-red-700" onClick={dismissAllOffline}>
              <Trash2 className="h-3 w-3 mr-1" />
              Dismiss all
            </Button>
          </div>
          {offline.map(agent => (
            <AgentCard key={agent.id} agent={agent} onDismiss={dismissAgent} />
          ))}
        </div>
      )}

      {agents.length === 0 && (
        <p className="text-center text-muted-foreground py-8">
          No agents registered. Spawn an agent from the Board page or register via the API.
        </p>
      )}
    </div>
  );
}

function AgentCard({ agent, onDismiss }: { agent: Agent; onDismiss?: (id: string) => void }) {
  const statusCfg = STATUS_CONFIG[agent.status] || STATUS_CONFIG.offline;
  const StatusIcon = statusCfg.icon;

  return (
    <Card className={agent.status === "offline" ? "opacity-60" : ""}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          {/* Status icon */}
          <StatusIcon className={`h-4 w-4 ${agent.status === "offline" ? "text-red-500" : "text-green-500"}`} />

          {/* Name & status badge */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate">{agent.name}</span>
              <Badge variant="secondary" className={`text-xs ${statusCfg.color}`}>
                {agent.status}
              </Badge>
              {agent.currentTask && (
                <Badge variant="outline" className="text-xs">
                  ⚙️ {agent.currentTask}
                </Badge>
              )}
            </div>

            {/* Details row */}
            <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground flex-wrap">
              {agent.hostId && (
                <span className="flex items-center gap-1">
                  <Server className="h-3 w-3" />
                  {agent.hostId}
                </span>
              )}
              <span className="flex items-center gap-1">
                <FolderOpen className="h-3 w-3" />
                <span className="truncate max-w-[200px]">{agent.capabilities?.directory ?? "—"}</span>
              </span>
              {agent.workMode === "assigned-story" && (
                <span className="flex items-center gap-1">
                  <Bot className="h-3 w-3" />
                  {agent.assignedStoryId}
                </span>
              )}
              {agent.capabilities && Object.keys(agent.capabilities).filter(k => k !== "directory").length > 0 && (
                <span className="truncate max-w-[200px]">
                  {Object.keys(agent.capabilities).filter(k => k !== "directory").join(", ")}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatHeartbeat(agent.lastHeartbeat)}
              </span>
            </div>
          </div>

          {/* Dismiss button */}
          {onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
              onClick={() => onDismiss(agent.id)}
              title="Remove this agent"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
