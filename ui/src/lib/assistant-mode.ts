/**
 * lib/assistant-mode.ts — Which UI the assistant (the leader) gets.
 *
 * The dock's size decides it (docs/DESIGN.md "Assistant Chat Model"): docked —
 * a side column, the Bottom panel, the floating panel below `lg`, the phone —
 * is the iMessage-style bubble **chat** (the minimal view); **Full page**
 * (lib/dock-layout.ts `dockFillsCenter`) is the **terminal**, exactly the
 * teammate watch/pair view (TranscriptView + PairComposer via AgentTerminal)
 * pointed at the leader, with the session so far backfilled — tool calls and
 * all (the maximal view). There is no setting and no per-view override; the
 * team-wide `assistant.chatMode` that used to pick it is gone. Pure functions
 * so the choice is testable without React.
 */

/** The assistant pane's two views. */
export type AssistantView = "chat" | "terminal";

/**
 * The leader's member id when no leader is online. It always registers as
 * "leader" (harnesses/pi/src/index.ts), so the terminal view can subscribe —
 * and its composer can queue messages — before it connects.
 */
export const DEFAULT_LEADER_ID = "leader";

/**
 * What the assistant pane shows: the terminal when the dock fills the page
 * (`fullPage`, i.e. `dockFillsCenter(...)` — never below `lg`), else the chat.
 * The terminal shows the live session only — the current session so far (the
 * leader backfills it when the view opens), then live. Reading an earlier
 * session (`viewingId`) is the chat record — the transcript only ever
 * backfills the session the leader is in — so history always renders as the
 * chat, even at full page.
 */
export function assistantView(fullPage: boolean, viewingId: string | null): AssistantView {
  return fullPage && viewingId === null ? "terminal" : "chat";
}

/** The agent id the terminal view watches and messages: the online leader, else the default id. */
export function assistantTerminalTarget(chatAgent: { id: string } | null): string {
  return chatAgent?.id ?? DEFAULT_LEADER_ID;
}
