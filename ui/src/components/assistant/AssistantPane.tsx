/**
 * AssistantPane — The assistant's body in the dock and on the phone: the bubble
 * chat or the terminal, per `assistant.chatMode` (docs/DESIGN.md "Assistant Chat
 * Model"; the choice is lib/assistant-mode.ts `assistantView`).
 *
 * The mode is read live from `/api/status` (useAssistantChatMode), refreshed
 * the moment Config saves, so a switch takes effect without a reload or a
 * daemon restart. The chat stream stays owned by the host either way, so the
 * unread badge and the leader's presence dot keep working in terminal mode.
 *
 * `readable` (the dock at the Bottom, a full-width panel) caps the bubble chat's
 * bubbles and composer at a readable width, centered; the terminal keeps the
 * whole width (a terminal's columns are its own).
 *
 * Either way it's marked `data-chat-pane`, so "Ask the assistant" on an empty
 * screen can put the cursor in its message box (hooks/useStartChat).
 */

import { AssistantChat } from "./AssistantChat";
import { AssistantTerminal } from "./AssistantTerminal";
import { useAssistantChatMode } from "@/hooks/useFeatures";
import { assistantTerminalTarget, assistantView } from "@/lib/assistant-mode";
import type { AssistantStreamState } from "@/hooks/useAssistantStream";
import { CHAT_PANE_ATTR } from "@/hooks/useStartChat";

const CHAT_PANE = { [CHAT_PANE_ATTR]: "" };

export function AssistantPane({
  stream, viewingId, onViewSession, active, readable,
}: {
  stream: AssistantStreamState;
  viewingId: string | null;
  onViewSession: (id: string | null) => void;
  active?: boolean;
  /** Center the chat at a readable width (for a host much wider than a column). */
  readable?: boolean;
}) {
  const mode = useAssistantChatMode();
  if (assistantView(mode, viewingId) === "terminal") {
    return <div className="h-full min-h-0" {...CHAT_PANE}><AssistantTerminal leaderId={assistantTerminalTarget(stream.chatAgent)} /></div>;
  }
  return <div className="h-full min-h-0" {...CHAT_PANE}><AssistantChat stream={stream} viewingId={viewingId} onViewSession={onViewSession} active={active} readable={readable} /></div>;
}
