/**
 * lib/unsaved-changes.ts — When a click on a link would leave a page with
 * unsaved edits (hooks/useUnsavedChangesGuard.ts asks "Discard unsaved
 * changes?" first). The app uses a plain `<BrowserRouter>`, which has no
 * navigation blocker, so the guard watches link clicks instead.
 *
 * Kept pure (no React, no DOM) so the rule is unit-tested
 * (tests/source-settings-ui.test.ts).
 */

/** A clicked link, as the guard sees it. */
export interface LinkClick {
  /** The anchor's resolved `href` (absolute URL), or null for an anchor without one. */
  href: string | null;
  /** The anchor's `target` ("" when absent). */
  target: string;
  /** Modifier keys or a non-primary button: the browser opens a new tab/window. */
  newTab: boolean;
}

/**
 * Would following this link navigate the current tab away from `pathname`?
 * Not for a new tab/window, another origin's page opened elsewhere, a
 * same-page `#hash` link, or a link to the page itself.
 */
export function leavesPage(click: LinkClick, location: { origin: string; pathname: string }): boolean {
  if (!click.href || click.newTab || (click.target !== "" && click.target !== "_self")) return false;
  let url: URL;
  try {
    url = new URL(click.href);
  } catch {
    return false;
  }
  if (url.origin !== location.origin) return true;
  return url.pathname !== location.pathname;
}
