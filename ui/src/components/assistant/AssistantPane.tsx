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
 * With no leader connected (the stream is up but names no `chatAgent`), either
 * view has a notice on top — nobody will answer, and messages queue — with
 * **Start the assistant** (StartAssistant). It goes when the leader registers.
 * Not while reading an earlier session, which nobody answers anyway.
 *
 * Either way it's marked `data-chat-pane`, so "Ask the assistant" on an empty
 * screen can put the cursor in its message box (hooks/useStartChat).
 */

import { AssistantChat } from "./AssistantChat";
import { AssistantTerminal } from "./AssistantTerminal";
import { StartAssistant } from "./StartAssistant";
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
  const view = assistantView(mode, viewingId) === "terminal"
    ? <AssistantTerminal leaderId={assistantTerminalTarget(stream.chatAgent)} />
    : <AssistantChat stream={stream} viewingId={viewingId} onViewSession={onViewSession} active={active} readable={readable} />;
  const noLeader = stream.connected && !stream.chatAgent && viewingId === null;
  return (
    <div className="flex h-full min-h-0 flex-col" {...CHAT_PANE}>
      {noLeader && <NoLeaderNotice queued={stream.messages.some((m) => m.role === "user" && m.delivery === "queued")} readable={readable} />}
      <div className="min-h-0 flex-1">{view}</div>
    </div>
  );
}

/** Nobody is online to answer: say so, and offer to start the assistant. */
function NoLeaderNotice({ queued, readable }: { queued: boolean; readable?: boolean }) {
  return (
    <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs" data-no-leader="">
      <div className={readable ? "mx-auto w-full max-w-3xl space-y-1.5" : "space-y-1.5"}>
        <p className="text-muted-foreground">
          No leader is running to answer
          {queued ? ", so your messages are queued; they'll be delivered once it starts." : "; messages you send wait until it starts."}
        </p>
        <StartAssistant size="xs" />
      </div>
    </div>
  );
}
