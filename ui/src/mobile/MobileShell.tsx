/**
 * MobileShell — The phone view (`/m`): a quick look at the team from an iPhone,
 * not the desktop UI squeezed down (docs/DESIGN.md "A Phone Is a Peek").
 *
 *   ┌──────────────────────────────┐
 *   │ 🍕 Pizza Team  ⏸  ☀  🖥      │  header: pause state, theme, desktop view
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
 * Opening `/m` clears a "desktop view" preference; the 🖥 button sets it and goes
 * to the full UI, which stops sending a phone at the home page here.
 */

import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { useAssistantStream } from "@/hooks/useAssistantStream";
import { useQueue } from "@/hooks/useQueue";
import { useTeamData } from "@/hooks/useTeamData";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { MOBILE_TAB_PATHS, mobileTabOf, readViewPref, writeViewPref, type MobileTab } from "@/lib/mobile";
import { countUnread } from "@/lib/unread";
import { MobileTeam } from "./MobileTeam";
import { MobileChat } from "./MobileChat";
import { MobileThoughts } from "./MobileThoughts";
import { MobileInbox } from "./MobileInbox";
import { Inbox, MessageSquare, Monitor, Pause, StickyNote, Users } from "lucide-react";

export function MobileShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tab = mobileTabOf(pathname);

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
      <header className="shrink-0 border-b border-border bg-muted pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-2 px-3">
          <Link to={MOBILE_TAB_PATHS.team} className="flex min-w-0 items-center gap-2 font-semibold">
            <span aria-hidden>🍕</span><span className="truncate">Pizza Team</span>
          </Link>
          {paused && (
            <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400" title="Task distribution is paused">
              <Pause className="h-3 w-3" />paused
            </span>
          )}
          <div className="ml-auto flex items-center">
            <ThemeToggle />
            <Button variant="ghost" size="icon" onClick={desktop} title="Desktop view" aria-label="Desktop view">
              <Monitor className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Link to={MOBILE_TAB_PATHS.team} className="flex h-8 items-center gap-1.5 border-t border-border/60 px-3 text-xs">
          {counts.total === 0 && <span className="text-muted-foreground">Queue: nothing in flight</span>}
          {counts.atRisk > 0 && (
            <span className="flex items-center gap-1 font-medium text-amber-600">
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

      <main className="min-h-0 flex-1">
        <div className={tab === "team" ? "h-full" : "hidden"}>
          <MobileTeam team={team} queue={queue} paused={paused} />
        </div>
        <div className={tab === "chat" ? "h-full" : "hidden"}>
          <MobileChat stream={stream} viewingId={viewingId} onViewSession={setViewingId} active={tab === "chat"} />
        </div>
        <div className={tab === "thoughts" ? "h-full" : "hidden"}>
          <MobileThoughts active={tab === "thoughts"} />
        </div>
        <div className={tab === "inbox" ? "h-full" : "hidden"}>
          <MobileInbox active={tab === "inbox"} onChanged={refetchInbox} />
        </div>
      </main>

      <nav className="grid shrink-0 grid-cols-4 border-t border-border bg-muted pb-[env(safe-area-inset-bottom)]">
        <TabLink tab="team" current={tab} icon={Users} label="Team" attention={counts.atRisk > 0 || team.needsAttention} />
        <TabLink tab="chat" current={tab} icon={MessageSquare} label="Chat" badge={unreadChat} dot={chatDot} />
        <TabLink tab="thoughts" current={tab} icon={StickyNote} label="Thoughts" />
        <TabLink tab="inbox" current={tab} icon={Inbox} label="Inbox" badge={inbox?.total ?? 0} />
      </nav>
    </div>
  );
}

/** One bottom tab: icon over label, with an unread count, a status dot, or an amber attention dot. */
function TabLink({
  tab, current, icon: Icon, label, badge = 0, dot, attention,
}: {
  tab: MobileTab;
  current: MobileTab;
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
