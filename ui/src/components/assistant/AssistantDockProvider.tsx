/**
 * AssistantDockProvider — holds the dock's open/closed state for the whole app,
 * plus the small route helper that opens it.
 *
 * State (not just a local `useState` in the dock) because the `/assistant` route
 * has to be able to open the dock as it redirects: the chat is no longer a page.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ASSISTANT_DOCK_OPEN_KEY, AssistantDockContext, useAssistantDock } from "@/hooks/useAssistantDock";

export function AssistantDockProvider({ children }: { children: React.ReactNode }) {
  // Default open: the chat is the point of the left rail, and a first-run user
  // shouldn't have to hunt for a toggle to find the assistant.
  const [open, setOpenState] = useState(() => localStorage.getItem(ASSISTANT_DOCK_OPEN_KEY) !== "0");

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try { localStorage.setItem(ASSISTANT_DOCK_OPEN_KEY, next ? "1" : "0"); } catch { /* private mode */ }
  }, []);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const value = useMemo(() => ({ open, setOpen, toggle }), [open, setOpen, toggle]);

  return <AssistantDockContext value={value}>{children}</AssistantDockContext>;
}

/**
 * Route element for `/assistant`: open the dock, then let the wrapped element
 * (a redirect) hand the user back to the Inbox.
 */
export function OpenAssistantDock({ children }: { children: React.ReactNode }) {
  const { setOpen } = useAssistantDock();
  // Opening the dock is an external-ish side effect of landing on this route,
  // which is exactly what an effect is for.
  useEffect(() => { setOpen(true); }, [setOpen]);
  return <>{children}</>;
}
