/**
 * useUnsavedChangesGuard — While `dirty`, ask before leaving: the browser's own
 * prompt on reload/close (`beforeunload`), and a confirm before following a
 * link that navigates away (lib/unsaved-changes.ts `leavesPage`) — the nav
 * bar, the Config tabs, another source on the Sources tab. Used by the Sources
 * tab's settings form (components/sources/SourcesTab.tsx).
 *
 * Link clicks are caught in the capture phase, before react-router's `<Link>`
 * handler navigates; declining stops the click. The browser's Back button
 * isn't caught (a plain `<BrowserRouter>` has no blocker).
 */

import { useEffect } from "react";
import { leavesPage } from "@/lib/unsaved-changes";

export function useUnsavedChangesGuard(dirty: boolean, message = "Discard your unsaved changes?"): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const click = {
        href: anchor.href || null,
        target: anchor.target,
        newTab: e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
      };
      if (!leavesPage(click, globalThis.location)) return;
      if (!globalThis.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    globalThis.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      globalThis.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);
}
