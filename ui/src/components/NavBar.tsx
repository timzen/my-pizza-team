/**
 * NavBar — Top navigation bar with links to main pages and theme toggle.
 * Config is shown as a gear icon beside the theme toggle. Backlog/Archive
 * are in a dropdown beside the Board link to reduce clutter.
 */

import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { Pizza, Settings, ChevronDown } from "lucide-react";
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
  { path: "/memory", label: "Memory" },
  { path: "/workflows", label: "Workflows" },
  { path: "/assistant", label: "Assistant" },
];

/** Items nested under the "More" dropdown beside Board */
const MORE_ITEMS = [
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

          {/* Dropdown for Backlog & Archive */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={`inline-flex items-center gap-0.5 px-2 py-1.5 text-sm rounded-md transition-colors ${
                MORE_ITEMS.some(i => location.pathname === i.path)
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              More <ChevronDown className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {MORE_ITEMS.map((item) => (
                <DropdownMenuItem key={item.path} render={<Link to={item.path} />}>
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>

        {/* Config gear icon + theme toggle */}
        <div className="flex items-center gap-1">
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
