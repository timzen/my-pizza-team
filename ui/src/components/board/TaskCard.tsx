/**
 * TaskCard — Displays a single task in the kanban board.
 * Shows title, assignee, substatus, and a link to the task detail/comments
 * page. Clicking the card body does nothing — opening a task is always an
 * explicit action (the `details →` link; there is no preview modal, the task
 * page is the one place to read/edit a task). Changing state is done by
 * **dragging** the card to another column (the column already names the
 * state, so the card carries no state badge — only the substatus chip for
 * agent states).
 */

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { User } from "lucide-react";
import { taskDragType } from "./task-drag";

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
}

export function TaskCard({ task, storyId }: TaskCardProps) {
  /** Start a drag: the drop target (a swimlane column) performs the move. */
  const handleDragStart = (e: React.DragEvent) => {
    if (!storyId) return;
    e.dataTransfer.setData(taskDragType(storyId), JSON.stringify({ taskId: task.id, fromStatus: task.status }));
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <Card
      className="hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing"
      draggable={!!storyId}
      onDragStart={handleDragStart}
    >
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

        {/* Substatus + view/detail actions. The column names the state, so no
            state badge here — just the within-state position for agent states. */}
        <div className="flex items-center mt-2 pt-2 border-t border-border">
          {task.substatus && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0"
              title={task.substatus === "claimed" ? "A teammate is working on this" : "Waiting for a teammate"}
            >
              {task.substatus}
            </Badge>
          )}
          {/* Explicit navigation — the task page is the one place to read/edit */}
          {storyId && (
            <Link
              to={`/task/${storyId}/${task.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline ml-auto"
            >
              details →
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
