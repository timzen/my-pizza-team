/**
 * WorkflowsPage — Lists all workflows with summary info (state count,
 * transition count, default status). Links to individual workflow detail pages.
 */

import { useNavigate } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitBranch } from "lucide-react";

interface WorkflowSummary {
  name: string;
  stateCount: number;
  transitionCount: number;
  isDefault: boolean;
}

export function WorkflowsPage() {
  const { data, loading } = useApi<WorkflowSummary[]>("/api/workflows");
  const navigate = useNavigate();

  if (loading) return <div className="container mx-auto p-6 text-muted-foreground">Loading...</div>;

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <GitBranch className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Workflows</h1>
      </div>

      <div className="space-y-3">
        {data?.map((wf) => (
          <Card
            key={wf.name}
            className="cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => navigate(`/workflows/${wf.name}`)}
          >
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-semibold">{wf.name}</span>
                {wf.isDefault && <Badge variant="secondary">default</Badge>}
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>{wf.stateCount} states</span>
                <span>{wf.transitionCount} transitions</span>
              </div>
            </CardContent>
          </Card>
        ))}
        {data?.length === 0 && (
          <p className="text-muted-foreground text-sm">No workflows configured.</p>
        )}
      </div>
    </div>
  );
}
