/**
 * lib/assistant-types.ts — Wire types for the assistant chat (chat v2).
 *
 * Mirrors the daemon's `shared/protocol.ts` assistant section. The UI can't
 * import from the daemon package directly (separate tsconfig/build), so these
 * are kept in sync by hand — as elsewhere in the UI.
 */

/** Where a message came from: the web UI, the agent's terminal, the agent, the daemon. */
export type AssistantOrigin = "web" | "tui" | "agent" | "system";

/** Receipt states for a user message: queued → delivered → read. */
export type AssistantDelivery = "queued" | "delivered" | "read";

export interface AssistantMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  origin: AssistantOrigin;
  delivery: AssistantDelivery | null;
  /** 'ok' | 'failed' — only meaningful for assistant bubbles. */
  state: string;
  replyTo: string | null;
  quoted: { id: string; role: "user" | "assistant" | "system"; content: string } | null;
  createdAt: string;
}

/** One continuous conversation, backed by one Pi session and one persona. */
export interface AssistantSession {
  id: string;
  personaId: string | null;
  personaTitle: string | null;
  title: string;
  piSessionPath: string | null;
  status: "active" | "ended";
  snapshotPath: string | null;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
}

/** A frame on GET /api/assistant/stream. */
export type AssistantStreamEvent =
  | { type: "hello"; thinking: boolean; session: AssistantSession | null }
  | { type: "message"; message: AssistantMessage }
  | { type: "message-deleted"; id: string }
  | { type: "delivery"; id: string; delivery: AssistantDelivery }
  | { type: "thinking"; active: boolean; chunk?: string }
  | { type: "session"; session: AssistantSession };

/** A context-library entry; those tagged `persona` are selectable assistants. */
export interface ContextEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  content: string;
}

/** The tag that marks a context entry as a selectable assistant persona. */
export const PERSONA_TAG = "persona";
