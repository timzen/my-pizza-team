/**
 * useLiveAnnouncements — Watches the shell's live data and tells a screen
 * reader what changed (docs/ACCESSIBILITY.md "Live announcements"): a new
 * assistant reply, queue items starting / finishing / failing, the Inbox's
 * unread count rising, a teammate going offline.
 *
 * Each watcher keeps a snapshot of the last answer in a ref and diffs the next
 * one against it with the pure rules in lib/live-announce.ts — the first
 * answer is a baseline, and an unchanged poll says nothing (docs/DESIGN.md
 * "Polling Never Disturbs the Reader"). Both shells call these on the data
 * they already own: the desktop's SideDock (chat, queue, team) and NavBar
 * (Inbox count), and the phone's MobileShell — one stream each, so nothing is
 * announced twice.
 */

import { useEffect, useRef } from "react";
import { useAnnounce, useReportActivity } from "@/hooks/useAnnounce";
import {
  diffQueue, isEmptyQueueChange, newAssistantReplies, offlineAnnouncement, outcomeOf,
  queueSnapshot, replyAnnouncement, teammateSnapshot, unreadRise, wentOffline,
  type Activity, type ChatMessageLike, type ChatSnapshot, type QueueItemLike, type QueueSnapshot, type TeammateLike, type TeammateSnapshot,
} from "@/lib/live-announce";

/** At most this many finished items get their outcome looked up per change (a burst beyond is rare). */
const MAX_OUTCOME_LOOKUPS = 5;

/**
 * Say "Assistant replied" when a new assistant bubble arrives. `loaded` is
 * false until the transcript's first fetch has answered (and while a switch
 * to reading an earlier session loads), so the history is a baseline.
 */
export function useAnnounceReplies(messages: readonly ChatMessageLike[], loaded: boolean): void {
  const announce = useAnnounce();
  const snapshot = useRef<ChatSnapshot | null>(null);
  useEffect(() => {
    if (!loaded) { snapshot.current = null; return; }
    const { snapshot: next, replies } = newAssistantReplies(snapshot.current, messages);
    snapshot.current = next;
    const message = replyAnnouncement(replies);
    if (message) announce(message);
  }, [messages, loaded, announce]);
}

/**
 * Report queue items that started, went at risk, or left the queue (looking
 * up whether each finished, failed or was canceled) to the announcer's
 * rate-limited summary. `loaded` is false until the first poll answered.
 */
export function useAnnounceQueue(items: readonly QueueItemLike[], loaded: boolean): void {
  const reportActivity = useReportActivity();
  const snapshot = useRef<QueueSnapshot | null>(null);
  // A poll hands back a new array even when nothing changed: key on the content.
  const signature = items.map((i) => `${i.id}:${i.state}`).join(",");
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; });

  useEffect(() => {
    if (!loaded) return;
    const current = itemsRef.current;
    const change = diffQueue(snapshot.current, current);
    snapshot.current = queueSnapshot(current);
    if (isEmptyQueueChange(change)) return;
    reportActivity({ started: change.started, atRisk: change.atRisk });
    if (change.left.length === 0) return;
    // The queue only lists items in flight, so how one ended is a lookup — one
    // request per item that left, only when one did, never per poll.
    void Promise.all(change.left.slice(0, MAX_OUTCOME_LOOKUPS).map(async ({ id, title }) => {
      try {
        const res = await fetch(`/api/work-items/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const { item } = await res.json() as { item?: { state?: string } };
        const outcome = outcomeOf(item?.state);
        if (outcome) reportActivity({ [outcome]: [title] } as Partial<Activity>);
      } catch { /* the daemon's away; the Inbox will still show it */ }
    }));
  }, [signature, loaded, reportActivity]);
}

/** Add the Inbox's unread count to the summary when it rises (a run landed). Undefined: not answered yet. */
export function useAnnounceUnread(unread: number | undefined): void {
  const reportActivity = useReportActivity();
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (unread === undefined) return;
    const risen = unreadRise(prev.current, unread);
    prev.current = unread;
    if (risen !== null) reportActivity({ unread: risen });
  }, [unread, reportActivity]);
}

/** Say "<name> went offline" when a teammate drops off. `loaded` is false until the first poll answered. */
export function useAnnounceOffline(teammates: readonly TeammateLike[], loaded: boolean): void {
  const announce = useAnnounce();
  const snapshot = useRef<TeammateSnapshot | null>(null);
  const signature = teammates.map((t) => `${t.id}:${t.status}`).join(",");
  const teammatesRef = useRef(teammates);
  useEffect(() => { teammatesRef.current = teammates; });

  useEffect(() => {
    if (!loaded) return;
    const current = teammatesRef.current;
    const message = offlineAnnouncement(wentOffline(snapshot.current, current));
    snapshot.current = teammateSnapshot(current);
    if (message) announce(message);
  }, [signature, loaded, announce]);
}
