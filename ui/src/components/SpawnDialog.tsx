/**
 * SpawnDialog — Spawn a single teammate homed in a specific directory.
 *
 * The steady pool (TeamSizeDialog) spawns generalists in the leader's working
 * directory; this is the escape hatch for "I want someone living in *that*
 * repo". The directory is the pi process's cwd and the teammate's only
 * work-selection signal — the daemon biases it toward WorkItems homed there
 * (directory affinity; see docs/DESIGN.md "The WorkItem").
 *
 * Sends a `spawn` leader directive. A one-off teammate still counts toward the
 * steady size (it's a pool teammate), so it can satisfy the minimum — but it's
 * never auto-replaced *in that directory*.
 *
 * The host picker is gone (P1c-2): it forced a choice from a list that in practice
 * held exactly one entry and blocked the form when empty — friction for a decision
 * nobody was making.
 *
 * Restores the old /spawn page's form as a dialog, opened from the sidebar.
 */

import { useEffect, useState } from "react";
import { apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DirectoryInput } from "@/components/ui/directory-input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

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
        {/* Mounted only while open: each open starts clean and reloads directories. */}
        {open && <SpawnForm onDone={() => { onSpawned(); onOpenChange(false); }} />}
      </DialogContent>
    </Dialog>
  );
}

function SpawnForm({ onDone }: { onDone: () => void }) {
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [storyDirs, setStoryDirs] = useState<string[]>([]);

  // Load candidate directories (story homes) on open.
  useEffect(() => {
    fetch("/api/stories")
      .then((r) => r.json())
      .then((data: { stories: Array<{ directory?: string }> }) => {
        const dirs = data.stories.filter((s) => typeof s.directory === "string").map((s) => s.directory as string);
        setStoryDirs([...new Set(dirs)]);
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // No leader online means nothing will realize this; the daemon accepts the
    // directive and it shows as a pending spawn until one connects.
    const res = await apiPost<{ success: boolean; error?: string }>("/api/leader/directives", {
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
