/**
 * SpawnDialog — Modal to spawn a new teammate.
 *
 * Provides:
 * - Host selection (from connected leaders/agents)
 * - Optional home directory (just the pi process's cwd — teammates cd to each
 *   story's directory to work, so this is NOT a matching key; see the daemon's
 *   docs/WORK-MODEL.md)
 * - Optional capabilities (advertised skills, same key/value editor as story
 *   requirements: `python` presence-only, or `java: 8` value-bound — stories
 *   with matching requirements will be offered to it)
 * - Optional story binding: pick an open story to spawn an `assigned-story`
 *   teammate that only works that story (the leader passes
 *   `--ppt-work-mode=assigned-story --ppt-story=<id>`); leave unset for an
 *   eager helper that picks up any matching work
 *
 * There is deliberately no state picker: teammates are generalists that work
 * every agent state; the state persona does the specializing.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DirectoryInput } from "@/components/ui/directory-input";
import { RequirementsEditor } from "@/components/board/RequirementsEditor";
import { UserPlus } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

interface SpawnDialogProps {
  onSpawned?: () => void;
  /** Render an icon-only trigger (for the collapsed sidebar). */
  compact?: boolean;
}

interface StoryOption {
  id: string;
  title: string;
  status?: string;
  directory?: string;
}

interface AgentOption {
  id: string;
  name: string;
  hostId?: string;
  status: string;
}

export function SpawnDialog({ onSpawned, compact }: SpawnDialogProps) {
  const [open, setOpen] = useState(false);
  const [hostId, setHostId] = useState("");
  const [cwd, setCwd] = useState("");
  const [capabilities, setCapabilities] = useState<Record<string, string | null>>({});
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [stories, setStories] = useState<StoryOption[]>([]);
  const [storyId, setStoryId] = useState("");
  const [storyDirs, setStoryDirs] = useState<string[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);

  // Load stories and agents when dialog opens
  useEffect(() => {
    if (!open) return;

    fetch("/api/stories")
      .then(r => r.json())
      .then((data: { stories: StoryOption[] }) => {
        const open = data.stories.filter(s => s.status === "open");
        // Open stories are candidates for story-bound spawns.
        setStories(open);
        // Suggest open stories' working directories as candidate homes.
        const dirs = open
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
        if (hostList.length > 0 && !hostId) {
          setHostId(hostList[0]!);
        }
      })
      .catch(() => {});
  }, [open]);

  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setSuccess("");

    if (!hostId) {
      setError("A host is required. Ensure a leader agent is connected.");
      return;
    }

    // Serialize to the --ppt-skills wire entries: `name` (presence-only) or `name:value`.
    const skillList = Object.entries(capabilities).map(([k, v]) => (v ? `${k}:${v}` : k));
    const res = await apiPost<{ success: boolean; directive?: { id: string }; error?: string }>(`/api/hosts/${encodeURIComponent(hostId)}/leader/directives`, {
      action: "spawn",
      params: { cwd: cwd || undefined, storyId: storyId || undefined, skills: skillList.length > 0 ? skillList : undefined, reason: "teammate" },
    });
    if (res.success) {
      setSuccess("Spawn request sent! The leader will create the agent.");
      setCwd("");
      setStoryId("");
      setCapabilities({});
      onSpawned?.();
      setTimeout(() => setOpen(false), 1500);
    } else {
      setError(res.error || "Failed to spawn");
    }
  };

  return (
    <>
      {compact ? (
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setOpen(true)} title="Spawn teammate">
          <UserPlus className="h-4 w-4" />
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <UserPlus className="h-4 w-4 mr-1" /> Spawn
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(""); setSuccess(""); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>Spawn Teammate</DialogTitle></DialogHeader>
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

            {/* Story binding (optional — assigned-story vs eager helper) */}
            <div className="space-y-1.5">
              <Label>Story (optional)</Label>
              <Select value={storyId} onValueChange={(v) => setStoryId(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Any story (eager helper)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Any story (eager helper)</SelectItem>
                  {stories.map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Bind this teammate to one story: it only works tasks from that story. Leave unset for a generalist that picks up any matching work.</p>
            </div>

            {/* Home directory (process cwd — not a matching key) */}
            <div className="space-y-1.5">
              <Label>Home Directory (optional)</Label>
              <DirectoryInput value={cwd} onChange={setCwd} extraDirectories={storyDirs} />
              <p className="text-xs text-muted-foreground">Where the pi process starts. Teammates cd to each story's directory to work, so this doesn't limit what they pick up.</p>
            </div>

            {/* Capabilities (advertised skills — same editor as story requirements) */}
            <div className="space-y-1.5">
              <Label>Capabilities (optional)</Label>
              <RequirementsEditor value={capabilities} onChange={setCapabilities} />
              <p className="text-xs text-muted-foreground">What this teammate advertises: a bare name matches presence-only requirements; a name with a value (e.g. java: 8) also matches exact-value requirements. Keep values to simple tokens.</p>
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
