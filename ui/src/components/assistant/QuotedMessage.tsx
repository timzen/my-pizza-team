/**
 * QuotedMessage — the `>` quote rendered above a reply.
 *
 * Used in two places: inside a bubble that quotes an earlier one (click to jump
 * to the original) and in the composer while a quoted reply is being written.
 */

import { X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

interface QuotedMessageProps {
  quoted: { id: string; role: string; content: string };
  /** Jump to the original. Omit in the composer. */
  onClick?: () => void;
  /** Dismiss the quote (composer only). */
  onClear?: () => void;
  /** Which background this sits on, so the border/text stay legible. */
  tone?: "onPrimary" | "onMuted" | "plain";
}

export function QuotedMessage({ quoted, onClick, onClear, tone = "plain" }: QuotedMessageProps) {
  const toneClasses = tone === "onPrimary"
    ? "border-primary-foreground/40 text-primary-foreground/80"
    : "border-muted-foreground/40 text-muted-foreground";

  return (
    <div className={`mb-1 flex items-start gap-2 border-l-2 pl-2 text-xs ${toneClasses}`}>
      <Tooltip content={onClick ? "Jump to the original message" : undefined}>
        <button
          type="button"
          onClick={onClick}
          disabled={!onClick}
          className={`min-w-0 flex-1 text-left ${onClick ? "hover:underline" : "cursor-default"}`}
        >
          <span className="font-medium">{quoted.role === "user" ? "You" : "Assistant"}: </span>
          {/* Two lines max: a quote is a pointer, not a re-read. */}
          <span className="line-clamp-2 align-top">{quoted.content}</span>
        </button>
      </Tooltip>
      {onClear && (
        <Tooltip content="Remove quote" describe={false}>
          <button type="button" onClick={onClear} aria-label="Remove quote" className="shrink-0 hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
