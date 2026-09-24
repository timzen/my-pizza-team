/**
 * SpawnDialog — Spawn a single teammate homed in a specific directory.
 *
 * The steady pool (TeamSizeDialog) spawns generalists in the leader's working
 * directory; this is the escape hatch for "I want someone living in *that*
 * repo". The directory is the pi process's cwd and the teammate's only
 * work-selection signal — the daemon biases it toward WorkItems homed there
 * (directory affinity; see docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md).
 *
 * Sends a `spawn` leader directive to the chosen host. A one-off teammate still
 * counts toward the steady size (it's a pool teammate), so it can satisfy the
 * minimum — but it's never auto-replaced *in that directory*.
 *
 * Restores the old /spawn page's form as a dialog, opened from the sidebar.
 */

import { useEffect, useState } from "react";
import { apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DirectoryInput } from "@/components/ui/directory-input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

interface AgentOption {
  id: string;
  name: string;
  hostId?: string;
  status: string;
}

export function SpawnDialog({
  open,
  onOpenChange,
  onSpawned,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSpawned: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Mounted only while open: each open starts clean and reloads hosts. */}
        {open && <SpawnForm onDone={() => { onSpawned(); onOpenChange(false); }} />}
      </DialogContent>
    </Dialog>
  );
}

function SpawnForm({ onDone }: { onDone: () => void }) {
  const [hostId, setHostId] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [storyDirs, setStoryDirs] = useState<string[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);

  // Load candidate directories (story homes) and online hosts on open.
  useEffect(() => {
    fetch("/api/stories")
      .then((r) => r.json())
      .then((data: { stories: Array<{ directory?: string }> }) => {
        const dirs = data.stories.filter((s) => typeof s.directory === "string").map((s) => s.directory as string);
        setStoryDirs([...new Set(dirs)]);
      })
      .catch(() => {});

    fetch("/api/agents")
      .then((r) => r.json())
      .then((data: { agents: AgentOption[] }) => {
        const hostList = [...new Set(
          data.agents.filter((a) => a.hostId && a.status !== "offline").map((a) => a.hostId as string),
        )];
        setHosts(hostList);
        if (hostList.length > 0) setHostId((prev) => prev || hostList[0]!);
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!hostId) { setError("A host is required. Ensure a leader agent is connected."); return; }

    const res = await apiPost<{ success: boolean; error?: string }>(`/api/hosts/${encodeURIComponent(hostId)}/leader/directives`, {
      action: "spawn",
      params: { cwd: cwd || undefined, reason: "teammate" },
    });
    if (!res.success) { setError(res.error || "Failed to spawn"); return; }
    onDone();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Spawn teammate</DialogTitle>
        <DialogDescription>
          Start one teammate in a specific directory. It preferentially picks up work homed there.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label>Host</Label>
          {hosts.length > 0 ? (
            <Select value={hostId} onValueChange={(v) => setHostId(v ?? "")}>
              <SelectTrigger><SelectValue placeholder="Select host" /></SelectTrigger>
              <SelectContent>
                {hosts.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <>
              <Input value={hostId} onChange={(e) => setHostId(e.target.value)} placeholder="host-id" />
              <p className="text-xs text-destructive">No online leaders detected. Enter a host ID or start a leader.</p>
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>Working directory (optional)</Label>
          <DirectoryInput value={cwd} onChange={setCwd} extraDirectories={storyDirs} />
          <p className="text-xs text-muted-foreground">Blank uses the leader's directory.</p>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="submit">Spawn</Button>
        </DialogFooter>
      </form>
    </>
  );
}
