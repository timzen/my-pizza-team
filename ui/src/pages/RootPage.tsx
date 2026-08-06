/**
 * RootPage — The team's home (`/`). Two things live here:
 *
 *  1. A quick-create row — the fastest path to enqueue work (new story, a
 *     one-off Solitary task, a Scheduled job) or add a teammate.
 *  2. Inbox + Assistant tabs — review completed work (Inbox) and chat with the
 *     team assistant. The active tab follows the route (`/` = Inbox,
 *     `/assistant` = Assistant) so both stay deep-linkable.
 *
 * Foundational setup (Workflows, Context) moved out of the root: Workflows is a
 * Board sub-tab and Context is a top-level nav item.
 */

import { Link, useLocation } from "react-router-dom";
import { RouteTabs } from "@/components/RouteTabs";
import { Button } from "@/components/ui/button";
import { InboxPage } from "./InboxPage";
import { AssistantPage } from "./AssistantPage";
import { Plus, Zap, CalendarClock, UserPlus } from "lucide-react";

const TABS = [
  // "/" is the Inbox tab: active whenever we're not on /assistant.
  { path: "/", label: "Inbox", isActive: (pathname: string) => pathname !== "/assistant" },
  { path: "/assistant", label: "Assistant" },
];

export function RootPage() {
  const location = useLocation();
  const isAssistant = location.pathname === "/assistant";

  return (
    <div className={`container mx-auto p-6 space-y-4 ${isAssistant ? "flex flex-col h-full min-h-0" : ""}`}>
      {/* Quick-create row — the fastest way to get work moving. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" render={<Link to="/stories/new" />}>
          <Plus className="h-4 w-4 mr-1" /> New Story
        </Button>
        <Button variant="outline" size="sm" render={<Link to="/work-defs/new?type=Solitary" />}>
          <Zap className="h-4 w-4 mr-1" /> Solitary Task
        </Button>
        <Button variant="outline" size="sm" render={<Link to="/work-defs/new?type=Scheduled" />}>
          <CalendarClock className="h-4 w-4 mr-1" /> Scheduled Job
        </Button>
        <Button variant="outline" size="sm" render={<Link to="/spawn" />}>
          <UserPlus className="h-4 w-4 mr-1" /> Spawn Teammate
        </Button>
      </div>

      {/* Wrap the tab bar so it keeps its content width: as a flex-column child
          on the Assistant tab it would otherwise stretch full-width (align-items
          stretch). self-start is ignored in the Inbox's normal block flow. */}
      <div className="self-start"><RouteTabs tabs={TABS} /></div>

      {/* AssistantPage owns its own full-height layout (fills the bounded flex
          column so its composer stays pinned in view); the Inbox is a plain
          list that scrolls with the page. */}
      {isAssistant ? (
        <div className="flex-1 min-h-0"><AssistantPage /></div>
      ) : <InboxPage />}
    </div>
  );
}
