/**
 * MobileChat — The phone view's **Chat** tab (`/m/chat`): the conversation with
 * the leader.
 *
 * The desktop dock's `AssistantChat` as is — it was built for a 300–560px
 * column, so it already fits a phone — under a row with who's answering and the
 * session menu (the dock's tab row carries those on the desktop). The stream is
 * the shell's, so the unread badge stays live on the other tabs.
 */

import { AssistantChat } from "@/components/assistant/AssistantChat";
import { SessionMenu } from "@/components/assistant/SessionMenu";
import type { AssistantStreamState } from "@/hooks/useAssistantStream";

export function MobileChat({
  stream, viewingId, onViewSession, active,
}: {
  stream: AssistantStreamState;
  viewingId: string | null;
  onViewSession: (id: string | null) => void;
  active: boolean;
}) {
  const presence = !stream.connected
    ? { dot: "bg-amber-500", text: "Reconnecting…" }
    : stream.chatAgent
      ? { dot: "bg-green-500", text: `Answered by ${stream.chatAgent.name}` }
      : { dot: "bg-muted-foreground/40", text: "No leader online — messages will queue" };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${presence.dot}`} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{presence.text}</span>
        <SessionMenu viewingId={viewingId} onView={onViewSession} onChanged={stream.refresh} compact />
      </div>
      <div className="min-h-0 flex-1">
        <AssistantChat stream={stream} viewingId={viewingId} onViewSession={onViewSession} active={active} />
      </div>
    </div>
  );
}
