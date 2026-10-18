/**
 * WorkItemsTabs — The Work Items surface's sub-tab bar (Board · Tasks ·
 * Schedule · Pending · Archived), rendered with the shared RouteTabs control so
 * every tab is a deep-linkable `/work-items/<tab>` route. Replaced the old
 * BoardTabs (Board/Pending/Archive) and TasksTabs (Items/Templates).
 *
 * Which tabs show follows the feature toggles (lib/work-items.ts
 * `visibleWorkItemsTabs`): Board needs Stories, Tasks needs Tasks, Schedule
 * needs Schedules; Pending and Archived mix every kind, so they stay while any
 * kind is on. Each registered external Work Source adds a read-only tab of its
 * own (`/work-items/source/<id>`, before Pending); none registered, none shown.
 *
 * `WorkItemsLayout` frames every Work Items tab with the shared
 * TabbedPageLayout (title + this tab bar pinned upper-left), so the header sits
 * in the same spot on every tab.
 */

import type { ReactNode } from "react";
import { ListTodo } from "lucide-react";
import { TabbedPageLayout } from "@/components/TabbedPageLayout";

import { RouteTabs } from "@/components/RouteTabs";
import { useExternalSources, useFeatures } from "@/hooks/useFeatures";
import { workItemsTabLinks } from "@/lib/work-items";

export function WorkItemsTabs() {
  const tabs = workItemsTabLinks(useFeatures(), useExternalSources());
  return <RouteTabs tabs={tabs.map(({ path, label, isActive }) => ({ path, label, isActive }))} />;
}

/**
 * The frame for a Work Items tab: the "Work Items" title and tab bar, then the
 * tab's body. `bodyClassName` caps a narrow body's width (left-aligned); omit it
 * for full-width bodies like the Board.
 */
export function WorkItemsLayout({ bodyClassName, children }: { bodyClassName?: string; children: ReactNode }) {
  return (
    <TabbedPageLayout icon={<ListTodo className="h-5 w-5" />} title="Work Items" tabs={<WorkItemsTabs />} bodyClassName={bodyClassName}>
      {children}
    </TabbedPageLayout>
  );
}
