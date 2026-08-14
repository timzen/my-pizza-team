/**
 * AssistantDock — the assistant, reachable from every page.
 *
 * Mirrors `TeammateSidebar` on the opposite edge, because the layout reads
 * left-to-right as the life of a piece of work: **work starts on the left**
 * (talk to the assistant, create a story/task/job), **runs in the middle**
 * (board, task detail), and **is executed on the right** (teammates, queue).
 *
 * Three presentations, one chat:
 *  - `lg+` expanded — a resizable left column (drag the inner edge, 300–560px,
 *    width remembered in localStorage).
 *  - `lg+` collapsed — a slim icon rail with an unread badge, matching the right
 *    sidebar's rail.
 *  - below `lg` — the familiar website pattern: a floating button in the corner
 *    that pops the chat open in place, since there's no room for a column.
 *
 * The presentation is chosen with a real media query, not `hidden lg:flex`:
 * rendering both and hiding one would mount the chat twice (duplicate `msg-*`
 * ids, two scroll containers, double polling).
 *
 * The live stream is owned here, not in the chat body, so collapsing never drops
 * the SSE connection — that's what makes the unread badge possible.
 */

import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { AssistantChat } from "./AssistantChat";
import { useAssistantStream } from "@/hooks/useAssistantStream";
import { useAssistantDock } from "@/hooks/useAssistantDock";
import { LG_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import {
  MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Zap, CalendarClock, X,
} from "lucide-react";

const WIDTH_KEY = "mpt.assistantDock.width";
const MIN_WIDTH = 300;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 380;

export function AssistantDock() {
  const { open, setOpen } = useAssistantDock();
  // null = follow the live session; an id = read an earlier one.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const stream = useAssistantStream(viewingId ?? undefined);
  const [width, startResize] = useDockWidth();
  const isDesktop = useMediaQuery(LG_QUERY);
  // Opening and closing are both "I looked at it" — stamp the marker either way.
  const { seenAt, markSeen } = useSeenMarker();
  const unread = countUnread(stream.messages, seenAt, open);
  const setDockOpen = (next: boolean) => { markSeen(); setOpen(next); };

  const chat = (
    <AssistantChat
      stream={stream}
      viewingId={viewingId}
      onViewSession={setViewingId}
      headerAction={
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDockOpen(false)} title="Collapse assistant">
          {/* Mirrors the right sidebar's affordance on desktop; a plain close on mobile. */}
          {isDesktop ? <PanelLeftClose className="h-4 w-4" /> : <X className="h-4 w-4" />}
        </Button>
      }
    />
  );

  // Below lg there is no room for a column, so the chat becomes a floating panel.
  if (!isDesktop) {
    return (
      <div>
        {open && (
          <div className="fixed bottom-20 left-4 z-40 flex h-[70vh] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
            <div className="min-h-0 flex-1">{chat}</div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setDockOpen(!open)}
          title={open ? "Close assistant" : "Chat with the assistant"}
          className="fixed bottom-4 left-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
        >
          {open ? <X className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
          {!open && <UnreadBadge count={unread} />}
        </button>
      </div>
    );
  }

  // Collapsed: a slim icon rail, mirroring the right sidebar's rail.
  if (!open) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-muted/30">
        <div className="flex h-14 w-full shrink-0 items-center justify-center border-b border-border">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDockOpen(true)} title="Open assistant">
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex w-full flex-1 flex-col items-center gap-2 py-3">
          <button
            type="button"
            onClick={() => setDockOpen(true)}
            title={unread > 0 ? `${unread} new message${unread === 1 ? "" : "s"}` : "Chat with the assistant"}
            className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MessageSquare className="h-4 w-4" />
            <UnreadBadge count={unread} />
          </button>
          <div className="my-1 h-px w-6 bg-border" />
          {START_WORK.map((item) => (
            <Button key={item.to} variant="outline" size="icon" className="h-8 w-8" title={item.label} render={<Link to={item.to} />}>
              <item.icon className="h-4 w-4" />
            </Button>
          ))}
        </div>
      </aside>
    );
  }

  // Expanded: the resizable dock column.
  return (
    <aside className="relative flex shrink-0 flex-col border-r border-border bg-muted/30" style={{ width }}>
      <div className="min-h-0 flex-1">{chat}</div>
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

// ─── Start work ──────────────────────────────────────────────────────

/**
 * The quick-create row: creating work is how work *starts*, so it belongs on
 * this edge and on every page. Spawning a teammate is deliberately absent — an
 * agent is capacity for running work, and it lives on the right with the team.
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

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[9px] leading-[14px] text-white">
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * Unread = assistant bubbles that arrived since you last looked.
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

function countUnread(messages: Array<{ role: string; createdAt: string }>, seenAt: number, open: boolean): number {
  if (open) return 0;
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
