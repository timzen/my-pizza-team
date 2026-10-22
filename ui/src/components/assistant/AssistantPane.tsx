/**
 * AssistantPane — The assistant's body in the dock and on the phone: the bubble
 * chat or the terminal, per `assistant.chatMode` (docs/DESIGN.md "Assistant Chat
 * Model"; the choice is lib/assistant-mode.ts `assistantView`).
 *
 * The mode is read live from `/api/status` (useAssistantChatMode), refreshed
 * the moment Config saves, so a switch takes effect without a reload or a
 * daemon restart. The chat stream stays owned by the host either way, so the
 * unread badge and the leader's presence dot keep working in terminal mode.
 */

import { AssistantChat } from "./AssistantChat";
import { AssistantTerminal } from "./AssistantTerminal";
import { useAssistantChatMode } from "@/hooks/useFeatures";
import { assistantTerminalTarget, assistantView } from "@/lib/assistant-mode";
import type { AssistantStreamState } from "@/hooks/useAssistantStream";

export function AssistantPane({
  stream, viewingId, onViewSession, active,
}: {
  stream: AssistantStreamState;
  viewingId: string | null;
  onViewSession: (id: string | null) => void;
  active?: boolean;
}) {
  const mode = useAssistantChatMode();
  if (assistantView(mode, viewingId) === "terminal") {
    return <AssistantTerminal leaderId={assistantTerminalTarget(stream.chatAgent)} />;
  }
  return <AssistantChat stream={stream} viewingId={viewingId} onViewSession={onViewSession} active={active} />;
}
