/**
 * SpawnDialog — Modal to spawn a new teammate in a selected directory.
 */

import { useState, useEffect } from "react";
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
  const [hostId, setHostId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Auto-detect hostId from the leader agent on first open
  useEffect(() => {
    if (open && !hostId) {
      fetch("/api/agents").then(r => r.json()).then((data: { agents: { id: string; hostId?: string }[] }) => {
        const leader = data.agents.find(a => a.id === "leader");
        if (leader?.hostId) setHostId(leader.hostId);
      }).catch(() => {});
    }
  }, [open]);

  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setSuccess("");
    const res = await apiPost<{ success: boolean; request?: { id: string }; error?: string }>("/api/spawn-requests", {
      hostId,
      cwd: cwd || undefined,
      reason: reason || undefined,
    });
    if (res.success) {
      setSuccess(`Spawn request created: ${res.request?.id ?? "OK"}`);
      setCwd("");
      setReason("");
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
          <div><Label>Host ID</Label><Input value={hostId} onChange={e => setHostId(e.target.value)} placeholder="default" required /></div>
          <div><Label>Working Directory (optional)</Label><Input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="~/projects/my-app" /></div>
          <div><Label>Reason (optional)</Label><Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Need help with frontend" /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-green-600 dark:text-green-400">{success}</p>}
          <Button type="submit" className="w-full">Spawn</Button>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
}
