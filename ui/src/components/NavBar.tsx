/**
 * NavBar — Top navigation bar with links to main pages and theme toggle.
 * Config is shown as a gear icon beside the theme toggle. Backlog/Archive
 * are tabs within the Board surface (see BoardTabs), so the Board link
 * highlights for those routes too.
 */

import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { Pizza, Settings, Pause, Play, HelpCircle } from "lucide-react";
import { apiPost } from "@/hooks/useApi";

/** Primary nav items always visible in the bar */
const NAV_ITEMS = [
  // matches: other routes that count as "within" this section for highlighting
  { path: "/board", label: "Board", matches: ["/backlog", "/archived"] },
  { path: "/assistant", label: "Assistant", matches: [] },
  { path: "/scratchpad", label: "Scratch Pad", matches: [] },
];

export function NavBar() {
  const location = useLocation();

  const linkClass = (path: string, matches: string[] = []) =>
    `px-3 py-1.5 text-sm rounded-md transition-colors ${
      location.pathname === path || matches.includes(location.pathname)
        ? "bg-accent text-accent-foreground font-medium"
        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
    }`;

  return (
    <header className="border-b border-border bg-muted">
      <div className="container mx-auto flex h-14 items-center px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold mr-6">
          <Pizza className="h-5 w-5" />
          <span>Pizza Team</span>
        </Link>

        <nav className="flex items-center gap-1 flex-1">
          {NAV_ITEMS.map((item) => (
            <Link key={item.path} to={item.path} className={linkClass(item.path, item.matches)}>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Pause/play, help, config gear, theme toggle */}
        <div className="flex items-center gap-1">

          <PauseButton />
          <Link
            to="/help"
            className={`p-2 rounded-md transition-colors ${
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
            className={`p-2 rounded-md transition-colors ${
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
      className={`p-2 rounded-md transition-colors ${
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
