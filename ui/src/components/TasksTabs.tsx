/**
 * TasksTabs — Items / Templates presented as tabs of one surface, rendered with
 * the shared RouteTabs control. `/tasks` lists standalone Solitary work
 * (Items); `/templates` lists the reusable molds used to pre-fill a new task.
 * Both stay deep-linkable routes.
 */

import { RouteTabs } from "@/components/RouteTabs";

const TABS = [
  { path: "/tasks", label: "Items", isActive: (p: string) => p === "/tasks" },
  { path: "/templates", label: "Templates", isActive: (p: string) => p.startsWith("/templates") },
];

export function TasksTabs() {
  return <RouteTabs tabs={TABS} />;
}
