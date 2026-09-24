/**
 * NavBar — Navigation for the center column: links to main pages and theme toggle.
 *
 * Spans only the center column (between the assistant dock and the teammate
 * sidebar), because it only navigates the center (docs/TEAMMATE_CHAT.md §2).
 * The center's width depends on the docks, so it adapts with container queries
 * (App's center column is the `@container`): the wordmark hides when narrow,
 * and the links scroll horizontally rather than wrapping or shoving the icons
 * off-screen.
 * Config is shown as a gear icon beside the theme toggle. Backlog/Archive/
 * Workflows are tabs within the Board surface (see BoardTabs), so the Board
 * link highlights for those routes (and story/task detail) too.
 */

import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { Pizza, Settings, Pause, Play, HelpCircle } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

/** Primary nav items always visible in the bar */
const NAV_ITEMS = [
  // prefixes: routes that count as "within" this section for highlighting.
  // /work-defs routes are intentionally NOT claimed by any single tab because
  // they are shared across Tasks (Solitary), Schedule (Scheduled), and Templates.
  { path: "/board", label: "Board", prefixes: ["/backlog", "/archived", "/workflows", "/story", "/stories", "/task"] },
  { path: "/tasks", label: "Tasks", prefixes: ["/templates"] },
  { path: "/schedule", label: "Schedule", prefixes: [] },
  { path: "/context", label: "Context", prefixes: [] },
];

export function NavBar() {
  const location = useLocation();

  const linkClass = (path: string, prefixes: string[] = []) =>
    `px-2 @2xl:px-3 py-1.5 text-sm rounded-md transition-colors ${
      location.pathname === path || prefixes.some((p) => location.pathname.startsWith(p))
        ? "bg-accent text-accent-foreground font-medium"
        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
    }`;

  return (
    <header className="shrink-0 border-b border-border bg-muted">
      <div className="flex h-14 items-center gap-2 px-3 @2xl:px-4">
        <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold mr-2 @2xl:mr-4" title="Pizza Team">
          <Pizza className="h-5 w-5" />
          <span className="hidden @2xl:inline whitespace-nowrap">Pizza Team</span>
        </Link>

        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {NAV_ITEMS.map((item) => (
            <Link key={item.path} to={item.path} className={`shrink-0 whitespace-nowrap ${linkClass(item.path, item.prefixes)}`}>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Pause/play, help, config gear, theme toggle */}
        <div className="flex shrink-0 items-center @2xl:gap-1">
          <PauseButton />
          <Link
            to="/help"
            className={`p-1.5 @2xl:p-2 rounded-md transition-colors ${
              location.pathname === "/help"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            }`}
            title="Help"
          >
            <HelpCircle className="h-4 w-4" />
          </Link>
          <Link
            to="/config"
            className={`p-1.5 @2xl:p-2 rounded-md transition-colors ${
              location.pathname.startsWith("/config")
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            }`}
            title="Config"
          >
            <Settings className="h-4 w-4" />
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

/** Toggle button for pausing/resuming task distribution */
function PauseButton() {
  const [paused, setPaused] = useState(false);

  const toggle = async () => {
    const endpoint = paused ? "/api/control/resume" : "/api/control/pause";
    await apiPost(endpoint, {});
    setPaused(!paused);
  };

  return (
    <button
      onClick={toggle}
      className={`p-1.5 @2xl:p-2 rounded-md transition-colors ${
        paused
          ? "text-amber-500 hover:text-amber-600 hover:bg-accent/50"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
      }`}
      title={paused ? "Resume task distribution" : "Pause task distribution"}
    >
      {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
    </button>
  );
}
