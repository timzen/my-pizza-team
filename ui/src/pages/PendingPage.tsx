/**
 * PendingPage — Work Items → Pending (`/work-items/pending`): everything held
 * in the pending state, across kinds (docs/DESIGN.md "Pending: Write, Review,
 * Activate"). Board, Tasks, and Schedule list active work only, so this is
 * where pending work is reviewed and activated.
 *
 * For now it's one section per kind, each hidden while its kind is switched off
 * (hooks/useFeatures):
 * - **Stories** — the board itself filtered to pending stories (BoardPage
 *   `StoryBoard view="pending"`), not a separate list: a story made pending
 *   mid-flight can still have a task finishing in an agent state, so its lanes
 *   stay visible. Each story's ▶ activates it (back to the Board tab).
 * - **Tasks** — pending Solitary WorkDefs; **Activate** locks the definition
 *   and enqueues it (one-way).
 * - **Schedules** — scheduled jobs whose definition (one-way) or Schedule
 *   (reversible) is pending (lib/work-items.ts `isActiveScheduledJob`).
 *
 * Replaced the old `/pending` (stories only) and the Tasks page's pending
 * filter; `/pending` and `/backlog` redirect here.
 */

import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { useApi, apiPost } from "@/hooks/useApi";
import { useFeatures } from "@/hooks/useFeatures";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WorkItemsTabs } from "@/components/WorkItemsTabs";
import { PendingBadge } from "@/components/WorkDefDefinition";
import { StoryBoard } from "./BoardPage";
import { filterByPending } from "@/lib/pending";
import { isActiveScheduledJob } from "@/lib/work-items";
import { Archive, CalendarClock, FolderOpen, Send } from "lucide-react";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board";
  parent?: { kind: "story" | "schedule"; id: string };
  directory?: string | null;
  pending?: boolean;
}

interface Schedule {
  id: string;
  cron: string;
  pending?: boolean;
}

export function PendingPage() {
  const features = useFeatures();
  return (
    <div className="container mx-auto p-4 space-y-4">
      <WorkItemsTabs />
      <p className="text-sm text-muted-foreground">Work held back until you activate it. Nothing here is handed out or fires.</p>
      {features?.stories && (
        <PendingSection title="Stories">
          <StoryBoard view="pending" />
        </PendingSection>
      )}
      {(features?.tasks || features?.schedules) && <PendingWorkDefs tasks={features.tasks} schedules={features.schedules} />}
    </div>
  );
}

/** A titled section of the Pending tab. */
function PendingSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

/** The pending standalone WorkDefs: Solitary tasks and scheduled jobs, one section each. */
function PendingWorkDefs({ tasks, schedules }: { tasks: boolean; schedules: boolean }) {
  const { data, refetch } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs", [], { pollInterval: 10_000 });
  const { data: schedData, refetch: refetchSchedules } = useApi<{ schedules: Schedule[] }>("/api/schedules", [], { pollInterval: 10_000 });
  const defs = data?.workDefs || [];
  const schedById = new Map((schedData?.schedules || []).map(s => [s.id, s]));
  const scheduleOf = (def: WorkDef) => def.parent?.kind === "schedule" ? schedById.get(def.parent.id) : undefined;

  const pendingTasks = filterByPending(defs.filter(d => d.type === "Solitary"), "pending");
  const pendingJobs = defs.filter(d => d.type === "Scheduled" && !isActiveScheduledJob(d, scheduleOf(d)));

  /** One-way: lock the definition (a Solitary task is enqueued straight away). */
  const activateDef = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/activate`, {});
    refetch();
  };
  /** Reversible: the Schedule resumes at its next cron time (no back-fill). */
  const activateSchedule = async (id: string) => {
    await apiPost(`/api/schedules/${encodeURIComponent(id)}/activate`, {});
    refetchSchedules();
  };
  const archive = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/archive`, {});
    refetch();
  };

  return (
    <>
      {tasks && (
        <PendingSection title="Tasks">
          {pendingTasks.length === 0 && <p className="text-sm text-muted-foreground">No pending tasks.</p>}
          <div className="grid gap-3 max-w-3xl">
            {pendingTasks.map(def => (
              <WorkDefRow key={def.id} def={def} onArchive={() => archive(def.id)}>
                <Button size="sm" onClick={() => activateDef(def.id)} title="Lock the definition and enqueue it"><Send className="h-3.5 w-3.5 mr-1" />Activate</Button>
              </WorkDefRow>
            ))}
          </div>
        </PendingSection>
      )}
      {schedules && (
        <PendingSection title="Schedules">
          {pendingJobs.length === 0 && <p className="text-sm text-muted-foreground">No pending scheduled jobs.</p>}
          <div className="grid gap-3 max-w-3xl">
            {pendingJobs.map(def => {
              const sched = scheduleOf(def);
              return (
                <WorkDefRow key={def.id} def={def} cron={sched?.cron} onArchive={() => archive(def.id)}>
                  {/* A pending definition is activated first; then a pending Schedule. */}
                  {def.pending
                    ? <Button size="sm" onClick={() => activateDef(def.id)} title="Lock the definition (it fires on its next cron time once its schedule is active)"><Send className="h-3.5 w-3.5 mr-1" />Activate</Button>
                    : sched && <Button size="sm" onClick={() => activateSchedule(sched.id)} title="Resume the schedule at its next cron time (missed runs are not back-filled)"><Send className="h-3.5 w-3.5 mr-1" />Activate</Button>}
                </WorkDefRow>
              );
            })}
          </div>
        </PendingSection>
      )}
    </>
  );
}

/** One pending WorkDef: title (links to its page), badges, archive, and its activate action. */
function WorkDefRow({ def, cron, onArchive, children }: { def: WorkDef; cron?: string; onArchive: () => void; children: ReactNode }) {
  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardContent className="p-4 flex items-center gap-3">
        <Link to={`/work-defs/${encodeURIComponent(def.id)}`} className="min-w-0 flex-1">
          <p className="font-medium truncate">{def.title}</p>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
            <PendingBadge className="text-[10px]" />
            {cron && <Badge variant="outline" className="text-[10px] flex items-center gap-1"><CalendarClock className="h-2.5 w-2.5" /><code>{cron}</code></Badge>}
            {def.directory && (
              <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1"><FolderOpen className="h-2.5 w-2.5" />{def.directory}</Badge>
            )}
          </div>
        </Link>
        <Button variant="ghost" size="sm" onClick={onArchive} title="Archive"><Archive className="h-3.5 w-3.5" /></Button>
        {children}
      </CardContent>
    </Card>
  );
}
