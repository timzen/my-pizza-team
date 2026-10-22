/**
 * lib/assistant-mode.ts — Which UI the assistant (the leader) gets.
 *
 * `assistant.chatMode` (TeamConfig, docs/DESIGN.md "Assistant Chat Model"):
 * `chat` is the iMessage-style bubble chat (the default); `terminal` is exactly
 * the teammate watch/pair view (TranscriptView + PairComposer via AgentTerminal),
 * pointed at the leader. Pure functions so the choice is testable without React;
 * hand-mirrors `resolveAssistantChatMode` in shared/types.ts (tests keep them in
 * step).
 */

/** The assistant's UI (TeamConfig.assistant.chatMode, default applied). */
export type AssistantChatMode = "chat" | "terminal";

/**
 * The leader's member id when no leader is online. It always registers as
 * "leader" (harnesses/pi/src/index.ts), so the terminal view can subscribe —
 * and its composer can queue messages — before it connects.
 */
export const DEFAULT_LEADER_ID = "leader";

/** A reported mode with the default applied: anything but "terminal" (or a too-old daemon's nothing) is chat. */
export function resolveAssistantChatMode(raw: unknown): AssistantChatMode {
  return raw === "terminal" ? "terminal" : "chat";
}

/**
 * What the assistant pane shows. Terminal mode shows the live session only:
 * reading an earlier session (`viewingId`) is the chat record — a transcript
 * has no backfill — so history always renders as the chat. Before the first
 * status answer (`mode` null) it's the default, chat.
 */
export function assistantView(mode: AssistantChatMode | null, viewingId: string | null): AssistantChatMode {
  return mode === "terminal" && viewingId === null ? "terminal" : "chat";
}

/** The agent id the terminal view watches and messages: the online leader, else the default id. */
export function assistantTerminalTarget(chatAgent: { id: string } | null): string {
  return chatAgent?.id ?? DEFAULT_LEADER_ID;
}
