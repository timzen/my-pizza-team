/**
 * RouteTabs — Shared segmented tab controls.
 *
 * `RouteTabs` is route-driven: each tab is a react-router link, so every tab
 * stays deep-linkable and the active tab follows the current route. Used by
 * the Board surface (Board/Backlog/Archive/Workflows), the Root page (Inbox/
 * Assistant), and the Config page (General/Teammates/Theme).
 *
 * `SegmentedTabs` is the controlled (state-driven) variant with identical
 * styling, for selections that aren't routes (e.g. the assistant persona
 * picker).
 */

import { Link, useLocation } from "react-router-dom";

/** Shared styles so both variants render identically. */
const CONTAINER_CLASS = "inline-flex items-center gap-1 rounded-lg bg-muted p-1";
const itemClass = (active: boolean) =>
  `px-3 py-1 text-sm rounded-md transition-colors ${
    active
      ? "bg-background text-foreground font-medium shadow-sm"
      : "text-muted-foreground hover:text-foreground"
  }`;

export interface RouteTab {
  path: string;
  label: string;
  /** Custom active test (e.g. "/" is active for any non-context path). Defaults to exact pathname match. */
  isActive?: (pathname: string) => boolean;
}

export function RouteTabs({ tabs }: { tabs: RouteTab[] }) {
  const location = useLocation();

  return (
    <div className={CONTAINER_CLASS}>
      {tabs.map((tab) => {
        const active = tab.isActive ? tab.isActive(location.pathname) : location.pathname === tab.path;
        return (
          <Link key={tab.path} to={tab.path} className={itemClass(active)}>
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

export interface SegmentedTab {
  /** Stable identity for selection (null is allowed, e.g. a "Default" option). */
  key: string | null;
  label: string;
  /** Optional hover tooltip. */
  title?: string;
}

export function SegmentedTabs({ tabs, active, disabled, onSelect }: {
  tabs: SegmentedTab[];
  active: string | null;
  /** Disable all tabs (e.g. while a selection is being applied). */
  disabled?: boolean;
  onSelect: (key: string | null) => void;
}) {
  return (
    <div className={CONTAINER_CLASS}>
      {tabs.map((tab) => (
        <button
          key={tab.key ?? ""}
          type="button"
          disabled={disabled}
          title={tab.title}
          onClick={() => onSelect(tab.key)}
          className={`${itemClass(active === tab.key)} disabled:opacity-50`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
