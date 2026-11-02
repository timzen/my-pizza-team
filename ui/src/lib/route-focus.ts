/**
 * route-focus.ts — Where keyboard focus goes when the route changes
 * (docs/ACCESSIBILITY.md "Focus is always visible and never lost";
 * hooks/useRouteFocus does the DOM work).
 *
 * A single-page app swaps the page without a load, so the browser leaves focus
 * on the link you activated — or, when that link was part of the old page, on
 * `<body>`, and the next Tab starts from the top of the document. Moving focus
 * to the new page's `<h1>` (or its `<main>`) puts a keyboard or screen-reader
 * user where a real page load would, and announces the new page.
 *
 * But not every URL change is "a new page":
 *  - the **first render** isn't a navigation (the skip link is the way in);
 *  - a **query or hash change** on the same path is in-page state — a detail
 *    page's Details | Thread tabs (`?tab=`), a selected note — never a move;
 *  - a **route tab** (RouteTabs: Work's and Config's tabs, Queue | Inbox) marks
 *    its navigation `keepFocus`, and puts focus back on the tab itself, so
 *    arrowing through tabs doesn't throw you back to the heading each time;
 *  - focus **in the side dock** (the chat, the team) stays there: the dock is
 *    independent of the center (docs/DESIGN.md "The Shell: a Dock and a
 *    Center"), so a navigation the dock caused, or one that happens while you
 *    type in it, never steals focus from it.
 */

/** The id both shells give their `<main>`: the skip link's href, so it still reads as an in-page link. */
export const MAIN_CONTENT_ID = "main-content";

/** `location.state` key a navigation sets to say "leave focus where it is". */
export const KEEP_FOCUS_STATE = "mptKeepFocus";

/** The attribute that marks a region (the side dock) whose focus a navigation never moves. */
export const KEEP_FOCUS_ATTR = "data-keep-focus";

/** The `location.state` a navigation passes to keep focus where it is (merge it into any other state). */
export function keepFocusState(): Record<string, true> {
  return { [KEEP_FOCUS_STATE]: true };
}

/** Does this `location.state` carry the keep-focus mark? */
export function wantsKeepFocus(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[KEEP_FOCUS_STATE] === true;
}

/** What `shouldMoveRouteFocus` needs to know about one route change. */
export interface RouteFocusChange {
  /** The pathname before (null on the first render). */
  prevPath: string | null;
  nextPath: string;
  /** The new location's state (see KEEP_FOCUS_STATE). */
  state: unknown;
  /** Focus is inside a keep-focus region (the side dock) and still on the page. */
  focusInKeepRegion: boolean;
}

/** Should this route change move focus to the new page's heading? See the file comment. */
export function shouldMoveRouteFocus(change: RouteFocusChange): boolean {
  if (change.prevPath === null) return false;
  if (change.prevPath === change.nextPath) return false;
  if (wantsKeepFocus(change.state)) return false;
  if (change.focusInKeepRegion) return false;
  return true;
}
