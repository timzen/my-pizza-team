/**
 * AssistantTerminal — The assistant at Full page (the dock filling the center;
 * docked it is the bubble chat — lib/assistant-mode.ts `assistantView`).
 *
 * Exactly the teammate watch/pair view (docs/DESIGN.md "Assistant Chat Model",
 * "Watching and Pairing with a Teammate"): `useTranscriptStream` + the shared
 * `AgentTerminal`, pointed at the leader. Having it open is watching — the
 * leader's TranscriptMirror streams only then, opening with a backfill of the
 * current session so far (tool calls and thinking included). The composer is
 * always open (no Pair step: the leader has no work loop to pause) and posts to
 * the same `/api/agents/:id/messages`, which lands the message in the assistant
 * inbox with its queue/steer mode. Its text is the assistant's shared draft
 * (hooks/useAssistantDraft), so an unsent message typed in the docked chat is
 * here, and back again.
 */

import { useTranscriptStream } from "@/hooks/useTranscriptStream";
import { AgentTerminal } from "@/components/transcript/AgentTerminal";
import { useAssistantDraft } from "@/hooks/useAssistantDraft";
import { WifiOff } from "lucide-react";

export function AssistantTerminal({ leaderId }: { leaderId: string }) {
  const stream = useTranscriptStream(leaderId);
  const draft = useAssistantDraft();
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!stream.connected && (
        <p className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1 text-xs text-muted-foreground">
          <WifiOff className="h-3.5 w-3.5" /> reconnecting…
        </p>
      )}
      <div className="min-h-0 flex-1">
        <AgentTerminal
          memberId={leaderId}
          stream={stream}
          canSend
          draft={draft}
          recipient="the assistant"
          empty={<p className="text-muted-foreground">Waiting for activity… say something below.</p>}
        />
      </div>
    </div>
  );
}
