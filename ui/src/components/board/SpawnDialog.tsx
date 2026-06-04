/**
 * SpawnDialog — Modal to spawn a new teammate in a selected directory.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserPlus } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

interface SpawnDialogProps {
  onSpawned?: () => void;
}

export function SpawnDialog({ onSpawned }: SpawnDialogProps) {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setSuccess("");
    const res = await apiPost<{ success: boolean; name?: string; error?: string }>("/api/team/spawn", { cwd });
    if (res.success) {
      setSuccess(`Spawned teammate: ${res.name}`);
      setCwd("");
      onSpawned?.();
    } else {
      setError(res.error || "Failed to spawn");
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4 mr-1" /> Spawn</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(""); setSuccess(""); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Spawn Teammate</DialogTitle></DialogHeader>
        <form onSubmit={handleSpawn} className="space-y-4">
          <div><Label>Working Directory</Label><Input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="~/projects/my-app" required /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-green-600 dark:text-green-400">{success}</p>}
          <Button type="submit" className="w-full">Spawn</Button>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
}
