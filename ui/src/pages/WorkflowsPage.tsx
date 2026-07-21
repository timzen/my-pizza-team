/**
 * WorkflowsPage — Lists all workflows with summary info (state count,
 * transition count, default status). Links to individual workflow detail pages.
 * Includes a "New Workflow" form that creates a workflow with default states.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi, apiPut } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, ArrowRight } from "lucide-react";

interface WorkflowSummary {
  name: string;
  stateCount: number;
  agentCount: number;
  manualCount: number;
  isDefault: boolean;
}

interface ConfigData {
  port: number;
  tmuxSession: string;
  defaultWorkflow: string;
  workflows: Record<string, unknown>;
  autosave: { flushIntervalMinutes: number; commitIntervalHours: number; autoCommit: boolean };
  [key: string]: unknown;
}

export function WorkflowsPage() {
  const { data, loading, refetch } = useApi<WorkflowSummary[]>("/api/workflows");
  const { data: config } = useApi<ConfigData>("/api/config");
  const navigate = useNavigate();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <div className="text-muted-foreground">Loading...</div>;

  /** Slugify the input: lowercase, hyphens only, no leading/trailing hyphens */
  const slugify = (val: string) =>
    val.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-|-$/g, "");

  const handleCreate = async () => {
    const name = slugify(newName.trim());
    if (!name) return;
    if (data?.some((w) => w.name === name)) {
      setError(`Workflow "${name}" already exists`);
      return;
    }
    if (!config) {
      setError("Config not loaded");
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const newWorkflow = {
        states: [
          { name: "in_progress", type: "agent" },
          { name: "review", type: "manual" },
        ],
      };
      const updatedConfig = {
        ...config,
        workflows: { ...config.workflows, [name]: newWorkflow },
      };
      const res = await apiPut<{ success: boolean; error?: string }>("/api/config", updatedConfig);
      if (res.success) {
        setNewName("");
        refetch();
      } else {
        setError(res.error || "Failed to create workflow");
      }
    } catch (e) {
      setError("Network error: " + (e as Error).message);
    }
    setCreating(false);
  };

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Workflow cards */}
      <div className="grid gap-3">
        {data?.map((wf) => (
          <Card
            key={wf.name}
            className="cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => navigate(`/workflows/${wf.name}`)}
          >
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-semibold">{wf.name}</span>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>{wf.stateCount} states</span>
                <span>{wf.agentCount} agent · {wf.manualCount} manual</span>
                <ArrowRight className="h-4 w-4" />
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <p className="text-muted-foreground text-sm">No workflows configured.</p>
        )}
      </div>

      {/* New Workflow form */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="text-sm font-semibold">Create New Workflow</h2>
          <div className="flex gap-2">
            <Input
              placeholder="workflow-name"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setError(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              className="max-w-[240px]"
              disabled={creating}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              {creating ? "Creating..." : "New Workflow"}
            </Button>
          </div>
          {newName.trim() && (
            <p className="text-xs text-muted-foreground">
              Will be created as: <code className="bg-muted px-1 py-0.5 rounded">{slugify(newName.trim())}</code> with states [in_progress · agent, review · manual]
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
