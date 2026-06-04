/**
 * ConfigPage — View and (future) edit daemon configuration.
 */

import { useApi } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Settings } from "lucide-react";

interface ConfigData {
  port: number;
  tmuxSession: string;
  defaultWorkflow: string;
  workflows: Record<string, { states: string[]; transitions: Record<string, Record<string, string>> }>;
  autosave: { flushIntervalMinutes: number; commitIntervalHours: number; autoCommit: boolean };
  maxTeammates?: number;
  categories?: string[];
}

export function ConfigPage() {
  const { data, loading } = useApi<ConfigData>("/api/config");

  if (loading) return <div className="container mx-auto p-6 text-muted-foreground">Loading...</div>;
  if (!data) return <div className="container mx-auto p-6 text-muted-foreground">Cannot load config.</div>;

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Configuration</h1>
      </div>

      {/* General */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <h2 className="font-semibold">General</h2>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted-foreground">Port</span><span>{data.port}</span>
            <span className="text-muted-foreground">Tmux Session</span><span>{data.tmuxSession}</span>
            <span className="text-muted-foreground">Max Teammates</span><span>{data.maxTeammates ?? "unlimited"}</span>
            <span className="text-muted-foreground">Default Workflow</span><span>{data.defaultWorkflow}</span>
          </div>
        </CardContent>
      </Card>

      {/* Autosave */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <h2 className="font-semibold">Autosave</h2>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted-foreground">Flush Interval</span><span>{data.autosave.flushIntervalMinutes} min</span>
            <span className="text-muted-foreground">Commit Interval</span><span>{data.autosave.commitIntervalHours} hr</span>
            <span className="text-muted-foreground">Auto Commit</span><span>{data.autosave.autoCommit ? "Yes" : "No"}</span>
          </div>
        </CardContent>
      </Card>

      {/* Workflows */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Workflows</h2>
          {Object.entries(data.workflows).map(([name, wf]) => (
            <div key={name} className="border border-border rounded p-3">
              <p className="font-medium text-sm mb-2">{name} {name === data.defaultWorkflow && <Badge variant="secondary" className="text-xs ml-1">default</Badge>}</p>
              <div className="flex gap-1 flex-wrap mb-2">
                {wf.states.map(s => <Badge key={s} variant="outline" className="text-xs">{s}</Badge>)}
              </div>
              <div className="text-xs text-muted-foreground">
                {Object.entries(wf.transitions).map(([from, targets]) => (
                  <div key={from}>{from} → {Object.entries(targets).map(([to, perm]) => `${to} (${perm})`).join(", ")}</div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Categories */}
      {data.categories && data.categories.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h2 className="font-semibold mb-2">Memory Categories</h2>
            <div className="flex gap-1 flex-wrap">
              {data.categories.map(c => <Badge key={c} variant="secondary">{c}</Badge>)}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
