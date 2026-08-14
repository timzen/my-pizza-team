/**
 * MessageBubble — one chat bubble, iMessage-style.
 *
 * You on the right, the assistant on the left, session markers centered. Hover
 * reveals per-bubble actions: expand to fullscreen (long answers are painful in
 * a 80%-width bubble), reply (quotes this bubble in the composer), and copy.
 *
 * User bubbles carry a delivery receipt: hollow ✓ queued, ✓ delivered (handed to
 * the agent), ✓✓ read (a run that sees it has started). A terminal glyph marks
 * messages that were typed in the agent's tmux pane rather than here.
 */

import { useState } from "react";
import { MarkdownView } from "@/components/ui/markdown-view";
import { BubbleDialog } from "./BubbleDialog";
import { QuotedMessage } from "./QuotedMessage";
import { Check, CheckCheck, Copy, Expand, Reply, Terminal, Clock } from "lucide-react";
import type { AssistantMessage } from "@/lib/assistant-types";

interface MessageBubbleProps {
  message: AssistantMessage;
  /** Start a quoted reply to this bubble. */
  onReply: (message: AssistantMessage) => void;
  /** Scroll to (and flash) the quoted original. */
  onJumpTo: (id: string) => void;
}

export function MessageBubble({ message, onReply, onJumpTo }: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const isUser = message.role === "user";
  const failed = message.state === "failed";

  // Session markers ("New chat as Pizzaiolo", "Resumed …") aren't dialogue.
  if (message.role === "system") {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-muted/60 px-3 py-0.5 text-xs text-muted-foreground">{message.content}</span>
      </div>
    );
  }

  return (
    <div id={`msg-${message.id}`} className={`group flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div className={`flex items-end gap-1 max-w-[85%] ${isUser ? "flex-row" : "flex-row-reverse"}`}>
        {/* Actions sit outside the bubble so they never cover content. */}
        <div className="flex flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton title="Reply to this message" onClick={() => onReply(message)}><Reply className="h-3.5 w-3.5" /></IconButton>
          <IconButton title="Expand" onClick={() => setExpanded(true)}><Expand className="h-3.5 w-3.5" /></IconButton>
          <IconButton title="Copy" onClick={() => navigator.clipboard?.writeText(message.content)}><Copy className="h-3.5 w-3.5" /></IconButton>
        </div>

        <div
          className={[
            "min-w-0 rounded-2xl px-4 py-2 text-sm",
            isUser
              ? "bg-primary text-primary-foreground rounded-br-sm"
              : failed
                ? "bg-destructive/10 text-destructive rounded-bl-sm"
                : "bg-muted text-foreground rounded-bl-sm",
          ].join(" ")}
        >
          {message.quoted && (
            <QuotedMessage
              quoted={message.quoted}
              onClick={() => onJumpTo(message.quoted!.id)}
              tone={isUser ? "onPrimary" : "onMuted"}
            />
          )}
          {isUser
            ? <span className="whitespace-pre-wrap break-words">{message.content}</span>
            : <MarkdownView content={message.content || "The assistant hit an error."} />}
        </div>
      </div>

      {/* Receipt + origin marker under the user's own messages. */}
      {isUser && (
        <span className="mt-0.5 mr-1 flex items-center gap-1 text-muted-foreground">
          {message.origin === "tui" && (
            <span title="Sent from the agent's terminal"><Terminal className="h-3 w-3" /></span>
          )}
          <DeliveryReceipt delivery={message.delivery} />
        </span>
      )}

      <BubbleDialog open={expanded} onOpenChange={setExpanded} message={message} />
    </div>
  );
}

/** ✓ states for a user message. Honest about the wait: delivered ≠ read. */
function DeliveryReceipt({ delivery }: { delivery: AssistantMessage["delivery"] }) {
  if (delivery === "read") {
    return <span title="Read"><CheckCheck className="h-3 w-3 text-primary" /></span>;
  }
  if (delivery === "delivered") {
    return <span title="Delivered to the assistant"><Check className="h-3 w-3" /></span>;
  }
  // Queued: the assistant hasn't picked it up yet (offline, or busy mid-run).
  return <span title="Queued"><Clock className="h-3 w-3 opacity-50" /></span>;
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}
