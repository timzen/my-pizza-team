/**
 * lib/transcript-types.ts — Client-side mirror of the daemon's live teammate
 * transcript types (daemon/store/transcripts.ts; docs/TEAMMATE_CHAT.md §3),
 * plus the one derived fact both the view and the page need (isRunning).
 */

interface EntryBase {
  /** Position in the transcript; stable across upserts. */
  seq: number;
  key?: string;
  /** Epoch ms the entry was first seen. */
  at: number;
}

export type TranscriptEntry = EntryBase & (
  | { kind: "session" }
  | { kind: "watch" }
  /** `web` = sent from the pairing composer; `delivery` = how it landed mid-run. */
  | { kind: "user"; text: string; origin: "tui" | "web" | "extension"; delivery?: "steer" | "followUp" }
  | { kind: "run"; state: "start" | "end" }
  | { kind: "message"; text?: string; thinking?: string }
  /** `args` is absent when the call started before anyone was watching. */
  | { kind: "tool"; name: string; args?: unknown; state: "running" | "done" | "error"; result?: string }
);

/** GET /api/agents/:id/pairing/state (docs/TEAMMATE_CHAT.md §4). */
export interface PairingState {
  paired: boolean;
  since: number | null;
  /** A release the teammate hasn't picked up yet (it waits out a run in flight). */
  pendingRelease: "resume" | "complete" | "fail" | null;
}

export type TranscriptStreamEvent =
  | { type: "hello"; entries: TranscriptEntry[] }
  | { type: "entry"; entry: TranscriptEntry };

/** A run is in flight if the latest run marker is a start (a new session resets it). */
export function isRunning(entries: TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "run") return e.state === "start";
    if (e.kind === "session") return false;
  }
  return false;
}
