/**
 * SideDock — the dock: the **Assistant**, the **Team**, and **Help**, as
 * tabs, reachable from every page. It sits on the Left (the default), the
 * Right, or the Bottom, chosen with the header's **Dock position** menu and
 * remembered per browser (lib/dock-layout.ts holds the rules: stored values,
 * width and height limits, which edge the handle and tooltips face).
 *
 * The shell is two regions now: this dock, and the center (nav + page). The
 * dock holds both things you keep an eye on *while* looking at something else —
 * the chat with the leader, and the team working — and
 * the center shows one thing at a time (DESIGN.md "The Shell: a Dock and a
 * Center"). The team used to be a second sidebar on the right; merging it here
 * gives the center the width, at the cost of seeing one tab at a time — which
 * the tab badges soften: unread replies on Assistant, online count and an
 * attention dot (a team size it can't meet) on Team.
 *
 * Layout, top to bottom:
 *
 *   [+] │ ⏱ Queue  1 at risk · 2 waiting       [▥] [⇤]   ← 56px, aligned with the nav
 *   [💬 Assistant ●] [👥 Team 2] [? Help]  (tab's actions)  ← tab row
 *   … the active tab …
 *
 * The header row is dock-level (it belongs to both tabs, hence above them):
 * the `+` start-work menu sits right before the **queue summary**
 * (components/queue/QueueSummary — counts, a hover preview, a link to the Queue
 * tab on the home page), so `+ │ Queue` reads as "add work to the queue". It's
 * tinted like the nav so the top of the app reads as one band. The tab row also
 * carries the active tab's actions (chat sessions; team size + spawn), so each
 * tab needs no toolbar of its own and the chat composer sits flush at the
 * bottom.
 *
 * Three presentations, one dock:
 *  - `lg+` expanded — a resizable column (drag the inner edge, 300–560px, width
 *    remembered in localStorage). On the Right it's drawn after the center
 *    with CSS `order` but stays first in the DOM, so the tab order and the
 *    landmarks read the same in either position. At the Bottom it's a
 *    full-width panel under the center instead (same `order` trick), resized
 *    by its top edge (200px to 70% of the window, its own saved height); the
 *    header and tab rows stay as they are, and the chat keeps a readable
 *    width in the middle (AssistantPane `readable`).
 *  - `lg+` Full page — the header's Full page button (the Restore button,
 *    or going to another page, puts it back) makes the dock fill the
 *    center below the NavBar, whichever side it sits on; the page stays
 *    mounted but hidden (App.tsx `ShellFrame`). Same element as the column, so
 *    nothing remounts; no resize handle, and the saved width is kept for later.
 *  - `lg+` collapsed — a slim icon rail: the chat (unread badge), help, quick-create
 *    (only the kinds switched on in Config),
 *    the team buttons, teammate avatars (linking to their live view), and the
 *    queue count (linking to the Queue tab; amber when anything is at risk).
 *    Its tooltips open toward the center, whichever side the rail is on. At
 *    the Bottom the rail is a thin bar instead: the same items in a row that
 *    scrolls sideways, tooltips opening upward.
 *  - below `lg` — a floating corner button that pops the dock open in place,
 *    tabs included. Position doesn't apply there (no Dock position menu).
 *
 * The presentation is chosen with a real media query, not `hidden lg:flex`:
 * rendering both and hiding one would mount the chat twice (duplicate `msg-*`
 * ids, two scroll containers, double polling).
 *
 * The Help tab is `HelpPanel` (components/help): the guide section for the
 * page in the center, opened by the page's ?, the NavBar's Help, or the `?`
 * key (docs/DESIGN.md "Help Comes to You"; the open/close and focus logic is
 * SideDockProvider's). Unlike the other two it mounts only while shown: it
 * holds no live data and no half-typed text.
 *
 * The Assistant tab is `AssistantPane`, and the dock's size picks its view
 * (docs/DESIGN.md "Assistant Chat Model"): docked it's the bubble chat; at
 * Full page it's the terminal — the teammate watch/pair view pointed at the
 * leader, the session so far included. Toggling Full page switches it live.
 *
 * The guided tour (lib/tour.ts) points at the dock's column or rail, or — below
 * `lg` — at the floating button (its `nav` has no box of its own there):
 * whichever carries `data-tour="dock"`.
 *
 * Every presentation is one `<nav aria-label="Side dock">` landmark, and a
 * keep-focus region: a route change never pulls focus out of it
 * (lib/route-focus.ts, docs/ACCESSIBILITY.md).
 *
 * The chat stream, the team data, and the queue are owned here, not in the tabs, so
 * collapsing or switching tabs never drops the SSE connection or the badges.
 * Both tab bodies stay mounted (the inactive one hidden) so a half-typed chat
 * message survives a peek at the team.
 */

