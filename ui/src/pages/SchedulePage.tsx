/**
 * SchedulePage — Scheduled WorkDefs (`/schedule`).
 *
 * Scheduled work is cron-driven: the daemon's scheduler enqueues a fresh
 * WorkItem each time the cron fires (see the daemon's scheduler). This page
 * lists the jobs with a human-readable cron, when they last ran, and a
 * "Run now" escape hatch. Polls /api/work-defs and filters to type=Scheduled.
 * Supports archive/restore for retired jobs.
 */

import { Link } from "react-router-dom";
import { useState } from "react";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Play, CalendarClock, FolderOpen, Archive, ArchiveRestore, Trash2, X } from "lucide-react";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board";
  parent?: { kind: "story" | "schedule"; id: string };
  goal: string;
  directory?: string | null;
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
}

interface Schedule {
  id: string;
  title?: string;
  cron: string;
  lastEnqueuedAt?: string | null;
}

/** Best-effort human phrasing for the common cron shapes; falls back to raw. */
function describeCron(cron?: string | null): string {
  if (!cron) return "—";
  const known: Record<string, string> = {
    "0 * * * *": "Every hour",
    "0 9 * * *": "Every day at 9am",
    "0 9 * * 1-5": "Weekdays at 9am",
    "0 9 * * 1": "Every Monday at 9am",
    "0 9 1 * *": "First of the month at 9am",
  };
  return known[cron.trim()] || cron;
}

export function SchedulePage() {
  const { data, refetch } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs", [], { pollInterval: 10_000 });
  const { data: archivedData, refetch: refetchArchived } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs?status=archived", [], { pollInterval: 30_000 });
  const { data: schedData } = useApi<{ schedules: Schedule[] }>("/api/schedules", [], { pollInterval: 10_000 });
  const defs = (data?.workDefs || []).filter(d => d.type === "Scheduled");
  const archivedDefs = (archivedData?.workDefs || []).filter(d => d.type === "Scheduled");
  const schedById = new Map((schedData?.schedules || []).map(s => [s.id, s]));
  const [showArchived, setShowArchived] = useState(false);

  const run = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/enqueue`, {});
    refetch();
  };

  const archive = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/archive`, {});
    refetch();
    refetchArchived();
  };

  const restore = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/restore`, {});
    refetch();
    refetchArchived();
  };

  const remove = async (id: string) => {
    await apiDelete(`/api/work-defs/${encodeURIComponent(id)}`);
    refetchArchived();
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Schedule</h1>
          <p className="text-sm text-muted-foreground">Cron-driven jobs. The daemon enqueues a run each time the schedule fires.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowArchived(s => !s)} className={showArchived ? "bg-accent" : ""}>
            <Archive className="h-4 w-4 mr-1" />Archived{archivedDefs.length > 0 ? ` (${archivedDefs.length})` : ""}
          </Button>
          <Button size="sm" render={<Link to="/work-defs/new?type=Scheduled" />}><Plus className="h-4 w-4 mr-1" />New Job</Button>
        </div>
      </div>

      {defs.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <CalendarClock className="h-8 w-8" />
          <p className="text-sm">No scheduled jobs yet.</p>
        </div>
      )}

      <div className="grid gap-3">
        {defs.map(def => {
          const sched = def.parent?.kind === "schedule" ? schedById.get(def.parent.id) : undefined;
          const cron = sched?.cron;
          const lastEnqueuedAt = sched?.lastEnqueuedAt;
          return (
          <Card key={def.id} className="hover:border-primary/50 transition-colors">
            <CardContent className="p-4 flex items-center gap-3">
              <Link to={`/work-defs/${encodeURIComponent(def.id)}`} className="min-w-0 flex-1">
                <p className="font-medium truncate">{def.title}</p>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                  <Badge variant="outline" className="text-[10px] flex items-center gap-1"><CalendarClock className="h-2.5 w-2.5" />{describeCron(cron)}</Badge>
                  {cron && <code className="text-[10px] bg-muted px-1 rounded">{cron}</code>}
                  {def.directory && (
                    <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1"><FolderOpen className="h-2.5 w-2.5" />{def.directory}</Badge>
                  )}
                  <span>{lastEnqueuedAt ? `last run ${new Date(lastEnqueuedAt).toLocaleString()}` : "never run"}</span>
                  {def.tokenUsage && def.tokenUsage.totalCostUsd > 0 && (
                    <span className="font-mono" title="Total cost across all runs">${def.tokenUsage.totalCostUsd.toFixed(3)}</span>
                  )}
                </div>
              </Link>
              <Button variant="ghost" size="sm" onClick={() => archive(def.id)} title="Archive this job"><Archive className="h-3.5 w-3.5" /></Button>
              <Button variant="outline" size="sm" onClick={() => run(def.id)} title="Enqueue a run now"><Play className="h-3.5 w-3.5 mr-1" />Run now</Button>
            </CardContent>
          </Card>
          );
        })}
      </div>

      {/* Archived drawer */}
      {showArchived && (
        <div className="fixed right-0 top-0 z-40 flex h-full w-80 flex-col border-l border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border p-3">
            <span className="font-medium">Archived Jobs</span>
            <button onClick={() => setShowArchived(false)} className="rounded p-1 hover:bg-accent/50"><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {archivedDefs.length === 0 && <p className="text-sm text-muted-foreground">Nothing archived.</p>}
            {archivedDefs.map((def) => {
              const sched = def.parent?.kind === "schedule" ? schedById.get(def.parent.id) : undefined;
              return (
                <div key={def.id} className="rounded-md border p-2">
                  <p className="mb-1 text-sm font-medium truncate">{def.title}</p>
                  {sched?.cron && <p className="text-xs text-muted-foreground mb-1">{describeCron(sched.cron)}</p>}
                  <div className="flex gap-1">
                    <button onClick={() => restore(def.id)} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"><ArchiveRestore className="h-3 w-3" /> Restore</button>
                    <button onClick={() => remove(def.id)} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent text-destructive"><Trash2 className="h-3 w-3" /> Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
