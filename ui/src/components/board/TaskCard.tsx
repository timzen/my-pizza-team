/**
 * TaskCard — Displays a single task in the kanban board.
 * Shows status badge, assignee, unread indicator, and actions.
 */

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MessageCircle, User } from "lucide-react";

interface TaskCardProps {
  task: {
    id: string;
    seq: number;
    title: string;
    status: string;
    description?: string;
    assignee: string | null;
    hasMessages: boolean;
    tokenUsage?: { totalCostUsd: number };
  };
  onEdit?: (taskId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  todo: "bg-muted text-muted-foreground",
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  needs_input: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  review: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  done: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
};

export function TaskCard({ task, onEdit }: TaskCardProps) {
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
          {task.hasMessages && (
            <span className="flex items-center gap-1 text-orange-500">
              <MessageCircle className="h-3 w-3" />
              unread
            </span>
          )}
          {task.tokenUsage && (
            <span className="ml-auto">${task.tokenUsage.totalCostUsd.toFixed(3)}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
