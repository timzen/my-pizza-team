/**
 * TaskViewDialog — Read-only preview of a task shown from the board.
 *
 * Deliberately NOT an editor: editing lives on the task's own page
 * (/task/:storyId/:taskId). This modal just surfaces the description and a
 * link to that page, so opening a task from the board is a lightweight glance.
 */

import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MarkdownView } from "@/components/ui/markdown-view";
import { ArrowUpRight } from "lucide-react";

interface TaskData {
  id: string;
  title: string;
  status: string;
  description?: string;
}

interface TaskViewDialogProps {
  task: TaskData | null;
  storyId: string | null;
  open: boolean;
  onClose: () => void;
}

export function TaskViewDialog({ task, storyId, open, onClose }: TaskViewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span>{task?.title}</span>
            {task && <Badge variant="secondary" className="text-xs">{task.status.replace(/_/g, " ")}</Badge>}
          </DialogTitle>
        </DialogHeader>

        {/* Read-only description */}
        {task?.description
          ? <MarkdownView content={task.description} />
          : <p className="text-sm text-muted-foreground italic">No description.</p>}

        {/* Link to the full task page (where editing, comments & files live) */}
        {task && storyId && (
          <Link
            to={`/task/${storyId}/${task.id}`}
            onClick={onClose}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-2"
          >
            Open task page <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </DialogContent>
    </Dialog>
  );
}
