/**
 * SideDockProvider — holds the left dock's open/collapsed state and active tab
 * for the whole app (both remembered in localStorage), plus the route helper
 * that opens the Assistant tab.
 *
 * App-level state rather than a `useState` in the dock because the
 * `/assistant` route has to open the chat as it redirects.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { SIDE_DOCK_OPEN_KEY, SIDE_DOCK_TAB_KEY, SideDockContext, useSideDock, type SideDockTab } from "@/hooks/useSideDock";

function remember(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function SideDockProvider({ children }: { children: React.ReactNode }) {
  // Default open on the Assistant tab: the chat is the point of the left
  // column, and a first-run user shouldn't have to hunt for it.
  const [open, setOpenState] = useState(() => localStorage.getItem(SIDE_DOCK_OPEN_KEY) !== "0");
  const [tab, setTabState] = useState<SideDockTab>(() => (localStorage.getItem(SIDE_DOCK_TAB_KEY) === "team" ? "team" : "assistant"));

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    remember(SIDE_DOCK_OPEN_KEY, next ? "1" : "0");
  }, []);
  const setTab = useCallback((next: SideDockTab) => {
    setTabState(next);
    remember(SIDE_DOCK_TAB_KEY, next);
  }, []);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const value = useMemo(() => ({ open, setOpen, toggle, tab, setTab }), [open, setOpen, toggle, tab, setTab]);

  return <SideDockContext value={value}>{children}</SideDockContext>;
}

/**
 * Route element for `/assistant`: open the dock on the Assistant tab, then let
 * the wrapped element (a redirect) hand the user back to the Inbox.
 */
export function OpenAssistantTab({ children }: { children: React.ReactNode }) {
  const { setOpen, setTab } = useSideDock();
  // Opening the dock is an external-ish side effect of landing on this route,
  // which is exactly what an effect is for.
  useEffect(() => { setOpen(true); setTab("assistant"); }, [setOpen, setTab]);
  return <>{children}</>;
}
