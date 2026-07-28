/**
 * RootPage — Home for the foundational setup: Workflows and the Context
 * library, presented as two tabs. Workflows define how work flows; context
 * entries are the reusable prompts/context injected into agents. Both are
 * "configure once, use everywhere" concerns, so they live at the root.
 *
 * The active tab follows the route (`/` = Workflows, `/context` = Context) so
 * both stay deep-linkable and the workflow detail page can link back here.
 * Rendered with the shared RouteTabs control for consistency with the Board
 * surface's tabs.
 */

import { useLocation } from "react-router-dom";
import { RouteTabs } from "@/components/RouteTabs";
import { WorkflowsPage } from "./WorkflowsPage";
import { ContextPage } from "./ContextPage";

const TABS = [
  // "/" is the Workflows tab: active whenever we're not on /context.
  { path: "/", label: "Workflows", isActive: (pathname: string) => pathname !== "/context" },
  { path: "/context", label: "Context" },
];

export function RootPage() {
  const location = useLocation();
  const isContext = location.pathname === "/context";

  return (
    <div className="container mx-auto p-6 space-y-4">
      <RouteTabs tabs={TABS} />

      {isContext ? <ContextPage /> : <WorkflowsPage />}
    </div>
  );
}
