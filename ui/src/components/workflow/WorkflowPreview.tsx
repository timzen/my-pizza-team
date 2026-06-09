/**
 * WorkflowPreview — Mini-board preview showing how tasks flow through
 * a workflow's states. Renders sample tasks distributed across columns
 * to illustrate the lifecycle visually.
 *
 * This is purely illustrative (not real data) — styled with dashed borders
 * and faded colors to distinguish from actual board views.
 */

import { Card, CardContent } from "@/components/ui/card";
import type { WorkflowConfig } from "./WorkflowGraph";

interface Props {
  workflow: WorkflowConfig;
}

/** Sample tasks placed across the workflow states to show the lifecycle */
function getSampleTasks(states: string[]): Array<{ title: string; state: string; variant: "done" | "active" | "pending" }> {
  if (states.length === 0) return [];

  const initial = states[0];
  const done = states[states.length - 1];
  // Pick a middle state for the "active" task
  const middleIdx = Math.min(Math.floor(states.length / 2), states.length - 2);
  const active = states.length > 2 ? states[middleIdx] : initial;

  const tasks: Array<{ title: string; state: string; variant: "done" | "active" | "pending" }> = [];

  if (states.length >= 3) {
    tasks.push({ title: "Setup database schema", state: done, variant: "done" });
    tasks.push({ title: "Implement API routes", state: active, variant: "active" });
    tasks.push({ title: "Write integration tests", state: initial, variant: "pending" });
  } else if (states.length === 2) {
    tasks.push({ title: "Setup database schema", state: done, variant: "done" });
    tasks.push({ title: "Implement API routes", state: initial, variant: "pending" });
  } else {
    tasks.push({ title: "Setup database schema", state: initial, variant: "pending" });
  }

  return tasks;
}

const VARIANT_STYLES = {
  done: "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400",
  active: "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400",
  pending: "bg-muted/50 border-border text-muted-foreground",
};

const VARIANT_DOT = {
  done: "bg-green-500",
  active: "bg-blue-500",
  pending: "bg-muted-foreground/40",
};

export function WorkflowPreview({ workflow }: Props) {
  const sampleTasks = getSampleTasks(workflow.states);

  return (
    <Card className="border-dashed">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Workflow Preview</h3>
          <span className="text-xs text-muted-foreground italic">— illustrative</span>
        </div>

        <div className="overflow-x-auto">
          <div className="flex gap-3 min-w-max">
            {workflow.states.map((state) => {
              const tasksInState = sampleTasks.filter((t) => t.state === state);
              return (
                <div
                  key={state}
                  className="flex-1 min-w-[140px] max-w-[180px]"
                >
                  {/* Column header */}
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 px-1">
                    {state}
                  </div>

                  {/* Column body */}
                  <div className="rounded-md border border-dashed border-border/60 bg-muted/20 p-2 min-h-[80px] space-y-2">
                    {tasksInState.map((task) => (
                      <div
                        key={task.title}
                        className={`rounded border px-2 py-1.5 text-xs ${VARIANT_STYLES[task.variant]}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${VARIANT_DOT[task.variant]}`} />
                          <span className="truncate">{task.title}</span>
                        </div>
                      </div>
                    ))}
                    {tasksInState.length === 0 && (
                      <div className="text-xs text-muted-foreground/40 italic text-center py-2">—</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
