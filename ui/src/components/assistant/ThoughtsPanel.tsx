/**
 * ThoughtsPanel — the agent's live reasoning stream (the payload behind the `…`).
 *
 * Deliberately plain: monospace, dimmed, auto-scrolled. This is raw thinking,
 * not a message — it is never markdown-rendered and never persisted. When the
 * daemon restarts (or a new run starts) the buffer is gone.
 */

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

interface ThoughtsPanelProps {
  thoughts: string;
  onClose: () => void;
}

export function ThoughtsPanel({ thoughts, onClose }: ThoughtsPanelProps) {
  const scrollRef = useRef<HTMLPreElement>(null);

  // Follow the stream as chunks arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thoughts]);

  return (
    <div className="w-full max-w-[85%] rounded-lg border border-dashed border-border bg-muted/30 p-2">
      <div className="flex items-center justify-between pb-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">thinking · not saved</span>
        <button type="button" onClick={onClose} title="Hide" aria-label="Hide thinking" className="text-muted-foreground hover:text-foreground">
          <X className="h-3 w-3" />
        </button>
      </div>
      <pre ref={scrollRef} className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
        {thoughts || "(no reasoning captured — this model may not expose its thinking)"}
      </pre>
    </div>
  );
}
