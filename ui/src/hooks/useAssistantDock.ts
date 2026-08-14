/**
 * useAssistantDock — shared open/closed state for the assistant dock.
 *
 * The dock lives in the app shell, but other places need to open it — notably the
 * `/assistant` route, kept as a redirect so old links and bookmarks still work.
 * A tiny context beats prop-drilling through the router.
 *
 * The provider components live in `components/assistant/AssistantDockProvider.tsx`
 * (this file stays component-free so fast refresh keeps working).
 */

import { createContext, useContext } from "react";

/** localStorage key for the collapsed/expanded choice (mirrors TeammateSidebar). */
export const ASSISTANT_DOCK_OPEN_KEY = "mpt.assistantDock.open";

export interface AssistantDockValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const AssistantDockContext = createContext<AssistantDockValue | null>(null);

export function useAssistantDock(): AssistantDockValue {
  const ctx = useContext(AssistantDockContext);
  if (!ctx) throw new Error("useAssistantDock must be used inside AssistantDockProvider");
  return ctx;
}
