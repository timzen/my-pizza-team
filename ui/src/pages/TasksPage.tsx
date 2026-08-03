/**
 * TasksPage — Solitary WorkDefs (`/tasks`).
 *
 * Solitary work is standalone one-shot work that doesn't live on the board:
 * define it once, enqueue it (now or later), review the outcome in the Inbox.
 * Each row links to the WorkDef detail page and can be re-run on demand.
 * Polls /api/work-defs and filters to type=Solitary.
 */

import { Link } from "react-router-dom";
import { useApi, apiPost } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Play, Zap, FolderOpen } from "lucide-react";

interface WorkDef {
  id: string;
  title: string;
  type: "Solitary" | "Scheduled" | "Board";
  goal: string;
  directory?: string | null;
}

export function TasksPage() {
  const { data, refetch } = useApi<{ workDefs: WorkDef[] }>("/api/work-defs", [], { pollInterval: 10_000 });
  const defs = (data?.workDefs || []).filter(d => d.type === "Solitary");

  const run = async (id: string) => {
    await apiPost(`/api/work-defs/${encodeURIComponent(id)}/enqueue`, {});
    refetch();
  };

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tasks</h1>
          <p className="text-sm text-muted-foreground">Standalone one-shot work. Define once, run on demand.</p>
        </div>
        <Button size="sm" render={<Link to="/work-defs/new?type=Solitary" />}><Plus className="h-4 w-4 mr-1" />New Task</Button>
      </div>

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
                </div>
              </Link>
              <Button variant="outline" size="sm" onClick={() => run(def.id)} title="Enqueue a fresh run"><Play className="h-3.5 w-3.5 mr-1" />Run</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
