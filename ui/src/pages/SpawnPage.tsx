/**
 * SpawnPage — Full-page form for spawning a new teammate (/spawn).
 *
 * Provides:
 * - Host selection (from connected leaders/agents)
 * - Working directory: the pi process's cwd. Teammates are generalists, and
 *   this directory is the *only* work-selection signal — the daemon biases a
 *   teammate toward WorkItems whose story/WorkDef names this directory
 *   (directory affinity; see the daemon's docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md).
 *
 * There is deliberately no state picker, story binding, or capability list:
 * teammates are a flat generalist pool that work every agent state; the state
 * persona does the specializing and directory affinity does the routing.
 *
 * On success, returns to wherever you came from (the sidebar's pending spawn
 * list shows the request until the leader realizes it).
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DirectoryInput } from "@/components/ui/directory-input";
import { BackButton } from "@/components/ui/back-button";
import { apiPost } from "@/hooks/useApi";

interface AgentOption {
  id: string;
  name: string;
  hostId?: string;
  status: string;
}

export function SpawnPage() {
  const navigate = useNavigate();
  const [hostId, setHostId] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [storyDirs, setStoryDirs] = useState<string[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);

  // Load story directories (as candidate homes) and online hosts on mount.
  useEffect(() => {
    fetch("/api/stories")
      .then(r => r.json())
      .then((data: { stories: Array<{ directory?: string; status?: string }> }) => {
        const dirs = data.stories
          .filter(s => typeof s.directory === "string")
          .map(s => s.directory as string);
        setStoryDirs([...new Set(dirs)]);
      })
      .catch(() => {});

    fetch("/api/agents")
      .then(r => r.json())
      .then((data: { agents: AgentOption[] }) => {
        const hostIds = new Set<string>();
        for (const agent of data.agents) {
          if (agent.hostId && agent.status !== "offline") {
            hostIds.add(agent.hostId);
          }
        }
        const hostList = Array.from(hostIds);
        setHosts(hostList);
        if (hostList.length > 0) {
          setHostId(prev => prev || hostList[0]!);
        }
      })
      .catch(() => {});
  }, []);

  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setSuccess("");

    if (!hostId) {
      setError("A host is required. Ensure a leader agent is connected.");
      return;
    }

    const res = await apiPost<{ success: boolean; directive?: { id: string }; error?: string }>(`/api/hosts/${encodeURIComponent(hostId)}/leader/directives`, {
      action: "spawn",
      params: { cwd: cwd || undefined, reason: "teammate" },
    });
    if (res.success) {
      setSuccess("Spawn request sent! The leader will create the agent.");
      setTimeout(() => navigate(-1), 1200);
    } else {
      setError(res.error || "Failed to spawn");
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <BackButton fallback="/board" title="Back to board" />
        <h1 className="text-2xl font-bold">Spawn Teammate</h1>
      </div>

      <form onSubmit={handleSpawn} className="space-y-4">
        {/* Host selection */}
        <div className="space-y-1.5">
          <Label>Host</Label>
          {hosts.length > 0 ? (
            <Select value={hostId} onValueChange={(v) => setHostId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select host" />
              </SelectTrigger>
              <SelectContent>
                {hosts.map(h => (
                  <SelectItem key={h} value={h}>{h}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input value={hostId} onChange={e => setHostId(e.target.value)} placeholder="host-id" required />
          )}
          {hosts.length === 0 && (
            <p className="text-xs text-destructive">No online leaders detected. Enter a host ID manually or start a leader.</p>
          )}
        </div>

        {/* Working directory — the teammate's home and its work-selection bias. */}
        <div className="space-y-1.5">
          <Label>Working Directory (optional)</Label>
          <DirectoryInput value={cwd} onChange={setCwd} extraDirectories={storyDirs} />
          <p className="text-xs text-muted-foreground">Where the pi process starts. This is the teammate's affinity: it preferentially picks up work homed at this directory, then un-homed work, and only reaches into another directory when no teammate is homed there.</p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-green-600 dark:text-green-400">{success}</p>}
        <div className="flex gap-2">
          <Button type="submit">Spawn Teammate</Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}
