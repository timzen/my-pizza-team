/**
 * TaskCard — Displays a single task in the kanban board.
 * Shows title, assignee, substatus, an explicit "view" button (opens a
 * read-only preview modal), and a link to the task detail/comments page.
 * Clicking the card body does nothing — opening a task is always an explicit
 * action. Changing state is done by **dragging** the card to another column
 * (the column already names the state, so the card carries no state badge —
 * only the substatus chip for agent states).
 */

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { User, Eye } from "lucide-react";

/** Drag payload MIME type; the story id is baked in so a swimlane can accept
 *  only its own tasks during dragover (dataTransfer values are unreadable
 *  until drop, but the *types* are visible). */
export function taskDragType(storyId: string): string {
  return `application/x-mpt-task--${storyId.toLowerCase()}`;
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
  /** Open the read-only preview modal for this task. */
  onView?: (taskId: string) => void;
}

export function TaskCard({ task, storyId, onView }: TaskCardProps) {
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
