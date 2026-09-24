/**
 * TeammatePage — Watch one teammate work, live (`/teammates/:id`).
 *
 * Fills the center column (docs/TEAMMATE_CHAT.md): a header strip — status,
 * what it's working on (linked to the work item's page, where the full prompt
 * and thread live), and its directory — over the CLI-ish `TranscriptView`.
 *
 * Watching is read-only: having this page open is what turns the teammate's
 * transcript mirror on (the SSE subscription registers a viewer), and nothing
 * reaches the teammate. **Pair** (§4) is the explicit step that does: it pauses
 * the teammate's autonomous loop and opens the composer. **Release** hands it
 * back — keep working on its item (Resume), or Complete / Fail the item. A
 * release waits out a run in flight, so the teammate is never cut off mid-step.
 *
 * There's no backfill: the transcript starts at a "watching from …" marker.
 * The sidebar highlights this teammate's row while the page is open.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { useTranscriptStream } from "@/hooks/useTranscriptStream";
import { TranscriptView } from "@/components/transcript/TranscriptView";
import { PairComposer } from "@/components/transcript/PairComposer";
import { Button } from "@/components/ui/button";
import { isRunning, type PairingState } from "@/lib/transcript-types";
import { workItemPath, type LinkableWorkItem } from "@/lib/work-item-link";
import { Badge } from "@/components/ui/badge";
import { FolderOpen, Eye, WifiOff, MessageSquare, Play, CheckCircle2, XCircle } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  directory?: string | null;
  status: string;
}

interface WorkItem extends LinkableWorkItem {
  id: string;
  title: string;
  memberId?: string | null;
}

const DOT: Record<string, string> = {
  idle: "bg-muted-foreground/50",
  working: "bg-green-500",
  pairing: "bg-blue-500",
  offline: "bg-red-500",
};

export function TeammatePage() {
  const { id = "" } = useParams();
  const { entries, connected } = useTranscriptStream(id);
  const { data: agents } = useApi<{ agents: Agent[] }>("/api/agents", [], { pollInterval: 5000 });
  const { data: work } = useApi<{ items: WorkItem[] }>("/api/work-items?state=IN_PROGRESS,MORIBUND", [], { pollInterval: 5000 });

  const { data: pairing, refetch: refetchPairing } = useApi<PairingState>(
    `/api/agents/${encodeURIComponent(id)}/pairing/state`, [id], { pollInterval: 3000 },
  );
  const [error, setError] = useState("");

  const agent = agents?.agents.find((a) => a.id === id);
  const current = work?.items.find((w) => w.memberId === id);
  const running = isRunning(entries);
  const paired = !!pairing?.paired;

  const act = async (path: string, body: unknown = {}) => {
    const res = await apiPost<{ success: boolean; error?: string }>(`/api/agents/${encodeURIComponent(id)}/${path}`, body);
    setError(res.success ? "" : res.error || "Request failed");
    refetchPairing();
  };
  const release = (action: "resume" | "complete" | "fail") => {
    if (action === "fail" && !window.confirm("Mark its work item FAILED? The task will be left for a human.")) return;
    act("release", { action });
  };

  if (agents && !agent) {
    return <p className="p-6 text-sm text-muted-foreground">No teammate “{id}” is connected.</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[agent?.status ?? "offline"] || DOT.offline}`} title={agent?.status} />
        <h1 className="font-semibold">{agent?.name ?? id}</h1>
        <span className="text-xs text-muted-foreground">{agent?.status}</span>
        {current && (
          <Link to={workItemPath(current)} className="min-w-0 max-w-full truncate text-sm text-primary hover:underline" title={current.title}>
            ⚙️ {current.title}
          </Link>
        )}
        {agent?.directory && (
          <Badge variant="secondary" className="flex items-center gap-1 font-mono text-[10px]" title={agent.directory}>
            <FolderOpen className="h-2.5 w-2.5" />{agent.directory.split("/").filter(Boolean).pop()}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!connected && <span className="flex items-center gap-1 text-xs text-muted-foreground"><WifiOff className="h-3.5 w-3.5" /> reconnecting…</span>}
          {paired ? (
            <PairedControls hasWork={!!current} releasing={pairing?.pendingRelease ?? null} onRelease={release} />
          ) : (
            <>
              {connected && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Watch-only: nothing you do here reaches the teammate">
                  <Eye className="h-3.5 w-3.5" />
                  {pairing?.pendingRelease ? "releasing after this run…" : agent?.status === "pairing" ? "paused from its terminal" : "watching"}
                </span>
              )}
              <Button
                size="sm" variant="outline" className="h-7"
                disabled={!agent || agent.status === "offline"}
                onClick={() => act("pair")}
                title="Pause its autonomous work and talk to it. Nothing is interrupted: it finishes its current step first."
              >
                <MessageSquare className="mr-1 h-3.5 w-3.5" />Pair
              </Button>
            </>
          )}
        </div>
      </div>
      {error && <p className="shrink-0 px-4 py-1 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1">
        <TranscriptView
          entries={entries}
          empty={<p className="text-muted-foreground">{paired ? "Paired — say something below." : "Waiting for activity…"}</p>}
        />
      </div>
      {paired && <PairComposer memberId={id} running={running} />}
    </div>
  );
}

/**
 * While paired: a badge plus the three ways to hand it back. Complete/Fail only
 * make sense with a held work item; without one, Resume is the only choice.
 */
function PairedControls({
  hasWork,
  releasing,
  onRelease,
}: {
  hasWork: boolean;
  releasing: string | null;
  onRelease: (action: "resume" | "complete" | "fail") => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400" title="Its autonomous work is paused while you talk">
        paired
      </span>
      {releasing && <span className="text-xs text-muted-foreground">releasing after this run…</span>}
      <Button size="sm" variant="outline" className="h-7" onClick={() => onRelease("resume")} title={hasWork ? "Hand it back: it carries on with its work item" : "Hand it back: it goes back to picking up work"}>
        <Play className="mr-1 h-3.5 w-3.5" />Resume
      </Button>
      {hasWork && (
        <>
          <Button size="sm" variant="outline" className="h-7" onClick={() => onRelease("complete")} title="The work item is done — its last reply becomes the summary">
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />Complete
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => onRelease("fail")} title="Mark the work item failed (the task is left for a human)">
            <XCircle className="mr-1 h-3.5 w-3.5" />Fail
          </Button>
        </>
      )}
    </div>
  );
}
