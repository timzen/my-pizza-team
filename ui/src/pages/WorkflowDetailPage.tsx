/**
 * WorkflowDetailPage — Shows the full detail of a single workflow,
 * including states, transitions, and instruction files.
 * Placeholder for now; will be fleshed out in a later task.
 */

import { useParams, Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { GitBranch, ArrowLeft } from "lucide-react";

interface WorkflowConfig {
  states: string[];
  transitions: Record<string, Record<string, string>>;
  initialState?: string;
  doneState?: string;
  categories?: string[];
  instructions?: Record<string, string>;
}

export function WorkflowDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { data, loading } = useApi<WorkflowConfig>(`/api/workflows/${name}`);

  if (loading) return <div className="container mx-auto p-6 text-muted-foreground">Loading...</div>;
  if (!data) return <div className="container mx-auto p-6 text-muted-foreground">Workflow not found.</div>;

  return (
    <div className="container mx-auto p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Link to="/workflows" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <GitBranch className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Workflow: {name}</h1>
      </div>

      <div className="text-sm text-muted-foreground">
        {data.states.length} states · {Object.values(data.transitions).reduce((sum, t) => sum + Object.keys(t).length, 0)} transitions
      </div>
    </div>
  );
}
