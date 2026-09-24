/**
 * TeammatePage — Watch one teammate work, live (`/teammates/:id`).
 *
 * Fills the center column (docs/TEAMMATE_CHAT.md): a header strip — status,
 * what it's working on (linked to the work item's page, where the full prompt
 * and thread live), and its directory — over the CLI-ish `TranscriptView`.
 *
 * Watch-only for now: having this page open is what turns the teammate's
 * transcript mirror on (the SSE subscription registers a viewer), and nothing
 * here can reach the teammate. Pairing/messaging is Phase C.
 *
 * There's no backfill: the transcript starts at a "watching from …" marker.
 * The sidebar highlights this teammate's row while the page is open.
 */

import { Link, useParams } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { useTranscriptStream } from "@/hooks/useTranscriptStream";
import { TranscriptView } from "@/components/transcript/TranscriptView";
import { workItemPath, type LinkableWorkItem } from "@/lib/work-item-link";
import { Badge } from "@/components/ui/badge";
import { FolderOpen, Eye, WifiOff } from "lucide-react";

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

  const agent = agents?.agents.find((a) => a.id === id);
  const current = work?.items.find((w) => w.memberId === id);

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
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground" title="Watch-only: nothing you do here reaches the teammate">
          {connected ? <><Eye className="h-3.5 w-3.5" /> watching</> : <><WifiOff className="h-3.5 w-3.5" /> reconnecting…</>}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <TranscriptView
          entries={entries}
          empty={<p className="text-muted-foreground">Waiting for activity…</p>}
        />
      </div>
    </div>
  );
}
