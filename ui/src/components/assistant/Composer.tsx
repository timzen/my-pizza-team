/**
 * Composer — the message box. It never locks.
 *
 * Chat v2 removed the composer lock, the typing pings, and the pre-claim
 * debounce: the user may send at any time, and mid-run messages are steered into
 * the agent's current run by the extension (docs/ASSISTANT_CHAT_V2.md §5.1).
 * Enter sends, Shift+Enter is a newline, Escape clears a pending quote.
 */

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { QuotedMessage } from "./QuotedMessage";
import { Eraser, Send } from "lucide-react";
import type { AssistantMessage } from "@/lib/assistant-types";

interface ComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  /** The bubble being quoted, if any. */
  replyTo: AssistantMessage | null;
  onClearReply: () => void;
  /** False while viewing an ended session (history is read-only). */
  enabled: boolean;
  placeholder: string;
}

export function Composer({ draft, onDraftChange, onSend, replyTo, onClearReply, enabled, placeholder }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Starting a reply should put the cursor in the box immediately.
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && replyTo) {
      e.preventDefault();
      onClearReply();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="pt-3 border-t border-border">
      {replyTo && (
        <div className="pb-2">
          <QuotedMessage quoted={replyTo.quoted ?? { id: replyTo.id, role: replyTo.role, content: replyTo.content }} onClear={onClearReply} />
        </div>
      )}
      <div className="flex gap-2">
        <Textarea
          ref={textareaRef}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={!enabled}
          className="flex-1 resize-none"
        />
        <div className="flex flex-col gap-2 self-end">
          <Button variant="outline" size="icon" onClick={() => onDraftChange("")} disabled={!draft} title="Clear textbox">
            <Eraser className="h-4 w-4" />
          </Button>
          <Button onClick={onSend} size="icon" disabled={!draft.trim() || !enabled} title="Send">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
