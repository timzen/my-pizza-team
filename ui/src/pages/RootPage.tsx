/**
 * RootPage — Home for the foundational setup: Workflows and the Context
 * library, presented as two tabs. Workflows define how work flows; context
 * entries are the reusable prompts/context injected into agents. Both are
 * "configure once, use everywhere" concerns, so they live at the root.
 *
 * The active tab follows the route (`/` = Workflows, `/context` = Context) so
 * both stay deep-linkable and the workflow detail page can link back here.
 */

import { Link, useLocation } from "react-router-dom";
import { WorkflowsPage } from "./WorkflowsPage";
import { ContextPage } from "./ContextPage";

const TABS = [
  { path: "/", label: "Workflows" },
  { path: "/context", label: "Context" },
];

export function RootPage() {
  const location = useLocation();
  const isContext = location.pathname === "/context";

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((tab) => {
          const active = tab.path === "/context" ? isContext : !isContext;
          return (
            <Link
              key={tab.path}
              to={tab.path}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {isContext ? <ContextPage /> : <WorkflowsPage />}
    </div>
  );
}
