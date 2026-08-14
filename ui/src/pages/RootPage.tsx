/**
 * RootPage — The team's home (`/`): Inbox + Thoughts tabs.
 *
 * The Inbox reviews completed work; Thoughts is the sticky-note canvas. The
 * active tab follows the route (`/` = Inbox, `/thoughts` = Thoughts) so both stay
 * deep-linkable.
 *
 * Two things deliberately live elsewhere now: the **assistant chat** and the
 * **quick-create buttons** moved into the left `AssistantDock`, so starting work
 * is possible from any page rather than only from home. Foundational setup also
 * moved out: Workflows is a Board sub-tab and Context is a top-level nav item.
 */

import { useLocation } from "react-router-dom";
import { RouteTabs } from "@/components/RouteTabs";
import { InboxPage } from "./InboxPage";
import { ThoughtsPage } from "./ThoughtsPage";

const TABS = [
  { path: "/thoughts", label: "Thoughts" },
  // "/" is the Inbox tab: active whenever we're not on another root tab.
  { path: "/", label: "Inbox", isActive: (pathname: string) => pathname !== "/thoughts" },
];

export function RootPage() {
  const location = useLocation();
  const isThoughts = location.pathname === "/thoughts";
  // Thoughts owns a full-height layout (its canvas fills the area); the Inbox is
  // a plain list that scrolls with the page.
  const fillHeight = isThoughts;

  return (
    <div className={`container mx-auto p-6 space-y-4 ${fillHeight ? "flex flex-col h-full min-h-0" : ""}`}>
      {/* Wrap the tab bar so it keeps its content width: as a flex-column child
          on the Thoughts tab it would otherwise stretch full-width (align-items
          stretch). self-start is ignored in the Inbox's normal block flow. */}
      <div className="self-start"><RouteTabs tabs={TABS} /></div>

      {/* ThoughtsPage owns its own full-height layout (fills the bounded flex
          column); the Inbox is a plain list that scrolls. */}
      {isThoughts ? <div className="flex-1 min-h-0"><ThoughtsPage /></div> : <InboxPage />}
    </div>
  );
}
