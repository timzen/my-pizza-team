/**
 * NavBar — Top navigation bar with links to main pages and theme toggle.
 */

import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { Pizza } from "lucide-react";

const NAV_ITEMS = [
  { path: "/", label: "Home" },
  { path: "/board", label: "Board" },
  { path: "/team", label: "Team" },
  { path: "/memory", label: "Memory" },
];

export function NavBar() {
  const location = useLocation();

  return (
    <header className="border-b border-border bg-card">
      <div className="container mx-auto flex h-14 items-center px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold mr-6">
          <Pizza className="h-5 w-5" />
          <span>Pizza Team</span>
        </Link>

        <nav className="flex items-center gap-1 flex-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                location.pathname === item.path
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <ThemeToggle />
      </div>
    </header>
  );
}
