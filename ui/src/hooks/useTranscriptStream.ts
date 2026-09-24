/**
 * useTranscriptStream — Live transcript for one teammate (the watch view).
 *
 * Opening the SSE connection *is* watching: the daemon registers a viewer and
 * the teammate's extension starts mirroring its session (docs/TEAMMATE_CHAT.md
 * §3). The `hello` frame carries the daemon's buffered transcript; `entry`
 * frames are upserts keyed by `seq` (a streaming message or a tool call is
 * re-sent as it changes, in place). EventSource reconnects on its own, and each
 * reconnect's `hello` replaces the local copy, so a dropped frame can't leave
 * the view wrong for long.
 */

import { useEffect, useState } from "react";
import type { TranscriptEntry, TranscriptStreamEvent } from "@/lib/transcript-types";

export interface TranscriptStreamState {
  /** Oldest first. */
  entries: TranscriptEntry[];
  /** False while the SSE connection is down. */
  connected: boolean;
}

export function useTranscriptStream(memberId: string): TranscriptStreamState {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/agents/${encodeURIComponent(memberId)}/transcript/stream`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (frame) => {
      let event: TranscriptStreamEvent;
      try { event = JSON.parse(frame.data) as TranscriptStreamEvent; } catch { return; }
      if (event.type === "hello") {
        setConnected(true);
        setEntries(event.entries);
      } else if (event.type === "entry") {
        setEntries((prev) => upsert(prev, event.entry));
      }
    };
    return () => {
      source.close();
      // A different teammate starts from its own buffer, not this one's.
      setEntries([]);
    };
  }, [memberId]);

  return { entries, connected };
}

/** Replace the entry with the same seq, or append (entries arrive in seq order). */
function upsert(prev: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const i = prev.findIndex((e) => e.seq === entry.seq);
  if (i === -1) return [...prev, entry];
  const next = prev.slice();
  next[i] = entry;
  return next;
}
