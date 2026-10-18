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
 */

import { Link } from "react-router-dom";
import { useState } from "react";
import { useApi, apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WorkItemsLayout } from "@/components/WorkItemsTabs";
import { filterByPending } from "@/lib/pending";
import { RUN_SORTS, countNeverRun, filterByRuns, runCountLabel, sortByRuns, type RunFilter, type RunSort } from "@/lib/run-count";
import { Plus, Play, Zap, FolderOpen, Archive } from "lucide-react";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board";
  goal: string;
  directory?: string | null;
  pending?: boolean;
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
  executionCount?: number;
  lastRunAt?: string | null;
}

export function TasksPage() {
  const { data, refetch } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs", [], { pollInterval: 10_000 });
  // Active only: pending tasks are on the Pending tab.
  const activeDefs = filterByPending((data?.workDefs || []).filter(d => d.type === "Solitary"), "active");
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [runSort, setRunSort] = useState<RunSort>("default");
  const defs = sortByRuns(filterByRuns(activeDefs, runFilter), runSort);
  const neverRunCount = countNeverRun(activeDefs);

  const run = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/enqueue`, {});
    refetch();
  };

  const archive = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/archive`, {});
    refetch();
  };

  return (
    <WorkItemsLayout bodyClassName="max-w-3xl">
      <div className="flex items-center justify-between gap-2">
        <p className="mr-auto text-sm text-muted-foreground">Standalone one-shot work. Define once, run on demand.</p>
        <Button
          size="sm"
          variant={runFilter === "never" ? "default" : "outline"}
          aria-pressed={runFilter === "never"}
          onClick={() => setRunFilter(f => f === "never" ? "all" : "never")}
          title="Show only tasks that have never run"
        >
          Never run{neverRunCount > 0 ? ` (${neverRunCount})` : ""}
        </Button>
        <select
          value={runSort}
          onChange={(e) => setRunSort(e.target.value as RunSort)}
          className="h-7 rounded-md border border-border bg-background px-2 text-xs"
          aria-label="Sort tasks"
          title="Sort by run count"
        >
          {RUN_SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <Button size="sm" render={<Link to="/work-defs/new?type=Solitary" />}><Plus className="h-4 w-4 mr-1" />New Task</Button>
      </div>

      {defs.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <Zap className="h-8 w-8" />
          <p className="text-sm">{runFilter === "never" ? "Every task here has run at least once." : "No active solitary tasks."}</p>
        </div>
      )}

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
                  <span title={def.lastRunAt ? `Last run ${new Date(def.lastRunAt).toLocaleString()}` : "No WorkItem has been created for this task yet"}>
                    {runCountLabel(def.executionCount)}
                  </span>
                  {def.tokenUsage && def.tokenUsage.totalCostUsd > 0 && (
                    <span className="font-mono" title="Total cost across all runs">${def.tokenUsage.totalCostUsd.toFixed(3)}</span>
                  )}
                </div>
              </Link>
              <Button variant="ghost" size="sm" onClick={() => archive(def.id)} title="Archive this task"><Archive className="h-3.5 w-3.5" /></Button>
              <Button variant="outline" size="sm" onClick={() => run(def.id)} title="Enqueue a fresh run"><Play className="h-3.5 w-3.5 mr-1" />Run</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </WorkItemsLayout>
  );
}
