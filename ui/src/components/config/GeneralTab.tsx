/**
 * GeneralTab — Config → General (`/config`): the Work items feature toggles,
 * the Assistant card (chat mode + persona), Server, Scheduling (the readiness
 * probe and the agent env file), favorite directories, and Autosave.
 * Everything except the favorites and the assistant's persona edits the page's
 * config.json draft (ConfigPage), saved with its Save Configuration button. Its non-obvious fields carry their
 * one-line hints (components/ui/field-hint; copy in lib/field-help.ts).
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
import { FieldHint } from "@/components/ui/field-hint";

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
            <Label htmlFor="config-port">Port</Label>
            <Input id="config-port" type="number" value={config.port} onChange={(e) => update("port", parseInt(e.target.value) || 9999)} className="max-w-[120px]" />
            <Label htmlFor="config-tmux-session">Tmux Session</Label>
            <div className="space-y-1">
              <Input id="config-tmux-session" value={config.tmuxSession} onChange={(e) => update("tmuxSession", e.target.value)} className="max-w-[200px]" aria-describedby="config-tmux-session-hint" />
              <FieldHint id="config-tmux-session-hint" field="tmuxSession" />
            </div>
            <Label htmlFor="config-max-teammates">Max Teammates</Label>
            <div className="space-y-1">
              <Input id="config-max-teammates" type="number" value={config.maxTeammates ?? 4} onChange={(e) => update("maxTeammates", parseInt(e.target.value) || 4)} className="max-w-[120px]" aria-describedby="config-max-teammates-hint" />
              <FieldHint id="config-max-teammates-hint" field="maxTeammates" />
            </div>
            {/* The declared pool size, applied at startup and reconciled
                continuously. Also editable live from the sidebar's team-size
                dialog. Blank = the default (half of Max Teammates), sent as
                `null` so saving clears an explicit value. */}
            <Label htmlFor="config-min-teammates">Min Teammates</Label>
            <div className="space-y-1">
              <Input
                id="config-min-teammates"
                aria-describedby="config-min-teammates-hint"
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
              <FieldHint id="config-min-teammates-hint" field="minTeammates" />
            </div>
            <Label id="config-default-workflow">Default Workflow</Label>
            <div className="space-y-1">
              <Select value={config.defaultWorkflow} onValueChange={(v) => update("defaultWorkflow", v)}>
                <SelectTrigger className="max-w-[200px]" aria-labelledby="config-default-workflow" aria-describedby="config-default-workflow-hint"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {workflowNames.map((n) => (
                    <SelectItem key={n} value={n}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint id="config-default-workflow-hint" field="defaultWorkflow" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Scheduling</h2>
          <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
            <Label htmlFor="config-readiness-probe">Readiness Probe</Label>
            <Input
              id="config-readiness-probe"
              value={config.readinessProbe || ""}
              onChange={(e) => update("readinessProbe", e.target.value || undefined)}
              placeholder="e.g. /path/to/check-creds.sh"
              className="max-w-[400px] font-mono text-xs"
              aria-describedby="config-readiness-probe-hint config-readiness-probe-detail"
            />
          </div>
          <FieldHint id="config-readiness-probe-hint" field="readinessProbe" />
          <p id="config-readiness-probe-detail" className="text-xs text-muted-foreground">
            Run by the daemon. Exit 0 = ready; non-zero = not ready (stdout = reason). Held work fires once on recovery.
          </p>
          <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
            <Label htmlFor="config-agent-env-file">Agent Env File</Label>
            <Input
              id="config-agent-env-file"
              value={config.agentEnvFile || ""}
              onChange={(e) => update("agentEnvFile", e.target.value)}
              placeholder="e.g. ~/.config/mpt/env"
              className="max-w-[400px] font-mono text-xs"
              aria-describedby="config-agent-env-file-hint config-agent-env-file-detail"
            />
          </div>
          <FieldHint id="config-agent-env-file-hint" field="agentEnvFile" />
          <p id="config-agent-env-file-detail" className="text-xs text-muted-foreground">
            systemd EnvironmentFile syntax, no shell expansion. Relative to the team folder. A missing or invalid file never blocks a spawn; <code>mpt doctor</code> says why.
          </p>
        </CardContent>
      </Card>

      {/* Favorites save immediately (own endpoint), not with the Save button. */}
      <FavoriteDirectories />

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">Autosave</h2>
          <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
            <Label htmlFor="config-flush-interval">Flush Interval (min)</Label>
            <Input
              id="config-flush-interval"
              type="number"
              value={config.autosave.flushIntervalMinutes}
              onChange={(e) => setConfig({ ...config, autosave: { ...config.autosave, flushIntervalMinutes: parseInt(e.target.value) || 30 } })}
              className="max-w-[120px]"
            />
            <Label htmlFor="config-commit-interval">Commit Interval (hrs)</Label>
            <Input
              id="config-commit-interval"
              type="number"
              value={config.autosave.commitIntervalHours}
              onChange={(e) => setConfig({ ...config, autosave: { ...config.autosave, commitIntervalHours: parseInt(e.target.value) || 24 } })}
              className="max-w-[120px]"
            />
            <Label id="config-auto-commit">Auto Commit</Label>
            <Select
              value={config.autosave.autoCommit ? "true" : "false"}
              onValueChange={(v) => setConfig({ ...config, autosave: { ...config.autosave, autoCommit: v === "true" } })}
            >
              <SelectTrigger className="max-w-[120px]" aria-labelledby="config-auto-commit"><SelectValue /></SelectTrigger>
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
