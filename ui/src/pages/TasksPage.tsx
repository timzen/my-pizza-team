/**
 * TasksPage — Solitary WorkDefs (`/tasks`).
 *
 * Solitary work is standalone one-shot work that doesn't live on the board:
 * define it once, enqueue it (now or later), review the outcome in the Inbox.
 * Each row links to the WorkDef detail page and can be re-run on demand.
 * Polls /api/work-defs and filters to type=Solitary. Supports archive/restore.
 */

import { Link } from "react-router-dom";
import { useState } from "react";
import { useApi, apiPost, apiDelete } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TasksTabs } from "@/components/TasksTabs";
import { TemplatePickerDialog } from "@/components/TemplatePickerDialog";
import { Plus, Play, Zap, FolderOpen, FileText, Archive, ArchiveRestore, Trash2, X } from "lucide-react";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board";
  goal: string;
  directory?: string | null;
  tokenUsage?: { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number };
}

export function TasksPage() {
  const { data, refetch } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs", [], { pollInterval: 10_000 });
  const { data: archivedData, refetch: refetchArchived } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs?status=archived", [], { pollInterval: 30_000 });
  const defs = (data?.workDefs || []).filter(d => d.type === "Solitary");
  const archivedDefs = (archivedData?.workDefs || []).filter(d => d.type === "Solitary");
  const [pickerOpen, setPickerOpen] = useState(false);
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
      <div className="flex items-center justify-between gap-3">
        <TasksTabs />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowArchived(s => !s)} className={showArchived ? "bg-accent" : ""}>
            <Archive className="h-4 w-4 mr-1" />Archived{archivedDefs.length > 0 ? ` (${archivedDefs.length})` : ""}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}><FileText className="h-4 w-4 mr-1" />Task from Template</Button>
          <Button size="sm" render={<Link to="/work-defs/new?type=Solitary" />}><Plus className="h-4 w-4 mr-1" />New Task</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Standalone one-shot work. Define once, run on demand.</p>

      {defs.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <Zap className="h-8 w-8" />
          <p className="text-sm">No solitary tasks yet.</p>
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

      {/* Archived drawer */}
      {showArchived && (
        <div className="fixed right-0 top-0 z-40 flex h-full w-80 flex-col border-l border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border p-3">
            <span className="font-medium">Archived Tasks</span>
            <button onClick={() => setShowArchived(false)} className="rounded p-1 hover:bg-accent/50"><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {archivedDefs.length === 0 && <p className="text-sm text-muted-foreground">Nothing archived.</p>}
            {archivedDefs.map((def) => (
              <div key={def.id} className="rounded-md border p-2">
                <p className="mb-1 text-sm font-medium truncate">{def.title}</p>
                <div className="flex gap-1">
                  <button onClick={() => restore(def.id)} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"><ArchiveRestore className="h-3 w-3" /> Restore</button>
                  <button onClick={() => remove(def.id)} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent text-destructive"><Trash2 className="h-3 w-3" /> Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <TemplatePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />
    </div>
  );
}
