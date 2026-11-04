/**
 * useSideDock — shared state for the SideDock: where it sits (Left or Right),
 * its mode (collapsed rail or expanded column), which tab (Assistant, Team or
 * Help) is showing, and what the Help tab shows. The layout rules behind
 * position and mode are lib/dock-layout.ts.
 *
 * The dock lives in the app shell, but other places need to drive it — notably
 * the `/assistant` route, kept as a redirect that opens the Assistant tab so old
 * links and bookmarks still work — and every page's ? button, the NavBar's
 * Help, and the `?` shortcut, which open the Help tab on the page's section
 * (lib/help.ts `helpForPath`; docs/DESIGN.md "Help Comes to You"). A tiny
 * context beats prop-drilling.
 *
 * The provider components live in `components/dock/SideDockProvider.tsx` (this
 * file stays component-free so fast refresh keeps working).
 */

import { createContext, useContext } from "react";
import type { DockMode, DockPosition } from "@/lib/dock-layout";

export type { DockMode, DockPosition };

/** localStorage key for the last tab. */
export const SIDE_DOCK_TAB_KEY = "mpt.sideDock.tab";

export type SideDockTab = "assistant" | "team" | "help";

/** A guide section the Help tab can show: a topic, and optionally a heading's anchor in it. */
export interface HelpTarget {
  topic: string;
  anchor?: string;
}

export interface SideDockValue {
  /** Which window edge the dock sits on (desktop only; saved per browser). */
  position: DockPosition;
  setPosition: (position: DockPosition) => void;
  /** Rail, column, or full page (saved per browser). */
  mode: DockMode;
  setMode: (mode: DockMode) => void;
  /** Is the dock's panel showing (`mode !== "collapsed"`)? */
  open: boolean;
  /** Collapse, or open (keeping an already-open mode; lib/dock-layout.ts `modeForOpen`). */
  setOpen: (open: boolean) => void;
  toggle: () => void;
  tab: SideDockTab;
  setTab: (tab: SideDockTab) => void;
  /** The section the Help tab shows: the last one opened on this page, else the page's own. */
  help: HelpTarget;
  /** The current page's section and name (lib/help.ts `helpForPath`; Getting Started off any screen). */
  pageHelp: HelpTarget & { page: string };
  /** Is the Help tab on screen (the dock open on it)? */
  helpOpen: boolean;
  /**
   * Open the Help tab on `target` (default: the page's section) and move focus
   * into it; closing gives focus back to whatever had it here.
   */
  openHelp: (target?: HelpTarget) => void;
  /** Leave the Help tab: back to the tab (and open/collapsed) it was opened from, focus back where it was. */
  closeHelp: () => void;
  /** `closeHelp` when it's open, else `openHelp()` — the ? buttons and the `?` shortcut. */
  toggleHelp: () => void;
  /** For the Help panel: true once after `openHelp` asked for focus to move into it. */
  takeHelpFocus: () => boolean;
  /** Bumped by every `openHelp`, so the panel's focus effect runs even when the section didn't change. */
  helpFocusRequest: number;
  /**
   * Open the dock on the Assistant tab and put the cursor in the message box —
   * an empty screen's "Ask the assistant" (hooks/useStartChat).
   */
  focusChat: () => void;
}

export const SideDockContext = createContext<SideDockValue | null>(null);

/** The dock's shared state; throws outside SideDockProvider. */
export function useSideDock(): SideDockValue {
  const ctx = useContext(SideDockContext);
  if (!ctx) throw new Error("useSideDock must be used inside SideDockProvider");
  return ctx;
}
