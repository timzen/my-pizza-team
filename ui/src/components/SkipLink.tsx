/**
 * SkipLink — "Skip to content": the first thing Tab reaches on every page
 * (WCAG 2.4.1 Bypass Blocks). Hidden until focused; activating it moves focus
 * to the page's `<h1>` inside `<main>` (hooks/useRouteFocus focusPageHeading),
 * past the dock and the nav. Both shells render one, as their first element.
 * `onBeforeSkip` runs first: the desktop shell uses it to leave the dock's
 * Full page mode, which hides `<main>` (App.tsx `ShellFrame`).
 */

import type { RefObject } from "react";
import { focusPageHeading } from "@/hooks/useRouteFocus";
import { MAIN_CONTENT_ID } from "@/lib/route-focus";

/** The skip link; `onBeforeSkip` must leave `<main>` visible (synchronously) before focus moves into it. */
export function SkipLink({ mainRef, onBeforeSkip }: { mainRef: RefObject<HTMLElement | null>; onBeforeSkip?: () => void }) {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={(e) => {
        // Not a hash navigation: that would put "#main-content" in the URL and
        // focus <main> rather than its heading.
        e.preventDefault();
        onBeforeSkip?.();
        if (mainRef.current) focusPageHeading(mainRef.current);
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg"
    >
      Skip to content
    </a>
  );
}
