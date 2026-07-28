/**
 * BoardTabs — Board / Backlog / Archive presented as tabs of one surface
 * (three lifecycle views over the same stories: active / parked / done),
 * rendered with the shared RouteTabs control. `/backlog` and `/archived`
 * stay deep-linkable routes.
 */

import { RouteTabs } from "@/components/RouteTabs";

const TABS = [
  { path: "/board", label: "Board" },
  { path: "/backlog", label: "Backlog" },
  { path: "/archived", label: "Archive" },
];

export function BoardTabs() {
  return <RouteTabs tabs={TABS} />;
}
