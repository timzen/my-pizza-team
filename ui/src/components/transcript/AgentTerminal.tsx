/**
 * AgentTerminal — One agent's live Pi session as a terminal, plus the composer.
 *
 * The body of the watch/pair experience (docs/DESIGN.md "Watching and Pairing
 * with a Teammate"), shared by every agent that has one: a teammate's page
 * (`TeammatePage`, composer only while paired) and the assistant in
 * `assistant.chatMode: "terminal"` (`AssistantTerminal`, composer always — the
 * leader has no work loop to pause, see daemon/routes/pairing.ts). One component
 * so the two can't drift: same entries, clipping, collapse, and sends.
 *
 * Presentational: the stream (`useTranscriptStream`, which *is* the watching) is
 * owned by the caller, whose header also needs it (running, reconnecting).
 */

import { TranscriptView } from "./TranscriptView";
import { PairComposer } from "./PairComposer";
import { isRunning } from "@/lib/transcript-types";
import type { TranscriptStreamState } from "@/hooks/useTranscriptStream";

export function AgentTerminal({
  memberId, stream, canSend, empty, recipient,
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
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <TranscriptView entries={stream.entries} empty={empty} />
      </div>
      {canSend && <PairComposer memberId={memberId} running={isRunning(stream.entries)} recipient={recipient} />}
    </div>
  );
}
