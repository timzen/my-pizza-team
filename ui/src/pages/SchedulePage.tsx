/**
 * SchedulePage — Work → Schedule (`/work/schedule`): active
 * Scheduled WorkDefs.
 *
 * Scheduled work is cron-driven: the daemon's scheduler enqueues a fresh
 * WorkItem each time the cron fires (see the daemon's scheduler). This page
 * lists the jobs with a human-readable cron, when they last ran, and a
 * "Run now" escape hatch. Polls /api/work-defs and filters to type=Scheduled.
 * A row's archive button retires a job to Work → Archived (restore or
 * delete it there). Each row shows the job's run count
 * (`executionCount`, derived from the WorkItem table — docs/DESIGN.md "Execution
 * Count: Derived, not Counted") and its latest run.
 *
 * **Active only.** A job is pending when its definition is pending (one-way:
 * activate it from its page) *or* its Schedule is pending (reversible); either
 * way it's listed on Work → Pending, not here (lib/work-items.ts
 * `isActiveScheduledJob`). The row's **Make pending** moves it there. A
 * pending job never fires; reactivating a Schedule resumes at its next cron
 * occurrence without back-filling the ones it skipped (docs/DESIGN.md
 * "Pending schedules: reversible, no catch-up").
 *
 * Empty, it explains what a scheduled job is and offers New job and the chat
 * (components/ui/empty-state; docs/DESIGN.md "An Empty Screen Teaches").
 */

import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WorkItemsLayout } from "@/components/WorkItemsTabs";
import { runCountLabel } from "@/lib/run-count";
import { isActiveScheduledJob } from "@/lib/work-items";
import { Plus, Play, Pause, CalendarClock, FolderOpen, Archive } from "lucide-react";
import type { ScheduleView, WorkDefView } from "@shared/protocol";
import { Tooltip } from "@/components/ui/tooltip";
import { describeCron } from "@/lib/field-help";
import { AskAssistantButton, EmptyState } from "@/components/ui/empty-state";

type WorkDef = WorkDefView;
type Schedule = ScheduleView;

/** The job's cron in words (lib/field-help.ts `describeCron`), or the raw expression when it can't be phrased. */
function cronLabel(cron?: string | null): string {
  if (!cron) return "—";
  return describeCron(cron) ?? cron;
}

export function SchedulePage() {
  const { data, refetch } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs", [], { pollInterval: 10_000 });
  const { data: schedData, refetch: refetchSchedules } = useApi<{ schedules: Schedule[] }>("/api/schedules", [], { pollInterval: 10_000 });
  const schedById = new Map((schedData?.schedules || []).map(s => [s.id, s]));
  const scheduleOf = (def: WorkDef) => def.parent?.kind === "schedule" ? schedById.get(def.parent.id) : undefined;
  // Active only: a pending definition or a pending Schedule puts the job on the Pending tab.
  const defs = (data?.workDefs || []).filter(d => d.type === "Scheduled" && isActiveScheduledJob(d, scheduleOf(d)));

  const announce = useAnnounce();
  const run = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/enqueue`, {});
    announce("Run queued");
    refetch();
  };

  /** Make a Schedule pending (reversible — activate it again from the Pending tab). */
  const makePending = async (scheduleId: string) => {
    await apiPost(`/api/schedules/${encodeURIComponent(scheduleId)}/pending`, {});
    announce("Schedule made pending");
    refetchSchedules();
  };

  const archive = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/archive`, {});
    announce("Archived");
    refetch();
  };

  return (
    <WorkItemsLayout bodyClassName="max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Cron-driven jobs. The daemon enqueues a run each time the schedule fires.</p>
        <Button size="sm" render={<Link to="/work-defs/new?type=Scheduled" />}><Plus className="h-4 w-4 mr-1" />New Job</Button>
      </div>

      {data && defs.length === 0 && (
        <EmptyState kind="schedule" icon={CalendarClock}>
          <Button size="sm" render={<Link to="/work-defs/new?type=Scheduled" />}><Plus className="h-4 w-4 mr-1" aria-hidden />New job</Button>
          <AskAssistantButton />
        </EmptyState>
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
                  <Badge variant="outline" className="text-[10px] flex items-center gap-1"><CalendarClock className="h-2.5 w-2.5" />{cronLabel(cron)}</Badge>
                  {cron && <code className="text-[10px] bg-muted px-1 rounded">{cron}</code>}
                  {def.directory && (
                    <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1"><FolderOpen className="h-2.5 w-2.5" />{def.directory}</Badge>
                  )}
                  <span>{runCountLabel(def.executionCount)}{lastRun && (def.executionCount ?? 0) > 0 ? ` · last ${new Date(lastRun).toLocaleString()}` : ""}</span>
                  {def.tokenUsage && def.tokenUsage.totalCostUsd > 0 && (
                    <Tooltip content="Total cost across all runs" describe={false}>
                      <span className="font-mono">${def.tokenUsage.totalCostUsd.toFixed(3)}</span>
                    </Tooltip>
                  )}
                </div>
              </Link>
              <Tooltip content="Archive this job" describe={false}>
                <Button variant="ghost" size="sm" onClick={() => archive(def.id)} aria-label="Archive this job"><Archive className="h-3.5 w-3.5" /></Button>
              </Tooltip>
              {/* Reversible: the job moves to the Pending tab until it's activated. */}
              {sched && <Tooltip content="Stop firing this job until you activate it again (it moves to the Pending tab)"><Button variant="ghost" size="sm" onClick={() => makePending(sched.id)}><Pause className="h-3.5 w-3.5 mr-1" />Make pending</Button></Tooltip>}
              <Tooltip content="Enqueue a run now">
                <Button variant="outline" size="sm" onClick={() => run(def.id)}><Play className="h-3.5 w-3.5 mr-1" />Run now</Button>
              </Tooltip>
            </CardContent>
          </Card>
          );
        })}
      </div>
    </WorkItemsLayout>
  );
}
