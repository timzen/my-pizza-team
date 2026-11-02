/**
 * RouteTabs — Shared segmented tab controls.
 *
 * `RouteTabs` is route-driven: each tab is a react-router link, so every tab
 * stays deep-linkable and the active tab follows the current route. Used by
 * the Work surface (Board/Tasks/Schedule/Pending/Archived —
 * WorkItemsTabs, lib/work-items.ts), the Root page (Queue/Inbox), and the
 * Config page (General/Teammates/
 * Workflows/Context/Triage/Theme — lib/config-tabs.ts; its tabs pass `isActive`
 * so a workflow's detail route keeps Workflows lit).
 *
 * Switching route tabs is not "a new page" for focus: each tab link marks its
 * navigation keep-focus (lib/route-focus.ts), so the shell doesn't move focus
 * to the heading, and when the new page remounts the tabs (Work's tabs live in
 * each Work page), the active tab takes focus back — Tab, Enter, Tab, Enter
 * walks the tabs. The lit tab is `aria-current="page"`.
 *
 * `SegmentedTabs` is the controlled (state-driven) variant with identical
 * styling, for selections that aren't routes (e.g. the assistant persona
 * picker).
 */

import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { keepFocusState } from "@/lib/route-focus";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Set by a tab link's click, cleared by the next RouteTabs to render: "a tab
 * was just activated here". Not `location.state` alone, which a reload
 * restores — focus must follow a click in this session, never a page load.
 */
let tabActivated = false;

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

export function RouteTabs({ tabs, label }: {
  tabs: RouteTab[];
  /** Names the group of tabs (e.g. "Work sections"). */
  label?: string;
}) {
  const location = useLocation();
  const activeRef = useRef<HTMLAnchorElement>(null);

  // A tab click that remounted these tabs dropped focus to <body>: put it back
  // on the (new) active tab. Focus anywhere else is the user's; leave it.
  useEffect(() => {
    if (!tabActivated) return;
    tabActivated = false;
    const active = document.activeElement;
    if (!active || active === document.body) activeRef.current?.focus();
  }, [location.key]);

  return (
    <nav aria-label={label} className={CONTAINER_CLASS}>
      {tabs.map((tab) => {
        const active = tab.isActive ? tab.isActive(location.pathname) : location.pathname === tab.path;
        return (
          <Link
            key={tab.path}
            ref={active ? activeRef : undefined}
            to={tab.path}
            state={keepFocusState()}
            onClick={() => { tabActivated = true; }}
            aria-current={active ? "page" : undefined}
            className={itemClass(active)}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
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
        <Tooltip key={tab.key ?? ""} content={tab.title}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(tab.key)}
            className={`${itemClass(active === tab.key)} disabled:opacity-50`}
          >
            {tab.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
