/**
 * lib/transcript-types.ts — Client-side mirror of the daemon's live teammate
 * transcript types (daemon/store/transcripts.ts; docs/TEAMMATE_CHAT.md §3).
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
  | { kind: "user"; text: string; origin: "tui" | "extension" }
  | { kind: "run"; state: "start" | "end" }
  | { kind: "message"; text?: string; thinking?: string }
  /** `args` is absent when the call started before anyone was watching. */
  | { kind: "tool"; name: string; args?: unknown; state: "running" | "done" | "error"; result?: string }
);

export type TranscriptStreamEvent =
  | { type: "hello"; entries: TranscriptEntry[] }
  | { type: "entry"; entry: TranscriptEntry };
