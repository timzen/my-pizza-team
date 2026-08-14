/**
 * ThoughtsPanel — the agent's reasoning (the payload behind the `…`).
 *
 * Deliberately plain: monospace, dimmed, auto-scrolled. This is raw thinking, not
 * a message — never markdown-rendered, never persisted.
 *
 * On open it fetches `/api/assistant/thoughts` and merges with whatever the live
 * stream has. That fetch matters: the SSE stream only carries chunks emitted while
 * *this tab* was listening, so after a reload — or if the dock connected mid-run —
 * the daemon holds the buffer and the panel would otherwise look empty. When the
 * server snapshot is longer than what we streamed, it wins.
 *
 * An empty result is reported honestly rather than as a blank box: most often the
 * model simply isn't emitting reasoning (thinking level off, or a non-reasoning
 * model), which is not the same as "nothing was captured".
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

interface ThoughtsPanelProps {
  /** Reasoning accumulated from the live stream. */
  thoughts: string;
  /** True while the agent is still running (drives the header hint). */
  live: boolean;
  onClose: () => void;
}

export function ThoughtsPanel({ thoughts, live, onClose }: ThoughtsPanelProps) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const [fetched, setFetched] = useState<string | null>(null);

  // One fetch on open: the daemon is the authority on what was captured.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/assistant/thoughts");
        if (!res.ok) return;
        const data = await res.json() as { chunks: string[] };
        if (!cancelled) setFetched((data.chunks || []).join(""));
      } catch {
        // Offline/daemon restart — fall back to whatever the stream gave us.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Prefer whichever source has more: the stream keeps growing during a live run,
  // while the fetch covers everything from before we were listening.
  const text = (fetched && fetched.length > thoughts.length) ? fetched : thoughts;

  // Follow the stream as chunks arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="w-full rounded-lg border border-dashed border-border bg-muted/30 p-2">
      <div className="flex items-center justify-between pb-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {live ? "thinking · live · not saved" : "thinking · not saved"}
        </span>
        <button type="button" onClick={onClose} title="Hide" aria-label="Hide thinking" className="text-muted-foreground hover:text-foreground">
          <X className="h-3 w-3" />
        </button>
      </div>
      <pre ref={scrollRef} className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
        {text || (fetched === null
          ? "Loading…"
          : "No reasoning for this run — this model may not expose its thinking, or thinking is turned off.")}
      </pre>
    </div>
  );
}
