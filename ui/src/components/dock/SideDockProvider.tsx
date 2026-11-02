/**
 * SideDockProvider — holds the left dock's open/collapsed state and active tab
 * for the whole app (both remembered in localStorage), what its Help tab
 * shows, plus the route helper that opens the Assistant tab.
 *
 * App-level state rather than a `useState` in the dock because the
 * `/assistant` route has to open the chat as it redirects, and every page's ?
 * button (components/help/PageHelpButton) and the NavBar's Help drive the Help
 * tab.
 *
 * **Help** (docs/DESIGN.md "Help Comes to You"): the tab shows the current
 * page's guide section (lib/help.ts `helpForPath`) — or, after a link inside
 * the panel, the section that link named, until you go to another page. The
 * `?` key (when you aren't typing — lib/help.ts `isHelpShortcut`) toggles it.
 * Opening it remembers where you were — the tab, whether the dock was open,
 * and the focused element — and closing it (`?`, Esc in the panel, its close
 * button) puts all three back, so a peek at the help costs nothing.
 *
 * `focusChat` is the other way in from a page: an empty screen's "Ask the
 * assistant" opens the Assistant tab with the cursor in the message box
 * (hooks/useStartChat).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  SIDE_DOCK_OPEN_KEY, SIDE_DOCK_TAB_KEY, SideDockContext, useSideDock, type HelpTarget, type SideDockTab,
} from "@/hooks/useSideDock";
import { useWorkDefTypeForPath } from "@/hooks/useWorkDefType";
import { HELP_HOME_TOPIC, helpForPath, isHelpShortcut } from "@/lib/help";
import { MAIN_CONTENT_ID } from "@/lib/route-focus";
import { focusChatComposer } from "@/hooks/useStartChat";

function remember(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** A stored tab, or the Assistant for anything else. */
function storedTab(): SideDockTab {
  const t = localStorage.getItem(SIDE_DOCK_TAB_KEY);
  return t === "team" || t === "help" ? t : "assistant";
}

/** Where to go back to when the Help closes. */
interface HelpReturn {
  open: boolean;
  tab: SideDockTab;
  focus: HTMLElement | null;
}

export function SideDockProvider({ children }: { children: React.ReactNode }) {
  // Default open on the Assistant tab: the chat is the point of the left
  // column, and a first-run user shouldn't have to hunt for it.
  const [open, setOpenState] = useState(() => localStorage.getItem(SIDE_DOCK_OPEN_KEY) !== "0");
  const [tab, setTabState] = useState<SideDockTab>(storedTab);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    remember(SIDE_DOCK_OPEN_KEY, next ? "1" : "0");
  }, []);
  const setTab = useCallback((next: SideDockTab) => {
    setTabState(next);
    remember(SIDE_DOCK_TAB_KEY, next);
  }, []);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  // ─── Help ───
  const { pathname } = useLocation();
  const workDefType = useWorkDefTypeForPath(pathname);
  const forPage = useMemo(() => helpForPath(pathname, { workDefType }), [pathname, workDefType]);
  // A section picked inside the panel, for the page it was picked on.
  const [picked, setPicked] = useState<{ path: string; target: HelpTarget } | null>(null);
  const pageHelp = useMemo(
    () => forPage ?? { topic: HELP_HOME_TOPIC, page: "Pizza Team" },
    [forPage],
  );
  // On the Help itself there's no page to explain: keep showing what was shown.
  const help: HelpTarget = picked && (picked.path === pathname || !forPage) ? picked.target : pageHelp;
  const helpOpen = open && tab === "help";

  const returnTo = useRef<HelpReturn | null>(null);
  const wantFocus = useRef(false);
  const [helpFocusRequest, setHelpFocusRequest] = useState(0);

  const openHelp = useCallback((target?: HelpTarget) => {
    if (!(open && tab === "help")) {
      const active = document.activeElement;
      returnTo.current = { open, tab, focus: active instanceof HTMLElement && active !== document.body ? active : null };
    }
    setPicked(target ? { path: pathname, target } : null);
    setTab("help");
    setOpen(true);
    wantFocus.current = true;
    setHelpFocusRequest((n) => n + 1);
  }, [open, tab, pathname, setOpen, setTab]);

  const closeHelp = useCallback(() => {
    const back = returnTo.current;
    returnTo.current = null;
    setTab(back && back.tab !== "help" ? back.tab : "assistant");
    if (back) setOpen(back.open);
    // After the dock re-renders: the element that had focus, else the page.
    requestAnimationFrame(() => {
      const el = back?.focus?.isConnected ? back.focus : document.getElementById(MAIN_CONTENT_ID);
      el?.focus();
    });
  }, [setOpen, setTab]);

  const toggleHelp = useCallback(() => (helpOpen ? closeHelp() : openHelp()), [helpOpen, closeHelp, openHelp]);

  // "Ask the assistant" (an empty screen's action): the Assistant tab, cursor in the box.
  const focusChat = useCallback(() => {
    returnTo.current = null;
    setTab("assistant");
    setOpen(true);
    focusChatComposer();
  }, [setOpen, setTab]);

  const takeHelpFocus = useCallback(() => {
    const want = wantFocus.current;
    wantFocus.current = false;
    return want;
  }, []);

  // `?` anywhere but in a text field toggles the Help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isHelpShortcut(e)) return;
      e.preventDefault();
      toggleHelp();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleHelp]);

  const value = useMemo(
    () => ({ open, setOpen, toggle, tab, setTab, help, pageHelp, helpOpen, openHelp, closeHelp, toggleHelp, takeHelpFocus, helpFocusRequest, focusChat }),
    [open, setOpen, toggle, tab, setTab, help, pageHelp, helpOpen, openHelp, closeHelp, toggleHelp, takeHelpFocus, helpFocusRequest, focusChat],
  );

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
