/**
 * TabbedPageLayout — The shared frame for tabbed surfaces (Work and
 * Configuration): a title row and a tab bar pinned to the upper-left of the
 * content area, with the active tab's body below.
 *
 * Why it exists: each tab used to set its own outer container (full width vs.
 * a centered `max-w-3xl`, `p-4` vs. `p-6`), and because the title and tab bar
 * lived inside that container they jumped around when switching tabs. Here the
 * header never depends on the body's width — the padding is fixed, nothing is
 * centered, and every tab renders the same title — so the header sits at the
 * same x/y on every tab. The body may cap its own width (`bodyClassName`, e.g.
 * `max-w-3xl` for narrow forms) but stays left-aligned with the header; leave
 * it unset for full-width bodies like the Board.
 */

import type { ReactNode } from "react";

export function TabbedPageLayout({ icon, title, tabs, bodyClassName = "", children }: {
  /** Icon shown before the title (a lucide icon element). */
  icon?: ReactNode;
  /** The surface's title — the same on every tab, so nothing below shifts vertically. */
  title: string;
  /** The tab bar (e.g. WorkItemsTabs or RouteTabs). */
  tabs: ReactNode;
  /** Extra classes for the body, typically a max width. Never add `mx-auto`. */
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="p-6 space-y-4" data-testid="tabbed-page">
      <header className="space-y-4" data-testid="tabbed-page-header">
        <div className="flex items-center gap-2">
          {icon}
          <h1 className="text-2xl font-bold">{title}</h1>
        </div>
        {tabs}
      </header>
      <div className={`space-y-4 ${bodyClassName}`}>{children}</div>
    </div>
  );
}
