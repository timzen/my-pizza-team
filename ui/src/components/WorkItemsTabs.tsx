/**
 * WorkItemsTabs — The Work Items surface's sub-tab bar (Board · Tasks ·
 * Schedule · Pending · Archived), rendered with the shared RouteTabs control so
 * every tab is a deep-linkable `/work-items/<tab>` route. Replaced the old
 * BoardTabs (Board/Pending/Archive) and TasksTabs (Items/Templates).
 *
 * Which tabs show follows the feature toggles (lib/work-items.ts
 * `visibleWorkItemsTabs`): Board needs Stories, Tasks needs Tasks, Schedule
 * needs Schedules; Pending and Archived mix every kind, so they stay while any
 * kind is on.
 */

import { RouteTabs } from "@/components/RouteTabs";
import { useFeatures } from "@/hooks/useFeatures";
import { visibleWorkItemsTabs, workItemsTabFromPath } from "@/lib/work-items";

export function WorkItemsTabs() {
  const tabs = visibleWorkItemsTabs(useFeatures());
  return (
    <RouteTabs
      tabs={tabs.map(({ tab, path, label }) => ({ path, label, isActive: (p: string) => workItemsTabFromPath(p) === tab }))}
    />
  );
}
