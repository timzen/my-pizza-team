/**
 * TemplatesPage — Task Templates (`/templates`).
 *
 * A template is a reusable mold for a Solitary task: define its goal /
 * acceptance criteria / context / directory once, then spin up new tasks
 * pre-filled from it. Clicking a template opens its edit page; each row's
 * "New Task" jumps straight to the New Task form seeded from that template.
 * The "New Template" button creates a fresh mold. Polls /api/templates.
 */

import { Link, useNavigate } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TasksTabs } from "@/components/TasksTabs";
import { Plus, FileText, FolderOpen, Zap } from "lucide-react";

interface Template {
  id: string;
  title: string;
  goal: string;
  directory?: string | null;
}

export function TemplatesPage() {
  const navigate = useNavigate();
  const { data } = useApi<{ templates: Template[] }>("/api/templates", [], { pollInterval: 10_000 });
  const templates = data?.templates || [];

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <TasksTabs />
        <Button size="sm" render={<Link to="/work-defs/new?type=Template" />}><Plus className="h-4 w-4 mr-1" />New Template</Button>
      </div>
      <p className="text-sm text-muted-foreground">Reusable molds for common tasks. Pre-fill a new task from one.</p>

      {templates.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <FileText className="h-8 w-8" />
          <p className="text-sm">No templates yet.</p>
        </div>
      )}

      <div className="grid gap-3">
        {templates.map(t => (
          <Card key={t.id} className="hover:border-primary/50 transition-colors">
            <CardContent className="p-4 flex items-center gap-3">
              <Link to={`/templates/${encodeURIComponent(t.id)}`} className="min-w-0 flex-1">
                <p className="font-medium truncate">{t.title}</p>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  {t.directory && (
                    <Badge variant="secondary" className="text-[10px] font-mono flex items-center gap-1"><FolderOpen className="h-2.5 w-2.5" />{t.directory}</Badge>
                  )}
                  {t.goal && <span className="truncate">{t.goal}</span>}
                </div>
              </Link>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/work-defs/new?type=Solitary&template=${encodeURIComponent(t.id)}`)}
                title="Create a new task pre-filled from this template"
              >
                <Zap className="h-3.5 w-3.5 mr-1" />New Task
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
