/**
 * useRouteFocus — After a route change, move keyboard focus to the new page's
 * `<h1>` (or its `<main>` while the page is still loading), the way a real page
 * load would. Called once by each shell (App's desktop shell, MobileShell) with
 * its `<main>`. When to move — and when not to (in-page tabs, the side dock,
 * the first render) — is lib/route-focus.ts; `focusPageHeading` is also the
 * skip link's target (components/SkipLink).
 */

import { useEffect, type RefObject } from "react";
import { useLocation } from "react-router-dom";
import { KEEP_FOCUS_ATTR, shouldMoveRouteFocus } from "@/lib/route-focus";

/** How long a loading page may take to render its h1 before focus settles on <main>. */
const HEADING_WAIT_MS = 3000;

/** Move focus to the page's heading on each route change that is a new page (see lib/route-focus.ts). */
export function useRouteFocus(mainRef: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    // The previous path lives on <main> rather than in a ref, so StrictMode's
    // mount → unmount → mount sees the same path and doesn't count a move.
    const prevPath = main.dataset.routePath ?? null;
    main.dataset.routePath = location.pathname;
    const active = document.activeElement;
    const focusInKeepRegion = !!active && active !== document.body && active.isConnected && !!active.closest(`[${KEEP_FOCUS_ATTR}]`);
    if (!shouldMoveRouteFocus({ prevPath, nextPath: location.pathname, state: location.state, focusInKeepRegion })) return;
    return focusPageHeading(main);
  }, [location.key, location.pathname, location.state, mainRef]);
}

/**
 * Focus `main`'s first `<h1>`; if it hasn't rendered yet (the page is waiting on
 * its data), focus `main` itself and move on to the h1 when it appears — unless
 * focus has gone elsewhere meanwhile. Returns a cancel function.
 */
export function focusPageHeading(main: HTMLElement): () => void {
  const toHeading = () => {
    const h1 = main.querySelector<HTMLElement>("h1");
    if (!h1) return false;
    focusTarget(h1);
    return true;
  };
  if (toHeading()) return () => {};
  focusTarget(main);
  const observer = new MutationObserver(() => {
    if (document.activeElement !== main || toHeading()) stop();
  });
  const timer = setTimeout(stop, HEADING_WAIT_MS);
  function stop() { observer.disconnect(); clearTimeout(timer); }
  observer.observe(main, { childList: true, subtree: true });
  return stop;
}

/**
 * Focus a non-interactive element: `tabindex=-1` makes it focusable by script
 * but not a tab stop, and `data-route-focus` tells index.css it's not a control
 * (no focus ring).
 */
function focusTarget(el: HTMLElement) {
  if (!el.hasAttribute("tabindex")) {
    el.setAttribute("tabindex", "-1");
    el.setAttribute("data-route-focus", "");
  }
  el.focus();
}
