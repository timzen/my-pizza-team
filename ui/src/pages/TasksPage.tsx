/**
 * TasksPage — Work → Tasks (`/work/tasks`): active Solitary WorkDefs.
 *
 * Solitary work is standalone one-shot work that doesn't live on the board:
 * define it once, enqueue it (now or later), review the outcome in the Inbox.
 * Each row links to the WorkDef detail page and can be re-run on demand.
 * Polls /api/work-defs and filters to type=Solitary, **active only**
 * (lib/pending.ts): pending tasks live on Work → Pending, archived ones on
 * Work → Archived (where they're restored or deleted). A row's archive
 * button moves it there (docs/DESIGN.md "Pending: Write, Review, Activate").
 * Templates are hidden from the UI (being deprecated), so there is no "Task
 * from Template" entry point.
 * Each row shows its run count (`executionCount`, derived by the daemon from the
 * WorkItem table); the **Never run** toggle keeps only count-0 tasks — the "things
 * to do" — and the sort menu orders by run count (lib/run-count.ts; docs/DESIGN.md
 * "Execution Count: Derived, not Counted").
 * Empty, it explains what a standalone task is and offers New task and the
 * chat; with **Never run** on and nothing left, it says nothing matches instead
 * (components/ui/empty-state; docs/DESIGN.md "An Empty Screen Teaches").
 */

import { Link } from "react-router-dom";
import { useState } from "react";
import { useApi, apiPost } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WorkItemsLayout } from "@/components/WorkItemsTabs";
import { filterByPending } from "@/lib/pending";
import { RUN_SORTS, countNeverRun, filterByRuns, runCountLabel, sortByRuns, type RunFilter, type RunSort } from "@/lib/run-count";
import { Plus, Play, Zap, FolderOpen, Archive } from "lucide-react";
import type { WorkDefView } from "@shared/protocol";
import { Tooltip } from "@/components/ui/tooltip";
import { AskAssistantButton, EmptyState, NoMatches } from "@/components/ui/empty-state";
import { listView } from "@/lib/empty-states";

type WorkDef = WorkDefView;

export function TasksPage() {
  const { data, refetch } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs", [], { pollInterval: 10_000 });
  // Active only: pending tasks are on the Pending tab.
  const activeDefs = filterByPending((data?.workDefs || []).filter(d => d.type === "Solitary"), "active");
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [runSort, setRunSort] = useState<RunSort>("default");
  const defs = sortByRuns(filterByRuns(activeDefs, runFilter), runSort);
  const neverRunCount = countNeverRun(activeDefs);
  const view = listView({ loaded: !!data, total: activeDefs.length, shown: defs.length });

  const announce = useAnnounce();
  const run = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/enqueue`, {});
    announce("Run queued");
    refetch();
  };

  const archive = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/archive`, {});
    announce("Archived");
    refetch();
  };

  return (
    <WorkItemsLayout bodyClassName="max-w-3xl">
      <div className="flex items-center justify-between gap-2">
        <p className="mr-auto text-sm text-muted-foreground">Standalone one-shot work. Define once, run on demand.</p>
        <Tooltip content="Show only tasks that have never run">
          <Button
            size="sm"
            variant={runFilter === "never" ? "default" : "outline"}
            aria-pressed={runFilter === "never"}
            onClick={() => setRunFilter(f => f === "never" ? "all" : "never")}
          >
            Never run{neverRunCount > 0 ? ` (${neverRunCount})` : ""}
          </Button>
        </Tooltip>
        <Tooltip content="Sort by run count">
          <select
            value={runSort}
            onChange={(e) => setRunSort(e.target.value as RunSort)}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
            aria-label="Sort tasks"
          >
            {RUN_SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Tooltip>
        <Button size="sm" render={<Link to="/work-defs/new?type=Solitary" />}><Plus className="h-4 w-4 mr-1" />New Task</Button>
      </div>

      {view === "empty" && (
        <EmptyState kind="tasks" icon={Zap}>
          <Button size="sm" render={<Link to="/work-defs/new?type=Solitary" />}><Plus className="h-4 w-4 mr-1" aria-hidden />New task</Button>
          <AskAssistantButton />
        </EmptyState>
      )}
      {view === "no-matches" && <NoMatches onClear={() => setRunFilter("all")} clearLabel="Show all tasks" />}

      <div className="grid gap-3">
        {defs.map(def => (
          <Card key={def.id} className="hover:border-primary/50 transition-colors">
            <CardContent className="p-4 flex items-center gap-3">
              <Link to={`/work-defs/${encodeURIComponent(def.id)}`} className="min-w-0 flex-1">
                <p className="font-medium truncate">{def.title}</p>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  {def.directory && (
                    <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1"><FolderOpen className="h-2.5 w-2.5" />{def.directory}</Badge>
                  )}
                  <Tooltip content={def.lastRunAt ? `Last run ${new Date(def.lastRunAt).toLocaleString()}` : "No WorkItem has been created for this task yet"} describe={false}>
                    <span>
                      {runCountLabel(def.executionCount)}
                    </span>
                  </Tooltip>
                  {def.tokenUsage && def.tokenUsage.totalCostUsd > 0 && (
                    <Tooltip content="Total cost across all runs" describe={false}>
                      <span className="font-mono">${def.tokenUsage.totalCostUsd.toFixed(3)}</span>
                    </Tooltip>
                  )}
                </div>
              </Link>
              <Tooltip content="Archive this task" describe={false}>
                <Button variant="ghost" size="sm" onClick={() => archive(def.id)} aria-label="Archive this task"><Archive className="h-3.5 w-3.5" /></Button>
              </Tooltip>
              <Tooltip content="Enqueue a fresh run">
                <Button variant="outline" size="sm" onClick={() => run(def.id)}><Play className="h-3.5 w-3.5 mr-1" />Run</Button>
              </Tooltip>
            </CardContent>
          </Card>
        ))}
      </div>
    </WorkItemsLayout>
  );
}
