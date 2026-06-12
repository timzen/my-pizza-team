/**
 * NavBar — Top navigation bar with links to main pages and theme toggle.
 * Config is shown as a gear icon beside the theme toggle. Backlog/Archive
 * are in a dropdown beside the Board link to reduce clutter.
 */

import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { Pizza, Settings, CircleEllipsis, Pause, Play, HelpCircle } from "lucide-react";
import { apiPost } from "@/hooks/useApi";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

/** Primary nav items always visible in the bar */
const NAV_ITEMS = [
  { path: "/board", label: "Board" },
  { path: "/team", label: "Agents" },
  { path: "/assistant", label: "Assistant" },
  { path: "/memory", label: "Memory" },
];

/** Items nested under the "More" dropdown beside Board */
const MORE_ITEMS = [
  { path: "/workflows", label: "Workflows" },
  { path: "/backlog", label: "Backlog" },
  { path: "/archived", label: "Archive" },
];

export function NavBar() {
  const location = useLocation();

  const linkClass = (path: string) =>
    `px-3 py-1.5 text-sm rounded-md transition-colors ${
      location.pathname === path
        ? "bg-accent text-accent-foreground font-medium"
        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
    }`;

  return (
    <header className="border-b border-border bg-card">
      <div className="container mx-auto flex h-14 items-center px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold mr-6">
          <Pizza className="h-5 w-5" />
          <span>Pizza Team</span>
        </Link>

        <nav className="flex items-center gap-1 flex-1">
          {NAV_ITEMS.map((item) => (
            <Link key={item.path} to={item.path} className={linkClass(item.path)}>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Pause/play, help, config gear, theme toggle */}
        <div className="flex items-center gap-1">

          {/* Dropdown for Backlog & Archive */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={`inline-flex items-center gap-0.5 px-2 py-1.5 text-sm rounded-md transition-colors ${
                MORE_ITEMS.some(i => location.pathname === i.path)
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              <CircleEllipsis className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {MORE_ITEMS.map((item) => (
                <DropdownMenuItem key={item.path} render={<Link to={item.path} />}>
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          
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
              location.pathname === "/config"
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
