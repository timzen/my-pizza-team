/**
 * SchedulePage — Work Items → Schedule (`/work-items/schedule`): active
 * Scheduled WorkDefs.
 *
 * Scheduled work is cron-driven: the daemon's scheduler enqueues a fresh
 * WorkItem each time the cron fires (see the daemon's scheduler). This page
 * lists the jobs with a human-readable cron, when they last ran, and a
 * "Run now" escape hatch. Polls /api/work-defs and filters to type=Scheduled.
 * A row's archive button retires a job to Work Items → Archived (restore or
 * delete it there). Each row shows the job's run count
 * (`executionCount`, derived from the WorkItem table — docs/DESIGN.md "Execution
 * Count: Derived, not Counted") and its latest run.
 *
 * **Active only.** A job is pending when its definition is pending (one-way:
 * activate it from its page) *or* its Schedule is pending (reversible); either
 * way it's listed on Work Items → Pending, not here (lib/work-items.ts
 * `isActiveScheduledJob`). The row's **Make pending** moves it there. A
 * pending job never fires; reactivating a Schedule resumes at its next cron
 * occurrence without back-filling the ones it skipped (docs/DESIGN.md
 * "Pending schedules: reversible, no catch-up").
 */

import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WorkItemsLayout } from "@/components/WorkItemsTabs";
import { runCountLabel } from "@/lib/run-count";
import { isActiveScheduledJob } from "@/lib/work-items";
import { Plus, Play, Pause, CalendarClock, FolderOpen, Archive } from "lucide-react";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board";
  parent?: { kind: "story" | "schedule"; id: string };
  goal: string;
  directory?: string | null;
  pending?: boolean;
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
  executionCount?: number;
  lastRunAt?: string | null;
}

interface Schedule {
  id: string;
  title?: string;
  cron: string;
  lastEnqueuedAt?: string | null;
  /** Reversible schedule-level pending (the job doesn't fire while set). */
  pending?: boolean;
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
  const { data: schedData, refetch: refetchSchedules } = useApi<{ schedules: Schedule[] }>("/api/schedules", [], { pollInterval: 10_000 });
  const schedById = new Map((schedData?.schedules || []).map(s => [s.id, s]));
  const scheduleOf = (def: WorkDef) => def.parent?.kind === "schedule" ? schedById.get(def.parent.id) : undefined;
  // Active only: a pending definition or a pending Schedule puts the job on the Pending tab.
  const defs = (data?.workDefs || []).filter(d => d.type === "Scheduled" && isActiveScheduledJob(d, scheduleOf(d)));

  const run = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/enqueue`, {});
    refetch();
  };

  /** Make a Schedule pending (reversible — activate it again from the Pending tab). */
  const makePending = async (scheduleId: string) => {
    await apiPost(`/api/schedules/${encodeURIComponent(scheduleId)}/pending`, {});
    refetchSchedules();
  };

  const archive = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/archive`, {});
    refetch();
  };

  return (
    <WorkItemsLayout bodyClassName="max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Cron-driven jobs. The daemon enqueues a run each time the schedule fires.</p>
        <Button size="sm" render={<Link to="/work-defs/new?type=Scheduled" />}><Plus className="h-4 w-4 mr-1" />New Job</Button>
      </div>

      {defs.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <CalendarClock className="h-8 w-8" />
          <p className="text-sm">No active scheduled jobs.</p>
        </div>
      )}

      <div className="grid gap-3">
        {defs.map(def => {
          const sched = scheduleOf(def);
          const cron = sched?.cron;
          // Latest run of any kind (cron or Run now); the Schedule's cursor is the fallback.
          const lastRun = def.lastRunAt ?? sched?.lastEnqueuedAt;
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
                  <span>{runCountLabel(def.executionCount)}{lastRun && (def.executionCount ?? 0) > 0 ? ` · last ${new Date(lastRun).toLocaleString()}` : ""}</span>
                  {def.tokenUsage && def.tokenUsage.totalCostUsd > 0 && (
                    <span className="font-mono" title="Total cost across all runs">${def.tokenUsage.totalCostUsd.toFixed(3)}</span>
                  )}
                </div>
              </Link>
              <Button variant="ghost" size="sm" onClick={() => archive(def.id)} title="Archive this job"><Archive className="h-3.5 w-3.5" /></Button>
              {/* Reversible: the job moves to the Pending tab until it's activated. */}
              {sched && <Button variant="ghost" size="sm" onClick={() => makePending(sched.id)} title="Stop firing this job until you activate it again (it moves to the Pending tab)"><Pause className="h-3.5 w-3.5 mr-1" />Make pending</Button>}
              <Button variant="outline" size="sm" onClick={() => run(def.id)} title="Enqueue a run now"><Play className="h-3.5 w-3.5 mr-1" />Run now</Button>
            </CardContent>
          </Card>
          );
        })}
      </div>
    </WorkItemsLayout>
  );
}
