/**
 * useSideDock — shared state for the left SideDock: open/collapsed, and which
 * tab (Assistant or Team) is showing.
 *
 * The dock lives in the app shell, but other places need to drive it — notably
 * the `/assistant` route, kept as a redirect that opens the Assistant tab so old
 * links and bookmarks still work. A tiny context beats prop-drilling.
 *
 * The provider components live in `components/dock/SideDockProvider.tsx` (this
 * file stays component-free so fast refresh keeps working).
 */

import { createContext, useContext } from "react";

/** localStorage key for the collapsed/expanded choice (name predates the Team tab). */
export const SIDE_DOCK_OPEN_KEY = "mpt.assistantDock.open";
/** localStorage key for the last tab. */
export const SIDE_DOCK_TAB_KEY = "mpt.sideDock.tab";

export type SideDockTab = "assistant" | "team";

export interface SideDockValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  tab: SideDockTab;
  setTab: (tab: SideDockTab) => void;
}

export const SideDockContext = createContext<SideDockValue | null>(null);

export function useSideDock(): SideDockValue {
  const ctx = useContext(SideDockContext);
  if (!ctx) throw new Error("useSideDock must be used inside SideDockProvider");
  return ctx;
}
