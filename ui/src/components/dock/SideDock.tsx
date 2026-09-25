/**
 * SideDock — the left column: the **Assistant** and the **Team**, as two tabs,
 * reachable from every page.
 *
 * The shell is two columns now: this dock, and the center (nav + page). The
 * dock holds both things you keep an eye on *while* looking at something else —
 * the chat with the leader, and the team working — and
 * the center shows one thing at a time (DESIGN.md "The Shell: a Dock and a
 * Center"). The team used to be a second sidebar on the right; merging it here
 * gives the center the width, at the cost of seeing one tab at a time — which
 * the tab badges soften: unread replies on Assistant, online count and an
 * attention dot (a team size it can't meet) on Team.
 *
 * Under both tabs, pinned to the bottom: the **queue summary** strip (work in
 * flight — counts, a hover preview, a link to the Queue tab on the home page;
 * components/queue/QueueSummary) and **Start work** (quick-create).
 *
 * Three presentations, one dock:
 *  - `lg+` expanded — a resizable column (drag the inner edge, 300–560px, width
 *    remembered in localStorage) with a tab bar.
 *  - `lg+` collapsed — a slim icon rail: the chat (unread badge), quick-create,
 *    the team buttons, teammate avatars (linking to their live view), and the
 *    queue count (linking to the Queue tab; amber when anything is at risk).
 *  - below `lg` — a floating corner button that pops the dock open in place,
 *    tabs included.
 *
 * The presentation is chosen with a real media query, not `hidden lg:flex`:
 * rendering both and hiding one would mount the chat twice (duplicate `msg-*`
 * ids, two scroll containers, double polling).
 *
 * The chat stream, the team data, and the queue are owned here, not in the tabs, so
 * collapsing or switching tabs never drops the SSE connection or the badges.
 * Both tab bodies stay mounted (the inactive one hidden) so a half-typed chat
 * message survives a peek at the team.
 */

