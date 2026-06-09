/**
 * WorkflowDetailPage — Shows the full detail of a single workflow,
 * including an SVG-based directed graph visualization of states and transitions.
 */

import { useParams, Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { WorkflowGraph, type WorkflowConfig } from "@/components/workflow/WorkflowGraph";
import { GitBranch, ArrowLeft } from "lucide-react";

export function WorkflowDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { data, loading } = useApi<WorkflowConfig>(`/api/workflows/${name}`);
  const { data: configData } = useApi<{ defaultWorkflow: string }>("/api/config");

  if (loading) return <div className="container mx-auto p-6 text-muted-foreground">Loading...</div>;
  if (!data) return <div className="container mx-auto p-6 text-muted-foreground">Workflow not found.</div>;

  const isDefault = configData?.defaultWorkflow === name;
  const transitionCount = Object.values(data.transitions).reduce(
    (sum, t) => sum + Object.keys(t).length, 0
  );

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/workflows" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <GitBranch className="h-5 w-5" />
        <h1 className="text-2xl font-bold">{name}</h1>
        {isDefault && <Badge variant="secondary">default</Badge>}
      </div>

      <div className="text-sm text-muted-foreground">
        {data.states.length} states · {transitionCount} transitions
      </div>

      {/* Graph visualization */}
      <section>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
          State Graph
        </h2>
        <WorkflowGraph workflow={data} />
      </section>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-green-500" /> any
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-blue-500" /> teammate
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-amber-500" /> lead
        </span>
        <span className="ml-4 flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm border-2 border-green-600 bg-green-100" /> initial
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm border-2 border-blue-600 bg-blue-100" /> done
        </span>
      </div>
    </div>
  );
}
