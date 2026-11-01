/**
 * GeneralTab — Config → General (`/config`): the Work items feature toggles,
 * the Assistant card (chat mode + persona), Server, Scheduling, favorite
 * directories, and Autosave. Everything except the favorites and the
 * assistant's persona edits the page's config.json draft (ConfigPage), saved
 * with its Save Configuration button.
 */

import { useApi } from "@/hooks/useApi";
import type { ConfigData } from "@/lib/config-draft";
import { WorkItemFeatures } from "@/components/config/WorkItemFeatures";
import { AssistantChatModeSetting } from "@/components/config/AssistantSettings";
import { FavoriteDirectories } from "@/components/config/FavoriteDirectories";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The General tab's cards over the draft; `saved` is the daemon's last answer (for the feature locks). */
export function GeneralTab({ config, setConfig, saved, featureError }: {
  config: ConfigData;
  setConfig: (c: ConfigData) => void;
  saved: ConfigData | null;
  featureError: string | null;
}) {
  const update = (field: string, value: unknown) => {
    setConfig({ ...config, [field]: value });
  };
  // Fetched on mount (not read from the draft) so a workflow just created on
  // the Workflows tab is offered here without reloading the page.
  const { data: workflowList } = useApi<Array<{ name: string }>>("/api/workflows");
  const workflowNames = workflowList?.map((w) => w.name) ?? Object.keys(config.workflows);

  return (
    <div className="space-y-4">
      <WorkItemFeatures config={config} setConfig={setConfig} saved={saved} error={featureError} />

      <AssistantChatModeSetting config={config} setConfig={setConfig} />

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Server</h2>
          <div className="grid grid-cols-[120px_1fr] gap-3 items-center">
            <Label>Port</Label>
            <Input type="number" value={config.port} onChange={(e) => update("port", parseInt(e.target.value) || 9999)} className="max-w-[120px]" />
            <Label>Tmux Session</Label>
            <Input value={config.tmuxSession} onChange={(e) => update("tmuxSession", e.target.value)} className="max-w-[200px]" />
            <Label>Max Teammates</Label>
            <Input type="number" value={config.maxTeammates ?? 4} onChange={(e) => update("maxTeammates", parseInt(e.target.value) || 4)} className="max-w-[120px]" />
            {/* The declared pool size, applied at startup and reconciled
                continuously. Also editable live from the sidebar's team-size
                dialog. Blank = the default (half of Max Teammates), sent as
                `null` so saving clears an explicit value. */}
            <Label>Min Teammates</Label>
            <div className="space-y-1">
              <Input
                type="number"
                min={0}
                value={config.minTeammates ?? ""}
                placeholder={`${Math.floor((config.maxTeammates ?? 4) / 2)} (default)`}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  update("minTeammates", e.target.value === "" || Number.isNaN(n) ? null : Math.max(0, n));
                }}
                className="max-w-[160px]"
              />
              <p className="text-xs text-muted-foreground">
                Teammates the daemon keeps online (spawning replacements as needed). Blank = half of Max Teammates; 0 spawns none.
              </p>
            </div>
            <Label>Default Workflow</Label>
            <Select value={config.defaultWorkflow} onValueChange={(v) => update("defaultWorkflow", v)}>
              <SelectTrigger className="max-w-[200px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {workflowNames.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Scheduling</h2>
          <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
            <Label>Readiness Probe</Label>
            <Input
              value={config.readinessProbe || ""}
              onChange={(e) => update("readinessProbe", e.target.value || undefined)}
              placeholder="e.g. /path/to/check-creds.sh"
              className="max-w-[400px] font-mono text-xs"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Shell command run by the leader each heartbeat. Exit 0 = ready; non-zero = not ready (stdout = reason).
            Scheduled work is held while the host is not ready, then fires once on recovery.
          </p>
        </CardContent>
      </Card>

      {/* Favorites save immediately (own endpoint), not with the Save button. */}
      <FavoriteDirectories />

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Autosave</h2>
          <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
            <Label>Flush Interval (min)</Label>
            <Input
              type="number"
              value={config.autosave.flushIntervalMinutes}
              onChange={(e) => setConfig({ ...config, autosave: { ...config.autosave, flushIntervalMinutes: parseInt(e.target.value) || 30 } })}
              className="max-w-[120px]"
            />
            <Label>Commit Interval (hrs)</Label>
            <Input
              type="number"
              value={config.autosave.commitIntervalHours}
              onChange={(e) => setConfig({ ...config, autosave: { ...config.autosave, commitIntervalHours: parseInt(e.target.value) || 24 } })}
              className="max-w-[120px]"
            />
            <Label>Auto Commit</Label>
            <Select
              value={config.autosave.autoCommit ? "true" : "false"}
              onValueChange={(v) => setConfig({ ...config, autosave: { ...config.autosave, autoCommit: v === "true" } })}
            >
              <SelectTrigger className="max-w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="true">Yes</SelectItem>
                <SelectItem value="false">No</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
