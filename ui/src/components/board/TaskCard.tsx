/**
 * TaskCard — Displays a single task in the kanban board.
 * Shows title, assignee, quick status-change buttons with a colored badge,
 * an explicit "view" button (opens a read-only preview modal), and a link to
 * the task detail/comments page. Clicking the card body does nothing — opening
 * a task is always an explicit action.
 */

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { User, ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

/**
 * Derive a color class based on a task's position within its workflow states.
 * First state = muted, last = green, middle states cycle through colors.
 */
function statusColor(status: string, states?: string[]): string {
  if (!states || states.length === 0) return "";
  const index = states.indexOf(status);
  if (index < 0) return "";
  if (index === 0) return "bg-muted text-muted-foreground";
  if (index === states.length - 1) return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
  const midColors = [
    "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
    "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  ];
  return midColors[(index - 1) % midColors.length];
}

interface TaskCardProps {
  task: {
    id: string;
    seq: number;
    title: string;
    status: string;
    /** Within-state position for agent states: ready (waiting) or claimed (leased). */
    substatus?: "ready" | "claimed" | null;
    description?: string;
    assignee: string | null;
    tokenUsage?: { totalCostUsd: number };
  };
  storyId?: string;
  states?: string[];
  /** Open the read-only preview modal for this task. */
  onView?: (taskId: string) => void;
  onStatusChange?: () => void;
}

export function TaskCard({ task, storyId, states, onView, onStatusChange }: TaskCardProps) {
  const currentIndex = states?.indexOf(task.status) ?? -1;

  /** Move task to the previous or next state */
  const moveStatus = async (direction: "prev" | "next", e: React.MouseEvent) => {
    e.stopPropagation();
    if (!states || currentIndex < 0) return;
    const targetIndex = direction === "prev" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= states.length) return;
    await apiPost(`/api/tasks/${encodeURIComponent(task.id)}/move`, { status: states[targetIndex] });
    onStatusChange?.();
  };

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-3">
        {/* Title & ID */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{task.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{task.id}</p>
        </div>

        {/* Assignee, cost */}
        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
          {task.assignee && (
            <span className="flex items-center gap-1">
              <User className="h-3 w-3" />
              {task.assignee}
            </span>
          )}
          {task.tokenUsage && (
            <span className="ml-auto">${task.tokenUsage.totalCostUsd.toFixed(3)}</span>
          )}
        </div>

        {/* Status controls & detail link */}
        <div className="flex items-center mt-2 pt-2 border-t border-border">
          {states && states.length > 0 && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={currentIndex <= 0}
                onClick={(e) => moveStatus("prev", e)}
                title={currentIndex > 0 ? `Move to ${states[currentIndex - 1].replace(/_/g, " ")}` : undefined}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Badge variant="secondary" className={`text-xs ${statusColor(task.status, states)}`}>
                {task.status.replace(/_/g, " ")}
              </Badge>
              {task.substatus && (
                <Badge
                  variant="outline"
                  className="ml-1 text-[10px] px-1 py-0"
                  title={task.substatus === "claimed" ? "A teammate is working on this" : "Waiting for a teammate"}
                >
                  {task.substatus}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={currentIndex >= (states?.length ?? 1) - 1}
                onClick={(e) => moveStatus("next", e)}
                title={currentIndex < (states?.length ?? 1) - 1 ? `Move to ${states[currentIndex + 1].replace(/_/g, " ")}` : undefined}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {/* Explicit view button — opens the read-only preview modal */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 ml-auto"
            onClick={() => onView?.(task.id)}
            title="View task"
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          {storyId && (
            <Link
              to={`/task/${storyId}/${task.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline ml-2"
            >
              details →
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
