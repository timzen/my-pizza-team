/**
 * BubbleDialog — one chat bubble, full screen.
 *
 * A long answer (a plan, a table, a code block) is unreadable inside an
 * 85%-width bubble. Expanding renders the same markdown in a wide scrollable
 * dialog with a copy-all button.
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/ui/markdown-view";
import { Copy } from "lucide-react";
import type { AssistantMessage } from "@/lib/assistant-types";

interface BubbleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: AssistantMessage;
}

export function BubbleDialog({ open, onOpenChange, message }: BubbleDialogProps) {
  const who = message.role === "user" ? "You" : "Assistant";
  const when = new Date(message.createdAt).toLocaleString();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{who}</DialogTitle>
          <DialogDescription>{when}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto pr-1">
          {message.role === "user"
            ? <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
            : <MarkdownView content={message.content} />}
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(message.content)}>
            <Copy className="h-4 w-4 mr-1" />Copy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