import { useCallback, useState } from "react";
import { Link, useMatch } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { AssistantChat } from "@/components/assistant/AssistantChat";
import { TeamPanel } from "@/components/team/TeamPanel";
import { TeammateAvatar, TeamButtons } from "@/components/team/TeamParts";
import { TeamSizeDialog } from "@/components/TeamSizeDialog";
import { QueueSummary } from "@/components/queue/QueueSummary";
import { useQueue } from "@/hooks/useQueue";
import { SpawnDialog } from "@/components/SpawnDialog";
import { useAssistantStream } from "@/hooks/useAssistantStream";
import { useTeamData } from "@/hooks/useTeamData";
import { useSideDock, type SideDockTab } from "@/hooks/useSideDock";
import { LG_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import {
  MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Zap, CalendarClock, X, Clock, Users,
} from "lucide-react";

const WIDTH_KEY = "mpt.assistantDock.width";
const MIN_WIDTH = 300;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 380;

export function SideDock() {
  const { open, setOpen, tab, setTab } = useSideDock();
  // null = follow the live session; an id = read an earlier one.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const stream = useAssistantStream(viewingId ?? undefined);
  const team = useTeamData();
  const queue = useQueue();
  const [width, startResize] = useDockWidth();
  const isDesktop = useMediaQuery(LG_QUERY);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const viewingTeammate = useMatch("/teammates/:id")?.params.id ?? null;

  // Opening, closing, and switching tabs are all "I looked at it" moments.
  const { seenAt, markSeen } = useSeenMarker();
  const unread = countUnread(stream.messages, seenAt, open && tab === "assistant");
  const setDockOpen = (next: boolean) => { markSeen(); setOpen(next); };
  const openTab = (next: SideDockTab) => { markSeen(); setTab(next); setOpen(true); };

  const pool = team.pool;
  const sizeTitle = pool
    ? `Team size: ${pool.minTeammates}${pool.isDefault ? " (default)" : ""} · ${pool.online} online${team.poolBlocked ? " · no leader connected" : ""}`
    : "Team size";

  const dialogs = (
    <>
      <TeamSizeDialog open={sizeOpen} onOpenChange={setSizeOpen} pool={pool} onChanged={() => { team.refetchPool(); team.refetchSpawns(); }} />
      <SpawnDialog open={spawnOpen} onOpenChange={setSpawnOpen} onSpawned={() => { team.refetchSpawns(); team.refetchPool(); }} />
    </>
  );

  const tabBar = (
    <div className="flex h-14 shrink-0 items-center justify-between gap-1 border-b border-border px-2">
      <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5" role="tablist">
        <TabButton active={tab === "assistant"} onClick={() => openTab("assistant")} icon={MessageSquare} label="Assistant" badge={unread} />
        <TabButton
          active={tab === "team"} onClick={() => openTab("team")} icon={Users} label="Team"
          count={team.online.length} attention={team.needsAttention}
        />
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDockOpen(false)} title={isDesktop ? "Collapse" : "Close"}>
        {isDesktop ? <PanelLeftClose className="h-4 w-4" /> : <X className="h-4 w-4" />}
      </Button>
    </div>
  );

  const body = (
    <div className="min-h-0 flex-1">
      <div className={tab === "assistant" ? "h-full" : "hidden"}>
        <AssistantChat stream={stream} viewingId={viewingId} onViewSession={setViewingId} />
      </div>
      <div className={tab === "team" ? "h-full" : "hidden"}>
        <TeamPanel team={team} sizeTitle={sizeTitle} onSize={() => setSizeOpen(true)} onSpawn={() => setSpawnOpen(true)} />
      </div>
    </div>
  );

  // Below lg there is no room for a column, so the dock becomes a floating panel.
  if (!isDesktop) {
    return (
      <div>
        {dialogs}
        {open && (
          <div className="fixed bottom-20 left-4 z-40 flex h-[70vh] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
            {tabBar}
            {body}
            <QueueSummary queue={queue} />
          </div>
        )}
        <button
          type="button"
          onClick={() => setDockOpen(!open)}
          title={open ? "Close" : "Assistant and team"}
          className="fixed bottom-4 left-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
        >
          {open ? <X className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
          {!open && <UnreadBadge count={unread} />}
        </button>
      </div>
    );
  }

  // Collapsed: a slim icon rail with both tabs' essentials.
  if (!open) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-muted/30">
        {dialogs}
        <div className="flex h-14 w-full shrink-0 items-center justify-center border-b border-border">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDockOpen(true)} title="Expand">
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto py-3">
          <button
            type="button"
            onClick={() => openTab("assistant")}
            title={unread > 0 ? `${unread} new message${unread === 1 ? "" : "s"}` : "Chat with the assistant"}
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MessageSquare className="h-4 w-4" />
            <UnreadBadge count={unread} />
          </button>
          {START_WORK.map((item) => (
            <Button key={item.to} variant="outline" size="icon" className="h-8 w-8 shrink-0" title={item.label} render={<Link to={item.to} />}>
              <item.icon className="h-4 w-4" />
            </Button>
          ))}
          <div className="my-1 h-px w-6 shrink-0 bg-border" />
          <TeamButtons sizeTitle={sizeTitle} poolBlocked={team.poolBlocked} onSize={() => setSizeOpen(true)} onSpawn={() => setSpawnOpen(true)} />
          {team.pendingSpawns.length > 0 && (
            <div
              className="relative flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground"
              title={`${team.pendingSpawns.length} pending spawn request${team.pendingSpawns.length === 1 ? "" : "s"}`}
            >
              <Clock className="h-4 w-4 animate-pulse" />
              <CountBadge count={team.pendingSpawns.length} className="bg-amber-500" />
            </div>
          )}
          {[...team.online, ...team.offline].map((t) => (
            <TeammateAvatar key={t.id} teammate={t} selected={t.id === viewingTeammate} />
          ))}
          {queue.counts.total > 0 && (
            <Link
              to="/queue"
              className="relative mt-1 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
              title={`Queue: ${[
                queue.counts.atRisk && `${queue.counts.atRisk} at risk`,
                queue.counts.waiting && `${queue.counts.waiting} waiting`,
                queue.counts.working && `${queue.counts.working} working`,
              ].filter(Boolean).join(" · ")}`}
            >
              <Clock className="h-4 w-4" />
              <CountBadge count={queue.counts.total} className={queue.counts.atRisk > 0 ? "bg-amber-500" : "bg-primary"} />
            </Link>
          )}
        </div>
      </aside>
    );
  }

  // Expanded: the resizable dock column.
  return (
    <aside className="relative flex shrink-0 flex-col border-r border-border bg-muted/30" style={{ width }}>
      {dialogs}
      {tabBar}
      {body}
      <QueueSummary queue={queue} />
      <StartWorkBar />
      {/* Drag the inner edge to resize — a chat at 300px is cramped for code. */}
      <div
        onPointerDown={startResize}
        title="Drag to resize"
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-primary/20"
      />
    </aside>
  );
}

