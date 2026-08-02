/**
 * SchedulePage — Scheduled WorkDefs (`/schedule`).
 *
 * Scheduled work is cron-driven: the daemon's scheduler enqueues a fresh
 * WorkItem each time the cron fires (see the daemon's scheduler). This page
 * lists the jobs with a human-readable cron, when they last ran, and a
 * "Run now" escape hatch. Polls /api/work-defs and filters to type=Scheduled.
 */

import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Play, CalendarClock, FolderOpen } from "lucide-react";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled";
  goal: string;
  directory?: string | null;
  cron?: string | null;
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
  const defs = (data?.workDefs || []).filter(d => d.type === "Scheduled");

  const run = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/enqueue`, {});
    refetch();
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Schedule</h1>
          <p className="text-sm text-muted-foreground">Cron-driven jobs. The daemon enqueues a run each time the schedule fires.</p>
        </div>
        <Button size="sm" render={<Link to="/work-defs/new?type=Scheduled" />}><Plus className="h-4 w-4 mr-1" />New Job</Button>
      </div>

      {defs.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <CalendarClock className="h-8 w-8" />
          <p className="text-sm">No scheduled jobs yet.</p>
        </div>
      )}

      <div className="grid gap-3">
        {defs.map(def => (
          <Card key={def.id} className="hover:border-primary/50 transition-colors">
            <CardContent className="p-4 flex items-center gap-3">
              <Link to={`/work-defs/${encodeURIComponent(def.id)}`} className="min-w-0 flex-1">
                <p className="font-medium truncate">{def.title}</p>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                  <Badge variant="outline" className="text-[10px] flex items-center gap-1"><CalendarClock className="h-2.5 w-2.5" />{describeCron(def.cron)}</Badge>
                  <code className="text-[10px] bg-muted px-1 rounded">{def.cron}</code>
                  {def.directory && (
                    <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1"><FolderOpen className="h-2.5 w-2.5" />{def.directory}</Badge>
                  )}
                  <span>{def.lastEnqueuedAt ? `last run ${new Date(def.lastEnqueuedAt).toLocaleString()}` : "never run"}</span>
                </div>
              </Link>
              <Button variant="outline" size="sm" onClick={() => run(def.id)} title="Enqueue a run now"><Play className="h-3.5 w-3.5 mr-1" />Run now</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
