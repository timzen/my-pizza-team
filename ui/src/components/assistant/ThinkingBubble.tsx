/**
 * ThinkingBubble — the `…` while the agent works, and the way back to what it
 * was thinking once it's done.
 *
 * Two states, because the reasoning buffer outlives the run:
 *  - **thinking** — animated dots; click to watch the live thought stream.
 *  - **settled, but reasoning was captured** — a small muted "thoughts" chip, so
 *    the peek is still reachable after the reply lands. Rendering the affordance
 *    only while `thinking` was true made the feature a race against the reply.
 *
 * Reasoning is ephemeral (in-memory in the daemon, never persisted), so the chip
 * disappears on the next run or a daemon restart. That's the intent — a window,
 * not a record.
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { ThoughtsPanel } from "./ThoughtsPanel";

interface ThinkingBubbleProps {
  /** Live reasoning text accumulated from the stream this session. */
  thoughts: string;
  /** True while the agent is mid-run. */
  thinking: boolean;
}

export function ThinkingBubble({ thoughts, thinking }: ThinkingBubbleProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col items-start gap-1">
      {thinking ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="Peek at the assistant's thinking"
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
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="See what the assistant was thinking"
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Sparkles className="h-3 w-3" />thoughts
        </button>
      )}
      {open && <ThoughtsPanel thoughts={thoughts} live={thinking} onClose={() => setOpen(false)} />}
    </div>
  );
}
