/**
 * RootPage — The team's home (`/`): `Queue | Inbox` tabs.
 *
 * Left to right, the life of a piece of work: the Queue is work in flight
 * (QueuePage — also summarized in the dock's strip), and the Inbox reviews
 * finished work. The active tab follows the route (`/queue`, `/` = Inbox) so
 * both stay deep-linkable.
 *
 * Several things deliberately live elsewhere now: the **assistant chat** and the
 * **quick-create buttons** moved into the left `SideDock`, so starting work
 * is possible from any page rather than only from home. **Thoughts** (the idea
 * canvas) is a top-level nav item (ThoughtsRoute in App.tsx). Foundational setup
 * also moved out: Workflows is a Board sub-tab and Context is a top-level nav item.
 */

import { useLocation } from "react-router-dom";
import { RouteTabs } from "@/components/RouteTabs";
import { InboxPage } from "./InboxPage";
import { QueuePage } from "./QueuePage";

const TABS = [
  { path: "/queue", label: "Queue" },
  // "/" is the Inbox tab: active whenever we're not on another root tab.
  { path: "/", label: "Inbox", isActive: (pathname: string) => pathname !== "/queue" },
];

export function RootPage() {
  const location = useLocation();
  const isQueue = location.pathname === "/queue";

  return (
    <div className="container mx-auto p-6 space-y-4">
      <RouteTabs tabs={TABS} />
      {isQueue ? <QueuePage /> : <InboxPage />}
    </div>
  );
}
