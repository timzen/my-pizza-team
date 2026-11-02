/**
 * useUnsavedChangesGuard — While `dirty`, ask before leaving: the browser's own
 * prompt on reload/close (`beforeunload`), and the app's confirm dialog
 * (components/ui/confirm-dialog) before following a link that navigates away
 * (lib/unsaved-changes.ts `leavesPage`) — the nav bar, the Config tabs,
 * another source on the Sources tab. Used by the Sources tab's settings form
 * (components/sources/SourcesTab.tsx) and the persona editor. Returns the
 * dialog element: render it.
 *
 * Link clicks are caught in the capture phase, before react-router's `<Link>`
 * handler navigates, and held while the dialog asks; "Discard" replays the
 * click on the same link (let through this time), so it navigates exactly as
 * it would have. The browser's Back button isn't caught (a plain
 * `<BrowserRouter>` has no blocker).
 */

import { useEffect, type ReactNode } from "react";
import { leavesPage } from "@/lib/unsaved-changes";
import { useConfirm } from "@/components/ui/confirm-dialog";

export function useUnsavedChangesGuard(dirty: boolean, message = "Discard your unsaved changes?"): ReactNode {
  const [confirmDialog, confirm] = useConfirm();
  useEffect(() => {
    if (!dirty) return;
    // The one click being replayed after "Discard": let it through.
    let allowed: HTMLAnchorElement | null = null;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      if (anchor === allowed) { allowed = null; return; }
      const click = {
        href: anchor.href || null,
        target: anchor.target,
        newTab: e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
      };
      if (!leavesPage(click, globalThis.location)) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm({ title: message, confirmLabel: "Discard", cancelLabel: "Keep editing", destructive: true }).then((ok) => {
        if (!ok || !anchor.isConnected) return;
        allowed = anchor;
        anchor.click();
      });
    };
    globalThis.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      globalThis.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message, confirm]);
  return confirmDialog;
}
