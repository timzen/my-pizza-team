/**
 * ThinkingBubble — the animated `…` shown while the agent is mid-run.
 *
 * Clicking it opens the reasoning peek: the agent's live thought stream. Those
 * chunks are ephemeral by design (in-memory in the daemon, never persisted —
 * docs/ASSISTANT_CHAT_V2.md §3.4), so this is a window, not a record.
 */

import { useState } from "react";
import { ThoughtsPanel } from "./ThoughtsPanel";

export function ThinkingBubble({ thoughts }: { thoughts: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={thoughts ? "Peek at the assistant's thinking" : "Thinking…"}
        className="rounded-2xl rounded-bl-sm bg-muted px-4 py-2 hover:bg-muted/70"
      >
        <span className="inline-flex items-center gap-1 py-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      </button>
      {open && <ThoughtsPanel thoughts={thoughts} onClose={() => setOpen(false)} />}
    </div>
  );
}
