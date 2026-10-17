/**
 * NavBar — Navigation for the center column: links to main pages and theme toggle.
 * The links, left to right: Thoughts (ideas), Board, Tasks, Schedule, Context.
 * The right-hand icons: pause distribution, Usage (the token/cost dashboard),
 * help, config, theme.
 *
 * Spans only the center column (between the assistant dock and the teammate
 * sidebar), because it only navigates the center (docs/DESIGN.md "Watching and Pairing with a Teammate").
 * The center's width depends on the docks, so it adapts with container queries
 * (App's center column is the `@container`): the wordmark hides when narrow,
 * and the links scroll horizontally rather than wrapping or shoving the icons
 * off-screen.
 * The Pizza Team link (home: Queue | Inbox) carries two count badges from
 * `/api/status` — queued WorkItems (`queuedCount`, neutral) and unread Inbox
 * items (`unreadInboxCount`, accent) — each hidden at zero. They sit on the
 * pizza icon, so they survive the wordmark hiding when the center is narrow.
 * The status poll is shared with the pause toggle; an Inbox read/unread action
 * refetches immediately (lib/inbox.ts INBOX_CHANGED_EVENT).
 * Config is shown as a gear icon beside the theme toggle. Backlog/Archive/
 * Workflows are tabs within the Board surface (see BoardTabs), so the Board
 * link highlights for those routes (and story/task detail) too.
 *
 * Which link is lit comes from lib/nav-section.ts. `/work-defs/*` is shared by
 * several sections, so on a WorkDef page the bar looks up the WorkDef's type
 * (Solitary → Tasks, Scheduled → Schedule).
 */

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { Pizza, Settings, Pause, Play, HelpCircle, ChartColumn } from "lucide-react";
import { apiPost, useApi } from "@/hooks/useApi";
import { navSectionForPath, type NavSection } from "@/lib/nav-section";
import { badgeLabel, INBOX_CHANGED_EVENT } from "@/lib/inbox";

/** The slice of `/api/status` the bar reads (shared/protocol.ts StatusResponse). */
interface NavStatus {
  paused?: boolean;
  queuedCount?: number;
  unreadInboxCount?: number;
}

/** Primary nav items always visible in the bar */
const NAV_ITEMS: Array<{ path: string; label: string; section: NavSection }> = [
  { path: "/thoughts", label: "Thoughts", section: "thoughts" },
  { path: "/board", label: "Board", section: "board" },
  { path: "/tasks", label: "Tasks", section: "tasks" },
  { path: "/schedule", label: "Schedule", section: "schedule" },
  { path: "/context", label: "Context", section: "context" },
];

export function NavBar() {
  const location = useLocation();
  const workDefType = useWorkDefTypeForPath(location.pathname);
  const activeSection = navSectionForPath(location.pathname, { search: location.search, workDefType });
  // One status poll feeds both the home-link badges and the pause toggle.
  const { data: status, refetch: refetchStatus } = useApi<NavStatus>("/api/status", [], { pollInterval: 10_000 });
  useEffect(() => {
    globalThis.addEventListener(INBOX_CHANGED_EVENT, refetchStatus);
    return () => globalThis.removeEventListener(INBOX_CHANGED_EVENT, refetchStatus);
  }, [refetchStatus]);

  const linkClass = (section: NavSection) =>
    `px-2 @2xl:px-3 py-1.5 text-sm rounded-md transition-colors ${
      activeSection === section
        ? "bg-accent text-accent-foreground font-medium"
        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
    }`;

  return (
    <header className="shrink-0 border-b border-border bg-muted">
      <div className="flex h-14 items-center gap-2 px-3 @2xl:px-4">
        <Link to="/" className="flex shrink-0 items-center gap-3 font-semibold mr-3 @2xl:mr-4" title="Pizza Team">
          <span className="relative">
            <Pizza className="h-5 w-5" />
            <HomeBadges queued={status?.queuedCount} unread={status?.unreadInboxCount} />
          </span>
          <span className="hidden @2xl:inline whitespace-nowrap">Pizza Team</span>
        </Link>

        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {NAV_ITEMS.map((item) => (
            <Link key={item.path} to={item.path} className={`shrink-0 whitespace-nowrap ${linkClass(item.section)}`}>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Pause/play, help, config gear, theme toggle */}
        <div className="flex shrink-0 items-center @2xl:gap-1">
          <PauseButton paused={!!status?.paused} onToggled={refetchStatus} />
          {/* Usage dashboard (tokens + cost per day). */}
          <Link
            to="/usage"
            className={`p-1.5 @2xl:p-2 rounded-md transition-colors ${
              location.pathname === "/usage"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            }`}
            title="Usage"
          >
            <ChartColumn className="h-4 w-4" />
          </Link>
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

/**
 * On `/work-defs/:id`, the WorkDef's type (Solitary/Scheduled/…), which decides
 * the lit nav section; null elsewhere or until it loads. Fetched here (rather
 * than pushed up from the page) so deep links highlight correctly too.
 */
function useWorkDefTypeForPath(pathname: string): string | null {
  const match = /^\/work-defs\/([^/]+)\/?$/.exec(pathname);
  const id = match?.[1] && match[1] !== "new" ? decodeURIComponent(match[1]) : null;
  const [loaded, setLoaded] = useState<{ id: string; type: string | null } | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/work-defs/${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { workDef?: { type?: string } } | null) => {
        if (!cancelled) setLoaded({ id, type: json?.workDef?.type ?? null });
      })
      .catch(() => { if (!cancelled) setLoaded({ id, type: null }); });
    return () => { cancelled = true; };
  }, [id]);

  // Ignore a result for a different WorkDef (stale until the new fetch lands).
  return id && loaded?.id === id ? loaded.type : null;
}

/**
 * The two count badges pinned to the pizza icon's corners: queued work
 * (neutral, bottom-right) and unread Inbox items (accent, top-right). Each is
 * hidden at zero; the counts' meaning is in title/aria-label since the badges
 * are only numbers.
 */
function HomeBadges({ queued, unread }: { queued?: number; unread?: number }) {
  const queuedLabel = badgeLabel(queued);
  const unreadLabel = badgeLabel(unread);
  const pill = "absolute -right-2.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ring-2 ring-muted tabular-nums";
  return (
    <>
      {unreadLabel && (
        <span
          className={`${pill} -top-2 bg-primary text-primary-foreground`}
          title={`${unread} unread in Inbox`}
          aria-label={`${unread} unread in Inbox`}
        >
          {unreadLabel}
        </span>
      )}
      {queuedLabel && (
        <span
          className={`${pill} -bottom-2 bg-secondary text-secondary-foreground border border-border`}
          title={`${queued} queued`}
          aria-label={`${queued} queued`}
        >
          {queuedLabel}
        </span>
      )}
    </>
  );
}

/**
 * Toggle button for pausing/resuming task distribution. Reflects the daemon's
 * real state (`/api/status` → `paused`, polled by NavBar): it used to assume
 * "running" on every page load, so a paused daemon showed a pause button that
 * paused nothing.
 */
function PauseButton({ paused, onToggled }: { paused: boolean; onToggled: () => void }) {
  const toggle = async () => {
    const endpoint = paused ? "/api/control/resume" : "/api/control/pause";
    await apiPost(endpoint, {});
    onToggled();
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
