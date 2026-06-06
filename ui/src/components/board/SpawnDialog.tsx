/**
 * SpawnDialog — Modal to spawn a new teammate.
 *
 * Provides:
 * - Story selection (from open stories) so the agent knows what to work on
 * - Host selection (from connected leaders/agents)
 * - Optional working directory override
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

interface SpawnDialogProps {
  onSpawned?: () => void;
}

interface StoryOption {
  id: string;
  title: string;
  dir?: string;
}

interface AgentOption {
  id: string;
  name: string;
  hostId?: string;
  status: string;
}

export function SpawnDialog({ onSpawned }: SpawnDialogProps) {
  const [open, setOpen] = useState(false);
  const [storyId, setStoryId] = useState("");
  const [hostId, setHostId] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [stories, setStories] = useState<StoryOption[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);

  // Load stories and agents when dialog opens
  useEffect(() => {
    if (!open) return;

    fetch("/api/stories")
      .then(r => r.json())
      .then((data: { stories: StoryOption[] }) => {
        setStories(data.stories.filter(s => (s as any).status === "open"));
      })
      .catch(() => {});

    fetch("/api/agents")
      .then(r => r.json())
      .then((data: { agents: AgentOption[] }) => {
        // Collect unique hostIds from online agents
        const hostIds = new Set<string>();
        for (const agent of data.agents) {
          if (agent.hostId && agent.status !== "offline") {
            hostIds.add(agent.hostId);
          }
        }
        const hostList = Array.from(hostIds);
        setHosts(hostList);
        // Auto-select first available host
        if (hostList.length > 0 && !hostId) {
          setHostId(hostList[0]!);
        }
      })
      .catch(() => {});
  }, [open]);

  // When story changes, auto-fill cwd from story dir
  useEffect(() => {
    if (storyId) {
      const story = stories.find(s => s.id === storyId);
      if (story?.dir) setCwd(story.dir);
    }
  }, [storyId, stories]);

  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setSuccess("");

    if (!hostId) {
      setError("A host is required. Ensure a leader agent is connected.");
      return;
    }

    const res = await apiPost<{ success: boolean; request?: { id: string }; error?: string }>("/api/spawn-requests", {
      hostId,
      cwd: cwd || undefined,
      storyId: storyId || undefined,
    });
    if (res.success) {
      setSuccess("Spawn request sent! The leader will create the agent.");
      setStoryId("");
      setCwd("");
      onSpawned?.();
      setTimeout(() => setOpen(false), 1500);
    } else {
      setError(res.error || "Failed to spawn");
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4 mr-1" /> Spawn
      </Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(""); setSuccess(""); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Spawn Teammate</DialogTitle></DialogHeader>
          <form onSubmit={handleSpawn} className="space-y-4">
            {/* Story selection */}
            <div className="space-y-1.5">
              <Label>Story (optional)</Label>
              <Select value={storyId} onValueChange={setStoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Any available task" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Any available task</SelectItem>
                  {stories.map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Focus the agent on a specific story, or leave blank for any open task.</p>
            </div>

            {/* Host selection */}
            <div className="space-y-1.5">
              <Label>Host</Label>
              {hosts.length > 0 ? (
                <Select value={hostId} onValueChange={setHostId}>
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

            {/* Working directory */}
            <div className="space-y-1.5">
              <Label>Working Directory (optional)</Label>
              <Input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="~/projects/my-app" />
              <p className="text-xs text-muted-foreground">Override where the agent works. Auto-filled from story directory if set.</p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-green-600 dark:text-green-400">{success}</p>}
            <Button type="submit" className="w-full">Spawn Teammate</Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
