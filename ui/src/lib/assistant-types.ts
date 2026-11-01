/**
 * lib/assistant-types.ts — Wire types for the assistant chat (chat v2).
 *
 * Re-exports the assistant section of `shared/protocol.ts`, the daemon's own
 * definitions, so the UI's components keep one short import path.
 */

export type {
  AssistantDelivery,
  AssistantMessage,
  AssistantOrigin,
  AssistantSession,
  AssistantStreamEvent,
} from "@shared/protocol";
