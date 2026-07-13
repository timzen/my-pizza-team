/**
 * StoryViewDialog — Read-only preview of a story shown from the board.
 *
 * Mirrors TaskViewDialog: deliberately NOT an editor. Editing lives on the
 * story's own page (/story/:id). This modal surfaces the description and a
 * link to that page, so glancing at a story from the board stays lightweight.
 */

import { Link } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MarkdownView } from "@/components/ui/markdown-view";
import { ArrowUpRight } from "lucide-react";

interface StoryData {
  id: string;
  title: string;
  description: string;
}

interface StoryViewDialogProps {
  story: StoryData | null;
  open: boolean;
  onClose: () => void;
}

export function StoryViewDialog({ story, open, onClose }: StoryViewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{story?.title}</DialogTitle>
        </DialogHeader>

        {/* Read-only description */}
        {story?.description
          ? <MarkdownView content={story.description} />
          : <p className="text-sm text-muted-foreground italic">No description.</p>}

        {/* Link to the full story page (where editing lives) */}
        {story && (
          <Link
            to={`/story/${story.id}`}
            onClick={onClose}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-2"
          >
            Open story page <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </DialogContent>
    </Dialog>
  );
}