import { useCallback, useState } from "react";
import { Link, useMatch } from "react-router-dom";
import { IconButton, IconLink } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { AssistantPane } from "@/components/assistant/AssistantPane";
import { TeamPanel } from "@/components/team/TeamPanel";
import { TeammateAvatar, TeamButtons } from "@/components/team/TeamParts";
import { TeamSizeDialog } from "@/components/TeamSizeDialog";
import { QueueSummary } from "@/components/queue/QueueSummary";
import { SessionMenu } from "@/components/assistant/SessionMenu";
import { NewWorkMenu } from "./NewWorkMenu";
import { HelpPanel } from "@/components/help/HelpPanel";
import { HELP_SHORTCUT } from "@/lib/help";
import { START_WORK } from "@/lib/start-work";
import { filterByFeatures } from "@/lib/features";
import { useFeatures } from "@/hooks/useFeatures";
import { useQueue } from "@/hooks/useQueue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SpawnDialog } from "@/components/SpawnDialog";
import { useAssistantStream } from "@/hooks/useAssistantStream";
import { useTeamData } from "@/hooks/useTeamData";
import { useAnnounceOffline, useAnnounceQueue, useAnnounceReplies } from "@/hooks/useLiveAnnouncements";
import { useSideDock, type DockPosition, type SideDockTab } from "@/hooks/useSideDock";
import {
  DOCK_HEIGHT_KEY, DOCK_POSITIONS, DOCK_WIDTH_KEY, MAX_DOCK_HEIGHT_RATIO, dockFillsCenter, dockHeightFromPointer, dockInnerEdge,
  dockTooltipSide, dockWidthFromPointer, isHorizontalDock, parseDockHeight, parseDockPosition, parseDockWidth,
  toggleFullPage,
} from "@/lib/dock-layout";
import { LG_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { countUnread } from "@/lib/unread";
import { KEEP_FOCUS_ATTR } from "@/lib/route-focus";
import {
  Maximize2, Minimize2, MessageSquare, PanelBottom, PanelBottomClose, PanelBottomOpen, PanelLeft, PanelLeftClose, PanelLeftOpen, PanelRight,
  PanelRightClose, PanelRightOpen, X, Clock, Users, HelpCircle,
} from "lucide-react";

/**
 * Marks the dock a keep-focus region: a navigation never moves focus out of it
 * (lib/route-focus.ts), so typing in the chat or opening a teammate keeps you
 * in the dock.
 */
const KEEP_FOCUS = { [KEEP_FOCUS_ATTR]: "" };

/** The dock (all three presentations); reads its state from SideDockProvider. */
export function SideDock() {
  const { position, mode, setMode, open, setOpen, tab, setTab, openHelp, closeHelp } = useSideDock();
  const onRight = position === "right";
  const onBottom = isHorizontalDock(position);
  // The rail's hints open toward the center so they clear the dock's edge.
  const tip = dockTooltipSide(position);
  // null = follow the live session; an id = read an earlier one.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const stream = useAssistantStream(viewingId ?? undefined);
  const team = useTeamData();
  const queue = useQueue();
  // Tell a screen reader what changed (docs/ACCESSIBILITY.md "Live announcements").
  useAnnounceReplies(stream.messages, stream.loaded);
  useAnnounceQueue(queue.items, queue.loaded);
  useAnnounceOffline(team.teammates, team.loaded);
  const [width, startResize] = useDockWidth(position);
  const [height, startResizeHeight] = useDockHeight();
  const isDesktop = useMediaQuery(LG_QUERY);
  const full = dockFillsCenter(mode, isDesktop);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const viewingTeammate = useMatch("/teammates/:id")?.params.id ?? null;
  // Quick-create offers only the kinds switched on in Config.
  const startWork = filterByFeatures(START_WORK, useFeatures());

  // Opening, closing, and switching tabs are all "I looked at it" moments.
  const { seenAt, markSeen } = useSeenMarker();
  const unread = countUnread(stream.messages, seenAt, open && tab === "assistant");
  const setDockOpen = (next: boolean) => { markSeen(); setOpen(next); };
  const openTab = (next: SideDockTab) => { markSeen(); setTab(next); setOpen(true); };

  const pool = team.pool;
  const sizeTitle = pool
    ? `Team size: ${pool.minTeammates}${pool.isDefault ? " (default)" : ""} · ${pool.online} online${!team.poolBlocked ? "" : pool.spawnBlocked ? ` · can't spawn: ${pool.spawnBlocked.reason}` : " · no assistant connected"}`
    : "Team size";

  const dialogs = (
    <>
      <TeamSizeDialog open={sizeOpen} onOpenChange={setSizeOpen} pool={pool} onChanged={() => { team.refetchPool(); team.refetchSpawns(); }} />
      <SpawnDialog open={spawnOpen} onOpenChange={setSpawnOpen} onSpawned={() => { team.refetchSpawns(); team.refetchPool(); }} />
    </>
  );

  // Leader presence on the Assistant tab: who answers, or why nobody will.
  const chatOnline = stream.chatAgent !== null;
  const chatDot = !stream.connected ? "bg-amber-500" : chatOnline ? "bg-green-500" : "bg-muted-foreground/40";
  const chatDotTitle = !stream.connected ? "Reconnecting…" : chatOnline ? "Answered by the assistant" : "No assistant online to answer";

  // Row 1 (dock-level, 56px, aligned with the nav): + │ Queue summary │ collapse.
  const header = (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-muted px-2">
      <NewWorkMenu />
      <div className="h-6 w-px shrink-0 bg-border" />
      <QueueSummary queue={queue} />
      {isDesktop && <DockPositionMenu />}
      {isDesktop && (
        <IconButton className="h-8 w-8 shrink-0" onClick={() => setMode(toggleFullPage(mode))} label={full ? "Restore the dock" : "Full page"}>
          {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </IconButton>
      )}
      <IconButton className="h-8 w-8 shrink-0" onClick={() => setDockOpen(false)} label={isDesktop ? "Collapse the dock" : "Close the dock"}>
        {!isDesktop ? <X className="h-4 w-4" />
          : onBottom ? <PanelBottomClose className="h-4 w-4" />
          : onRight ? <PanelRightClose className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </IconButton>
    </div>
  );

  // Row 2: the tabs, plus the active tab's own actions on the right.
  const tabRow = (
    <div className="flex h-11 shrink-0 items-center justify-between gap-1 border-b border-border px-2">
      <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5" role="tablist">
        <TabButton
          active={tab === "assistant"} onClick={() => openTab("assistant")} icon={MessageSquare} label="Assistant"
          badge={unread} dot={chatDot} dotTitle={chatDotTitle}
        />
        <TabButton
          active={tab === "team"} onClick={() => openTab("team")} icon={Users} label="Team"
          count={team.online.length} attention={team.needsAttention}
        />
        <TabButton active={tab === "help"} onClick={() => openTab("help")} icon={HelpCircle} label="Help" hint={`Help for this page (${HELP_SHORTCUT})`} />
      </div>
      <div className="flex shrink-0 items-center">
        {tab === "assistant" && <SessionMenu viewingId={viewingId} onView={setViewingId} onChanged={stream.refresh} compact />}
        {tab === "team" && <TeamButtons sizeTitle={sizeTitle} poolBlocked={team.poolBlocked} onSize={() => setSizeOpen(true)} onSpawn={() => setSpawnOpen(true)} />}
        {tab === "help" && (
          <IconButton className="h-8 w-8" onClick={closeHelp} label="Close help">
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </div>
    </div>
  );

  const body = (
    <div className="min-h-0 flex-1">
      <div className={tab === "assistant" ? "h-full" : "hidden"}>
        {/* A full-width Bottom panel would stretch a line across the screen. */}
        <AssistantPane stream={stream} viewingId={viewingId} onViewSession={setViewingId} readable={isDesktop && onBottom && !full} fullPage={full} />
      </div>
      <div className={tab === "team" ? "h-full" : "hidden"}>
        <TeamPanel team={team} onSpawn={() => setSpawnOpen(true)} />
      </div>
      {tab === "help" && <HelpPanel />}
    </div>
  );

  // Below lg there is no room for a column, so the dock becomes a floating panel.
  if (!isDesktop) {
    return (
      <nav aria-label="Side dock" {...KEEP_FOCUS}>
        {dialogs}
        {open && (
          <div className="fixed bottom-20 left-4 z-40 flex h-[70vh] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
            {header}
            {tabRow}
            {body}
          </div>
        )}
        <Tooltip content={open ? "Close the assistant and team" : "Assistant and team"} describe={false} side="right">
          <button
            type="button"
            onClick={() => setDockOpen(!open)}
            aria-label={open ? "Close the assistant and team" : `Assistant and team${unreadSuffix(unread)}`}
            aria-expanded={open}
            data-tour="dock"
            className="fixed bottom-4 left-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
          >
            {open ? <X className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
            {!open && <UnreadBadge count={unread} />}
          </button>
        </Tooltip>
      </nav>
    );
  }

  // Collapsed: a slim icon rail with both tabs' essentials — down the side, or
  // at the Bottom a thin bar with the same items in a row.
  if (!open) {
    return (
      <nav
        aria-label="Side dock" {...KEEP_FOCUS} data-tour="dock"
        className={onBottom
          ? "order-last flex h-14 shrink-0 flex-row items-center border-t border-border bg-muted/30"
          : `flex w-14 shrink-0 flex-col items-center border-border bg-muted/30 ${onRight ? "order-last border-l" : "border-r"}`}
      >
        {dialogs}
        <div className={`flex shrink-0 items-center justify-center border-border ${onBottom ? "h-full w-14 border-r" : "h-14 w-full border-b"}`}>
          <IconButton className="h-8 w-8" onClick={() => setDockOpen(true)} label="Expand the dock" side={tip}>
            {onBottom ? <PanelBottomOpen className="h-4 w-4" /> : onRight ? <PanelRightOpen className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </IconButton>
        </div>
        <div
          className={onBottom
            // py-1: room for the count badges (-top-1) inside the scroll box.
            ? "flex h-full min-w-0 flex-1 flex-row items-center gap-2 overflow-x-auto px-3 py-1"
            : "flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto py-3"}
        >
          <Tooltip content={`Chat with the assistant${unreadSuffix(unread)}`} describe={false} side={tip}>
            <button
              type="button"
              onClick={() => openTab("assistant")}
              aria-label={`Chat with the assistant${unreadSuffix(unread)}`}
              className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MessageSquare className="h-4 w-4" />
              <UnreadBadge count={unread} />
            </button>
          </Tooltip>
          <IconButton className="h-8 w-8 shrink-0 text-muted-foreground" onClick={() => openHelp()} label="Help for this page" hint={`Help for this page (${HELP_SHORTCUT})`} side={tip}>
            <HelpCircle className="h-4 w-4" />
          </IconButton>
          {startWork.map((item) => (
            <IconButton key={item.to} variant="outline" className="h-8 w-8 shrink-0" label={item.label} side={tip} render={<Link to={item.to} />}>
              <item.icon className="h-4 w-4" />
            </IconButton>
          ))}
          <div className={`shrink-0 bg-border ${onBottom ? "mx-1 h-6 w-px" : "my-1 h-px w-6"}`} />
          <TeamButtons sizeTitle={sizeTitle} poolBlocked={team.poolBlocked} onSize={() => setSizeOpen(true)} onSpawn={() => setSpawnOpen(true)} tooltipSide={tip} />
          {team.pendingSpawns.length > 0 && (
            <Tooltip content={`${team.pendingSpawns.length} pending spawn request${team.pendingSpawns.length === 1 ? "" : "s"}`} describe={false} focusable side={tip}>
              <div
                className="relative flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground"
                role="img"
                aria-label={`${team.pendingSpawns.length} pending spawn request${team.pendingSpawns.length === 1 ? "" : "s"}`}
              >
                <Clock className="h-4 w-4 animate-pulse" />
                <CountBadge count={team.pendingSpawns.length} className="bg-amber-500" />
              </div>
            </Tooltip>
          )}
          {[...team.online, ...team.offline].map((t) => (
            <TeammateAvatar key={t.id} teammate={t} selected={t.id === viewingTeammate} tooltipSide={tip} />
          ))}
          {queue.counts.total > 0 && (
            <IconLink
              to="/queue"
              className={`relative flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground ${onBottom ? "ml-1" : "mt-1"}`}
              side={tip}
              label={`Queue: ${[
                queue.counts.atRisk && `${queue.counts.atRisk} at risk`,
                queue.counts.waiting && `${queue.counts.waiting} waiting`,
                queue.counts.working && `${queue.counts.working} working`,
              ].filter(Boolean).join(" · ")}`}
            >
              <Clock className="h-4 w-4" />
              <CountBadge count={queue.counts.total} className={queue.counts.atRisk > 0 ? "bg-amber-500" : "bg-primary"} />
            </IconLink>
          )}
        </div>
      </nav>
    );
  }

  // Expanded: the resizable dock column (or, at the Bottom, a full-width
  // panel resized by its height). Full page: the same element filling the
  // center below the NavBar (the shell lays that out), with no handle.
  return (
    <nav
      aria-label="Side dock" {...KEEP_FOCUS} data-tour="dock"
      className={full
        ? "relative flex min-h-0 flex-1 flex-col bg-muted/30"
        : onBottom
          ? "relative order-last flex shrink-0 flex-col border-t border-border bg-muted/30"
          : `relative flex shrink-0 flex-col border-border bg-muted/30 ${onRight ? "order-last border-l" : "border-r"}`}
      // The CSS cap (the drag's ratio) keeps a height saved in a taller window inside this one.
      style={full ? undefined : onBottom ? { height, maxHeight: `${MAX_DOCK_HEIGHT_RATIO * 100}vh` } : { width }}
    >
      {dialogs}
      {header}
      {tabRow}
      {body}
      {!full && (
      /* Drag the inner edge to resize — a chat at 300px is cramped for code.
          Pointer-only (the dock's width is a convenience, not a function), so
          it's hidden from assistive tech; the hint is the cursor's tooltip. */
      <Tooltip content="Drag to resize" describe={false} side={dockInnerEdge(position)}>
        <div
          onPointerDown={onBottom ? startResizeHeight : startResize}
          aria-hidden
          className={onBottom
            ? "absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize hover:bg-primary/20"
            : `absolute inset-y-0 z-10 w-2 cursor-col-resize hover:bg-primary/20 ${onRight ? "-left-1" : "-right-1"}`}
        />
      </Tooltip>
      )}
    </nav>
  );
}

/** One tab of the dock's segmented tab bar, with its live badge. */
function TabButton({
  active, onClick, icon: Icon, label, badge = 0, count, attention, dot, dotTitle, hint: extraHint,
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
  /** A status dot class after the label (e.g. the leader's presence). */
  dot?: string;
  dotTitle?: string;
  /** More words for the tooltip (e.g. the tab's shortcut). */
  hint?: string;
}) {
  // The dot, count and badge say things in color and digits; the hint says
  // them in words (the tab's tooltip and description).
  const hint = [
    dot && dotTitle,
    count !== undefined && `${count} online`,
    attention && "Needs attention",
    badge > 0 && `${badge} new message${badge === 1 ? "" : "s"}`,
    extraHint,
  ].filter(Boolean).join(" · ");
  return (
    <Tooltip content={hint}>
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
        {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />}
        {count !== undefined && <span className="text-xs font-normal text-muted-foreground" aria-hidden>{count}</span>}
        {attention && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />}
        <UnreadBadge count={badge} />
      </button>
    </Tooltip>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────

/** " · 3 new messages" for an icon's name and tooltip; empty when nothing is unread. */
function unreadSuffix(unread: number): string {
  return unread > 0 ? ` · ${unread} new message${unread === 1 ? "" : "s"}` : "";
}

/** A count pinned to a rail icon. Digits only, so hidden: the icon's name says the count. */
function CountBadge({ count, className }: { count: number; className: string }) {
  return (
    <span aria-hidden className={`absolute -right-1 -top-1 h-3.5 min-w-3.5 rounded-full px-0.5 text-center text-[9px] leading-[14px] text-white ${className}`}>
      {count > 9 ? "9+" : count}
    </span>
  );
}

/** The unread count on the Assistant's icons. Hidden: their names carry it (unreadSuffix). */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[9px] leading-[14px] text-white">
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * The "last looked at" timestamp behind the unread badge (lib/unread.ts; you're
 * "looking" while the dock is open on the Assistant tab).
 *
 * Derived during render from a single timestamp rather than an effect, so there
 * are no cascading renders and no ref read during render. The timestamp is
 * stamped at mount (a dock that loads collapsed doesn't claim the whole backlog
 * is unread) and again whenever the dock is opened or closed.
 */
function useSeenMarker(): { seenAt: number; markSeen: () => void } {
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const markSeen = useCallback(() => setSeenAt(Date.now()), []);
  return { seenAt, markSeen };
}

/** The icon for each dock position (the menu's trigger and its items). */
const POSITION_ICON: Record<DockPosition, typeof PanelLeft> = { left: PanelLeft, right: PanelRight, bottom: PanelBottom };

/**
 * The header's **Dock position** menu: Left, Right or Bottom (lib/dock-layout.ts
 * `DOCK_POSITIONS`), the current one checked. A Base UI menu of radio items,
 * so it's keyboard-operable (Enter/Space/↓ opens it, arrows move, Enter picks
 * and closes it, Esc closes) and announced as a checked choice. Desktop only.
 */
function DockPositionMenu() {
  const { position, setPosition } = useSideDock();
  const Icon = POSITION_ICON[position];
  return (
    <DropdownMenu>
      <Tooltip content="Dock position" describe={false}>
        <DropdownMenuTrigger
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-accent"
          aria-label="Dock position"
        >
          <Icon className="h-4 w-4" />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent className="w-36" align="end">
        <DropdownMenuRadioGroup value={position} onValueChange={(v: string) => setPosition(parseDockPosition(v))}>
          {DOCK_POSITIONS.map((p) => {
            const ItemIcon = POSITION_ICON[p.position];
            return (
              // closeOnClick: picking a side is the whole errand; focus goes back to the trigger.
              <DropdownMenuRadioItem key={p.position} value={p.position} closeOnClick>
                <ItemIcon className="h-4 w-4" />
                {p.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Dock width + a pointer-drag resize handler for a dock at `position` (the
 * handle is on its inner edge). Width persists across reloads and is shared by
 * both sides.
 */
function useDockWidth(position: DockPosition): [number, (e: React.PointerEvent) => void] {
  const [width, setWidth] = useState(() => {
    try { return parseDockWidth(localStorage.getItem(DOCK_WIDTH_KEY)); } catch { return parseDockWidth(null); }
  });

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    // The dock is flush to its window edge, so the pointer's x gives the width directly.
    const widthAt = (ev: PointerEvent) => dockWidthFromPointer(position, ev.clientX, window.innerWidth);
    const onMove = (ev: PointerEvent) => setWidth(widthAt(ev));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try { localStorage.setItem(DOCK_WIDTH_KEY, String(widthAt(ev))); } catch { /* private mode */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [position]);

  return [width, startResize];
}

/**
 * The Bottom panel's height + a pointer-drag resize handler for its top edge.
 * Kept apart from the side width (its own localStorage key), clamped to
 * lib/dock-layout.ts's limits for the window at the time of the drag.
 */
function useDockHeight(): [number, (e: React.PointerEvent) => void] {
  const [height, setHeight] = useState(() => {
    try { return parseDockHeight(localStorage.getItem(DOCK_HEIGHT_KEY)); } catch { return parseDockHeight(null); }
  });

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const heightAt = (ev: PointerEvent) => dockHeightFromPointer(ev.clientY, window.innerHeight);
    const onMove = (ev: PointerEvent) => setHeight(heightAt(ev));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try { localStorage.setItem(DOCK_HEIGHT_KEY, String(heightAt(ev))); } catch { /* private mode */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  return [height, startResize];
}
