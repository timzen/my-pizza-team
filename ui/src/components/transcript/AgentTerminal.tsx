/**
 * AgentTerminal — One agent's live Pi session as a terminal, plus the composer.
 *
 * The body of the watch/pair experience (docs/DESIGN.md "Watching and Pairing
 * with a Teammate"), shared by every agent that has one: a teammate's page
 * (`TeammatePage`, composer only while paired) and the assistant in
 * the dock's Full page view (`AssistantTerminal`, composer always — the
 * leader has no work loop to pause, see daemon/routes/pairing.ts). One component
 * so the two can't drift: same entries, clipping, collapse, and sends.
 *
 * Presentational: the stream (`useTranscriptStream`, which *is* the watching) is
 * owned by the caller, whose header also needs it (running, reconnecting).
 */

import { TranscriptView } from "./TranscriptView";
import { PairComposer } from "./PairComposer";
import { isRunning } from "@/lib/transcript-types";
import { pairComposerKey, type ComposerDraft } from "@/lib/assistant-draft";
import type { TranscriptStreamState } from "@/hooks/useTranscriptStream";

export function AgentTerminal({
  memberId, stream, canSend, empty, recipient, draft,
}: {
  /** The agent watched and messaged (its member id). */
  memberId: string;
  stream: TranscriptStreamState;
  /** Show the composer (a paired teammate; the assistant always). */
  canSend: boolean;
  /** Shown until the session has content. */
  empty?: React.ReactNode;
  /** Who the composer talks to, for its placeholder ("the teammate"). */
  recipient?: string;
  /** The composer's text, held by the caller (the assistant's shared draft); else the composer's own. */
  draft?: ComposerDraft;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <TranscriptView entries={stream.entries} empty={empty} />
      </div>
      {/* Keyed by agent + draft source: another teammate (or source) is a fresh
          composer, so no text carries across (lib/assistant-draft.ts). */}
      {canSend && <PairComposer key={pairComposerKey(memberId, !!draft)} memberId={memberId} running={isRunning(stream.entries)} recipient={recipient} draft={draft} />}
    </div>
  );
}
