/**
 * useAssistantDraft — The assistant's unsent message, shared by the chat
 * composer (docked) and the terminal composer (Full page), so switching the
 * dock's size keeps what you typed (lib/assistant-draft.ts).
 */

import { useSyncExternalStore } from "react";
import { assistantDraft } from "@/lib/assistant-draft";

/** `[draft, setDraft]`, like `useState`, but one value for every assistant composer. */
export function useAssistantDraft(): [string, (value: string) => void] {
  const draft = useSyncExternalStore(assistantDraft.subscribe, assistantDraft.get);
  return [draft, assistantDraft.set];
}
