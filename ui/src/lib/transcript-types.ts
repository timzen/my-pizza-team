/**
 * lib/transcript-types.ts — The live teammate transcript's wire types
 * (shared/protocol.ts; the buffer is daemon/store/transcripts.ts; docs/DESIGN.md
 * "Watching and Pairing with a Teammate"), plus the one derived fact both the
 * view and the page need (isRunning).
 */

import type { PairingStateResponse, TranscriptEntry, TranscriptStreamEvent } from "@shared/protocol";

export type { TranscriptEntry, TranscriptStreamEvent };

/** GET /api/agents/:id/pairing/state (docs/DESIGN.md "Watching and Pairing with a Teammate"). */
export type PairingState = PairingStateResponse;

/** A run is in flight if the latest run marker is a start (a new session resets it). */
export function isRunning(entries: TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "run") return e.state === "start";
    if (e.kind === "session") return false;
  }
  return false;
}
