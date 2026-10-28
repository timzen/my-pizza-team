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
 *
 * DetailPageLayout is the same frame for detail pages whose header is a richer
 * row (back button, title, badges, actions) above a DetailTabBar — the WorkDef
 * and Task detail pages. Its header width is a page-level constant (never the
 * active tab's), and only the body caps its own width per tab.
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
  const heading = (
    <div className="flex items-center gap-2">
      {icon}
      <h1 className="text-2xl font-bold">{title}</h1>
    </div>
  );
  return <PageFrame header={heading} tabs={tabs} bodyClassName={bodyClassName}>{children}</PageFrame>;
}

/**
 * DetailPageLayout — The fixed-header frame for a detail page (WorkDef, Task):
 * the page's own header row and its DetailTabBar pinned upper-left, the
 * active tab's body below. Use it so switching tabs never moves the header.
 */
export function DetailPageLayout({ header, tabs, headerClassName = "", bodyClassName = "", children }: {
  /** The title row (back button, title, badges, actions). */
  header: ReactNode;
  /** The tab bar (DetailTabBar). */
  tabs: ReactNode;
  /**
   * The header's width (e.g. `max-w-3xl`). Must be the same on every tab —
   * derive it from the page, never from the active tab. Never add `mx-auto`.
   */
  headerClassName?: string;
  /** The active tab body's max width; may vary per tab. Never add `mx-auto`. */
  bodyClassName?: string;
  children: ReactNode;
}) {
  return <PageFrame header={header} tabs={tabs} headerClassName={headerClassName} bodyClassName={bodyClassName}>{children}</PageFrame>;
}

/**
 * Not-found / empty state for a detail page, framed with the same fixed
 * padding as DetailPageLayout so it sits where the header would.
 */
export function DetailPageMessage({ children }: { children: ReactNode }) {
  return <div className="p-6" data-testid="tabbed-page"><p className="text-muted-foreground">{children}</p></div>;
}

/** The shared frame: fixed `p-6` padding, left-aligned, never centered. */
function PageFrame({ header, tabs, headerClassName = "", bodyClassName = "", children }: {
  header: ReactNode;
  tabs: ReactNode;
  headerClassName?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="p-6 space-y-4" data-testid="tabbed-page">
      <header className={`space-y-4 ${headerClassName}`} data-testid="tabbed-page-header">
        {header}
        {tabs}
      </header>
      <div className={`space-y-4 ${bodyClassName}`}>{children}</div>
    </div>
  );
}
