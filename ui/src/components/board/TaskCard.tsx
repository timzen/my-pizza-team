/**
 * TaskCard — Displays a single task in the kanban board.
 * Shows status badge, assignee, unread indicator, quick status buttons,
 * and a link to the task detail/comments page.
 */

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MessageCircle, User, ChevronLeft, ChevronRight } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

interface TaskCardProps {
  task: {
    id: string;
    seq: number;
    title: string;
    status: string;
    description?: string;
    assignee: string | null;
    hasComments: boolean;
    tokenUsage?: { totalCostUsd: number };
  };
  storyId?: string;
  states?: string[];
  onEdit?: (taskId: string) => void;
  onStatusChange?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  todo: "bg-muted text-muted-foreground",
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  needs_input: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  review: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  done: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
};

export function TaskCard({ task, storyId, states, onEdit, onStatusChange }: TaskCardProps) {
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
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => onEdit?.(task.id)}
    >
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{task.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{task.id}</p>
          </div>
          <Badge variant="secondary" className={`text-xs shrink-0 ${STATUS_COLORS[task.status] || ""}`}>
            {task.status.replace(/_/g, " ")}
          </Badge>
        </div>

        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
          {task.assignee && (
            <span className="flex items-center gap-1">
              <User className="h-3 w-3" />
              {task.assignee}
            </span>
          )}
          {task.hasComments && storyId && (
            <Link
              to={`/task/${storyId}/${task.id}`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 text-orange-500 hover:underline"
              title="View comments"
            >
              <MessageCircle className="h-3 w-3" />
              unread
            </Link>
          )}
          {task.hasComments && !storyId && (
            <span className="flex items-center gap-1 text-orange-500">
              <MessageCircle className="h-3 w-3" />
              unread
            </span>
          )}
          {task.tokenUsage && (
            <span className="ml-auto">${task.tokenUsage.totalCostUsd.toFixed(3)}</span>
          )}
        </div>

        {/* Quick status-change buttons */}
        {states && states.length > 0 && (
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
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
            <span className="text-xs text-muted-foreground">
              {task.status.replace(/_/g, " ")}
            </span>
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
          </div>
        )}

        {/* Link to task detail / comments page */}
        {storyId && (
          <div className="mt-1.5 text-right">
            <Link
              to={`/task/${storyId}/${task.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              details & comments →
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
