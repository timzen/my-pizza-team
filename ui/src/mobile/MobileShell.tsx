/**
 * MobileShell — The phone view (`/m`): a quick look at the team from an iPhone,
 * not the desktop UI squeezed down (docs/DESIGN.md "A Phone Is a Peek").
 *
 *   ┌──────────────────────────────┐
 *   │ 🍕 Pizza Team  ⏸  ?  ☀  🖥   │  header: pause state, help, theme, desktop view
 *   │ ● 1 at risk · 2 waiting      │  queue summary (taps through to Team)
 *   ├──────────────────────────────┤
 *   │         the active tab       │  each tab scrolls itself
 *   ├──────────────────────────────┤
 *   │ Team  Chat  Thoughts  Inbox  │  bottom tabs, with live badges
 *   └──────────────────────────────┘
 *
 * Built like the desktop dock (components/dock/SideDock): the shell owns the live
 * data — the chat stream, the team, the queue, the unread Inbox count — so every
 * tab's badge stays current whichever tab you're on, and all four tabs stay
 * mounted (the inactive ones hidden) so a half-typed message survives a look at
 * the team. Tabs are routes (lib/mobile.ts `mobileTabOf`), so Back and bookmarks
 * work.
 *
 * Page structure as on the desktop (docs/ACCESSIBILITY.md "Structure"): a skip
 * link first, one `<main>` whose (visually hidden) h1 names the tab, the bottom
 * tabs a labelled `<nav>`, the document title per tab, and focus moved to the
 * h1 when you switch tabs (hooks/useRouteFocus).
 *
 * The guide is here too, at `/m/help[/<topic>]` (pages/HelpPage with the phone
 * root; the ? in the header, which opens the section for the phone view —
 * lib/help.ts `helpForPath` — since there's no dock here to show it beside
 * the page, docs/DESIGN.md "A Phone Is a Peek"): not a tab, so while it's open no tab is current,
 * and the four tabs stay mounted underneath.
 *
 * Opening `/m` clears a "desktop view" preference; the 🖥 button sets it and goes
 * to the full UI, which stops sending a phone at the home page here.
 */

import { useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { useAssistantStream } from "@/hooks/useAssistantStream";
import { useQueue } from "@/hooks/useQueue";
import { useTeamData } from "@/hooks/useTeamData";
import { useAnnounceOffline, useAnnounceQueue, useAnnounceReplies, useAnnounceUnread } from "@/hooks/useLiveAnnouncements";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MOBILE_TAB_PATHS, mobileTabOf, readViewPref, writeViewPref, type MobileTab } from "@/lib/mobile";
import { countUnread } from "@/lib/unread";
import { MobileTeam } from "./MobileTeam";
import { MobileChat } from "./MobileChat";
import { MobileThoughts } from "./MobileThoughts";
import { MobileInbox } from "./MobileInbox";
import { HelpCircle, Inbox, MessageSquare, Monitor, Pause, StickyNote, Users } from "lucide-react";
import { IconButton, IconLink } from "@/components/ui/icon-button";
import { HelpPage } from "@/pages/HelpPage";
import { MOBILE_HELP_ROOT, helpForPath, helpPath, isHelpPath } from "@/lib/help";
import { Tooltip } from "@/components/ui/tooltip";
import { SkipLink } from "@/components/SkipLink";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useRouteFocus } from "@/hooks/useRouteFocus";
import { pageTitleForPath } from "@/lib/page-title";
import { MAIN_CONTENT_ID } from "@/lib/route-focus";

/** Each tab's name: its bottom-tab label, the page's (visually hidden) h1, and the document title. */
const TAB_LABELS: Record<MobileTab, string> = { team: "Team", chat: "Chat", thoughts: "Thoughts", inbox: "Inbox" };