/** One tab of the dock's segmented tab bar, with its live badge. */
function TabButton({
  active, onClick, icon: Icon, label, badge = 0, count, attention,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** Unread-style badge (hidden at 0). */
  badge?: number;
  /** A quiet count after the label, e.g. agents online. */
  count?: number;
  /** An amber dot: something here wants a human. */
  attention?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors ${
        active ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {count !== undefined && <span className="text-xs font-normal text-muted-foreground">{count}</span>}
      {attention && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Needs attention" />}
      <UnreadBadge count={badge} />
    </button>
  );
}

// ─── Start work ──────────────────────────────────────────────────────

/**
 * The quick-create row: creating work is how work *starts*, so it's on every
 * page, under both tabs. Spawning a teammate is deliberately absent — an agent
 * is capacity for running work, and it lives with the team (the Team tab).
 */
const START_WORK = [
  { to: "/stories/new", label: "New Story", icon: Plus },
  { to: "/work-defs/new?type=Solitary", label: "Solitary Task", icon: Zap },
  { to: "/work-defs/new?type=Scheduled", label: "Scheduled Job", icon: CalendarClock },
];

function StartWorkBar() {
  return (
    <div className="shrink-0 border-t border-border p-2">
      <p className="px-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Start work</p>
      <div className="flex flex-wrap gap-1">
        {START_WORK.map((item) => (
          <Button key={item.to} variant="outline" size="sm" className="h-7 px-2 text-xs" render={<Link to={item.to} />}>
            <item.icon className="mr-1 h-3.5 w-3.5" />{item.label.replace("New ", "")}
          </Button>
        ))}
      </div>
    </div>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────

function CountBadge({ count, className }: { count: number; className: string }) {
  return (
    <span className={`absolute -right-1 -top-1 h-3.5 min-w-3.5 rounded-full px-0.5 text-center text-[9px] leading-[14px] text-white ${className}`}>
      {count > 9 ? "9+" : count}
    </span>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[9px] leading-[14px] text-white">
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * Unread = assistant bubbles that arrived since you last looked (you're
 * "looking" while the dock is open on the Assistant tab).
 *
 * Derived during render from a single "last looked at" timestamp rather than an
 * effect, so there are no cascading renders and no ref read during render. The
 * timestamp is stamped at mount (a dock that loads collapsed doesn't claim the
 * whole backlog is unread) and again whenever the dock is opened or closed.
 *
 * Message timestamps come from the daemon while `seenAt` is local, but both are
 * the same machine in practice; worst case a badge is off by one on a skewed
 * clock, which is not worth a server round-trip to fix.
 */
function useSeenMarker(): { seenAt: number; markSeen: () => void } {
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const markSeen = useCallback(() => setSeenAt(Date.now()), []);
  return { seenAt, markSeen };
}

function countUnread(messages: Array<{ role: string; createdAt: string }>, seenAt: number, looking: boolean): number {
  if (looking) return 0;
  return messages.filter((m) => m.role === "assistant" && new Date(m.createdAt).getTime() > seenAt).length;
}

/** Dock width + a pointer-drag resize handler. Width persists across reloads. */
function useDockWidth(): [number, (e: React.PointerEvent) => void] {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
  });

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      // The dock is flush to the viewport's left edge, so clientX *is* the width.
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
      setWidth(next);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
      try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* private mode */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  return [width, startResize];
}