export function MobileShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tab = mobileTabOf(pathname);
  // The guide covers the tabs (they stay mounted underneath); no tab is current.
  const help = isHelpPath(pathname);
  const current = help ? null : tab;
  // The ? opens this view's section of the guide (lib/help.ts helpForPath); on the guide, its start.
  const pageHelp = helpForPath(pathname);
  const helpTo = pageHelp ? helpPath(pageHelp.topic, pageHelp.anchor, MOBILE_HELP_ROOT) : MOBILE_HELP_ROOT;
  const mainRef = useRef<HTMLElement>(null);
  useDocumentTitle(pageTitleForPath(pathname));
  useRouteFocus(mainRef);

  // Being here is the choice of the phone view: forget an earlier "desktop".
  if (readViewPref(globalThis.localStorage) === "desktop") writeViewPref(globalThis.localStorage, null);

  // null = follow the live chat session; an id = read an earlier one.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const stream = useAssistantStream(viewingId ?? undefined);
  const team = useTeamData();
  const queue = useQueue();
  const { data: status } = useApi<{ paused?: boolean }>("/api/status", [], { pollInterval: 10_000 });
  const { data: inbox, refetch: refetchInbox } = useApi<{ total: number }>(
    "/api/work-items?state=COMPLETE,FAILED&read=false&limit=1", [], { pollInterval: 15_000 },
  );
  const paused = !!status?.paused;
  // Tell a screen reader what changed, as the desktop does (docs/ACCESSIBILITY.md "Live announcements").
  useAnnounceReplies(stream.messages, stream.loaded);
  useAnnounceQueue(queue.items, queue.loaded);
  useAnnounceOffline(team.teammates, team.loaded);
  useAnnounceUnread(inbox?.total);

  // Unread chat = replies since you last had the Chat tab open. Re-stamped
  // whenever the tab changes (entering or leaving Chat both count as looking)
  // with the newest message's time — not the clock, which render mustn't read —
  // adjusted during render rather than in an effect so there's no extra pass.
  const [seen, setSeen] = useState(() => ({ tab, at: Date.now() }));
  if (seen.tab !== tab) setSeen({ tab, at: Math.max(seen.at, newestMessageAt(stream.messages)) });
  const unreadChat = countUnread(stream.messages, seen.at, tab === "chat");

  const desktop = () => {
    writeViewPref(globalThis.localStorage, "desktop");
    navigate("/");
  };

  const { counts } = queue;
  const chatDot = !stream.connected ? "bg-amber-500" : stream.chatAgent ? "bg-green-500" : "bg-muted-foreground/40";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <SkipLink mainRef={mainRef} />
      <header className="shrink-0 border-b border-border bg-muted pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-2 px-3">
          <Link to={MOBILE_TAB_PATHS.team} className="flex min-w-0 items-center gap-2 font-semibold">
            <span aria-hidden>🍕</span><span className="truncate">Pizza Team</span>
          </Link>
          {paused && (
            <Tooltip content="Task distribution is paused" describe={false}>
              <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <Pause className="h-3 w-3" />paused
              </span>
            </Tooltip>
          )}
          <div className="ml-auto flex items-center">
            <IconLink
              to={helpTo}
              label="Help"
              aria-current={help ? "page" : undefined}
              className={`inline-flex size-8 items-center justify-center rounded-md ${help ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
            >
              <HelpCircle className="h-4 w-4" />
            </IconLink>
            <ThemeToggle />
            <IconButton variant="ghost" size="icon" onClick={desktop} label="Desktop view">
              <Monitor className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <Link to={MOBILE_TAB_PATHS.team} className="flex h-8 items-center gap-1.5 border-t border-border/60 px-3 text-xs">
          {counts.total === 0 && <span className="text-muted-foreground">Queue: nothing in flight</span>}
          {counts.atRisk > 0 && (
            <span className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{counts.atRisk} at risk
            </span>
          )}
          {[
            counts.waiting > 0 && `${counts.waiting} waiting`,
            counts.working > 0 && `${counts.working} working`,
          ].filter(Boolean).map((part) => (
            <span key={part as string} className="text-muted-foreground before:mr-1.5 before:content-['·'] first:before:hidden">{part}</span>
          ))}
        </Link>
      </header>

      <main ref={mainRef} id={MAIN_CONTENT_ID} tabIndex={-1} className="min-h-0 flex-1">
        {help ? (
          <div className="h-full overflow-y-auto">
            <HelpPage root={MOBILE_HELP_ROOT} />
          </div>
        ) : (
          <h1 className="sr-only">{TAB_LABELS[tab]}</h1>
        )}
        <div className={current === "team" ? "h-full" : "hidden"}>
          <MobileTeam team={team} queue={queue} paused={paused} />
        </div>
        <div className={current === "chat" ? "h-full" : "hidden"}>
          <MobileChat stream={stream} viewingId={viewingId} onViewSession={setViewingId} active={current === "chat"} />
        </div>
        <div className={current === "thoughts" ? "h-full" : "hidden"}>
          <MobileThoughts active={current === "thoughts"} />
        </div>
        <div className={current === "inbox" ? "h-full" : "hidden"}>
          <MobileInbox active={current === "inbox"} onChanged={refetchInbox} />
        </div>
      </main>

      <nav aria-label="Tabs" className="grid shrink-0 grid-cols-4 border-t border-border bg-muted pb-[env(safe-area-inset-bottom)]">
        <TabLink tab="team" current={current} icon={Users} label={TAB_LABELS.team} attention={counts.atRisk > 0 || team.needsAttention} />
        <TabLink tab="chat" current={current} icon={MessageSquare} label={TAB_LABELS.chat} badge={unreadChat} dot={chatDot} />
        <TabLink tab="thoughts" current={current} icon={StickyNote} label={TAB_LABELS.thoughts} />
        <TabLink tab="inbox" current={current} icon={Inbox} label={TAB_LABELS.inbox} badge={inbox?.total ?? 0} />
      </nav>
    </div>
  );
}

/** One bottom tab: icon over label, with an unread count, a status dot, or an amber attention dot. */
function TabLink({
  tab, current, icon: Icon, label, badge = 0, dot, attention,
}: {
  tab: MobileTab;
  /** The tab on screen; null while the guide covers them. */
  current: MobileTab | null;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: number;
  /** A status dot class beside the icon (the leader's presence on Chat). */
  dot?: string;
  attention?: boolean;
}) {
  const active = tab === current;
  return (
    <Link
      to={MOBILE_TAB_PATHS[tab]}
      aria-current={active ? "page" : undefined}
      className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
    >
      <span className="relative">
        <Icon className="h-5 w-5" />
        {badge > 0 && (
          <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
        {badge === 0 && attention && <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-amber-500" />}
        {badge === 0 && !attention && dot && <span className={`absolute -right-1 -top-0.5 h-2 w-2 rounded-full ${dot}`} />}
      </span>
      {label}
    </Link>
  );
}

/** When the newest chat message was written (0 for none). */
function newestMessageAt(messages: Array<{ createdAt: string }>): number {
  return messages.reduce((t, m) => Math.max(t, new Date(m.createdAt).getTime()), 0);
}
