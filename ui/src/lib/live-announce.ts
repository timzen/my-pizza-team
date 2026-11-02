/**
 * live-announce.ts — What the app-wide announcer says, and when
 * (docs/ACCESSIBILITY.md "Live announcements"; components/Announcer does the
 * DOM work, hooks/useLiveAnnouncements wires the polls to it).
 *
 * Things change without a page load — a chat reply, a queue item starting, a
 * run landing in the Inbox, a teammate dropping off — and a screen-reader user
 * should hear about it, briefly and once. The data arrives by polling, and a
 * poll that found nothing new must say nothing (docs/DESIGN.md "Polling Never
 * Disturbs the Reader"), so every rule here compares the latest answer with a
 * snapshot of the previous one:
 *
 *  - the **first** answer is a baseline, never news (`null` snapshot in, nothing
 *    announced) — loading a page with ten replies doesn't read out "ten new";
 *  - only a real change is reported: an unchanged poll yields an empty change.
 *
 * Queue and Inbox news is noisy (a busy team changes every poll), so it's
 * collected into one `Activity` and spoken as a single summary at most every
 * `ACTIVITY_MIN_INTERVAL_MS` (`nextActivityFlushAt`), never once per poll.
 *
 * Dependency-free so it's unit-tested in tests/live-announce-ui.test.ts.
 */

/** How urgently a message interrupts: `polite` waits for a pause, `assertive` cuts in (errors only). */
export type Politeness = "polite" | "assertive";

// ─── Chat ────────────────────────────────────────────────────────────

/** The slice of a chat message the reply rule reads. */
export interface ChatMessageLike {
  id: string;
  role: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** The transcript as last seen: its message ids, and the newest message's time (ms). */
export interface ChatSnapshot {
  ids: ReadonlySet<string>;
  newest: number;
}

/**
 * Which assistant replies are new since the last look. `prev` is the previous
 * snapshot (null: none yet — this answer is the baseline). A reply is new when
 * its id wasn't seen *and* it's newer than everything that was: a transcript
 * swapped for an older one (resuming an earlier chat) is history, not news.
 * Returns the next snapshot and the count.
 */
export function newAssistantReplies(
  prev: ChatSnapshot | null,
  messages: readonly ChatMessageLike[],
): { snapshot: ChatSnapshot; replies: number } {
  const time = (m: ChatMessageLike) => Date.parse(m.createdAt) || 0;
  const snapshot: ChatSnapshot = {
    ids: new Set(messages.map((m) => m.id)),
    newest: Math.max(prev?.newest ?? -Infinity, ...messages.map(time)),
  };
  if (prev === null) return { snapshot, replies: 0 };
  const replies = messages.filter((m) => m.role === "assistant" && !prev.ids.has(m.id) && time(m) > prev.newest).length;
  return { snapshot, replies };
}

/** "Assistant replied" — short on purpose: the message itself is in the transcript, not read out. */
export function replyAnnouncement(replies: number): string | null {
  if (replies <= 0) return null;
  return replies === 1 ? "Assistant replied" : `Assistant replied (${replies} messages)`;
}

// ─── Queue ───────────────────────────────────────────────────────────

/** The slice of a queue item (lib/queue.ts QueueItem) the queue rule reads. */
export interface QueueItemLike {
  id: string;
  title: string;
  state: string;
}

/** The queue as last seen: each item's state and title, by id. */
export type QueueSnapshot = ReadonlyMap<string, { state: string; title: string }>;

/** A snapshot of the queue, for the next `diffQueue`. */
export function queueSnapshot(items: readonly QueueItemLike[]): Map<string, { state: string; title: string }> {
  return new Map(items.map((i) => [i.id, { state: i.state, title: i.title }]));
}

/** What changed in the queue between two polls. `left` items are no longer in flight; their outcome is looked up. */
export interface QueueChange {
  /** Items now being worked on that weren't before (claimed since the last poll, even if never seen waiting). */
  started: string[];
  /** Items newly at risk (their teammate went quiet). */
  atRisk: string[];
  /** Items that left the queue: they finished, failed or were canceled. */
  left: Array<{ id: string; title: string }>;
}

/** Compare the queue with its previous snapshot (null: this is the baseline, so no change). */
export function diffQueue(prev: QueueSnapshot | null, items: readonly QueueItemLike[]): QueueChange {
  const change: QueueChange = { started: [], atRisk: [], left: [] };
  if (prev === null) return change;
  const now = new Set<string>();
  for (const item of items) {
    now.add(item.id);
    const before = prev.get(item.id)?.state;
    if (before === item.state) continue;
    if (item.state === "IN_PROGRESS") change.started.push(item.title);
    else if (item.state === "MORIBUND") change.atRisk.push(item.title);
  }
  for (const [id, { title }] of prev) if (!now.has(id)) change.left.push({ id, title });
  return change;
}

/** True when a queue change has nothing in it (the usual poll). */
export function isEmptyQueueChange(c: QueueChange): boolean {
  return c.started.length === 0 && c.atRisk.length === 0 && c.left.length === 0;
}

// ─── Activity: the rate-limited summary ──────────────────────────────

/** Queue and Inbox news collected between two announcements. */
export interface Activity {
  started: string[];
  finished: string[];
  failed: string[];
  canceled: string[];
  atRisk: string[];
  /** The Inbox's unread count after it last went up (undefined: it didn't). */
  unread?: number;
}

/** No news yet. */
export function emptyActivity(): Activity {
  return { started: [], finished: [], failed: [], canceled: [], atRisk: [] };
}

/** Fold `more` into `a` (the latest unread count wins). */
export function mergeActivity(a: Activity, more: Partial<Activity>): Activity {
  return {
    started: [...a.started, ...(more.started ?? [])],
    finished: [...a.finished, ...(more.finished ?? [])],
    failed: [...a.failed, ...(more.failed ?? [])],
    canceled: [...a.canceled, ...(more.canceled ?? [])],
    atRisk: [...a.atRisk, ...(more.atRisk ?? [])],
    unread: more.unread ?? a.unread,
  };
}

/** Which bucket an item that left the queue goes in, from its terminal state (null: unknown, say nothing). */
export function outcomeOf(state: string | undefined): "finished" | "failed" | "canceled" | null {
  if (state === "COMPLETE") return "finished";
  if (state === "FAILED") return "failed";
  if (state === "CANCELED") return "canceled";
  return null;
}

/**
 * One sentence for everything collected, or null when there's nothing to say.
 * A single event names its item ("“Fix login” finished"); more are counted
 * ("Queue: 2 started, 1 failed") so a busy minute stays one short line. A rise
 * in the Inbox's unread count rides along at the end.
 */
export function summarizeActivity(a: Activity): string | null {
  const buckets: Array<[string[], string]> = [
    [a.started, "started"],
    [a.finished, "finished"],
    [a.failed, "failed"],
    [a.canceled, "canceled"],
    [a.atRisk, "at risk"],
  ];
  const events = buckets.filter(([items]) => items.length > 0);
  const total = events.reduce((n, [items]) => n + items.length, 0);
  const parts: string[] = [];
  if (total === 1) {
    const [[items, verb]] = events as [[string[], string]];
    parts.push(verb === "at risk" ? `“${items[0]}” is at risk` : `“${items[0]}” ${verb}`);
  } else if (total > 1) {
    parts.push(`Queue: ${events.map(([items, verb]) => `${items.length} ${verb}`).join(", ")}`);
  }
  if (a.unread !== undefined && a.unread > 0) parts.push(`${a.unread} unread in Inbox`);
  return parts.length ? parts.join(" · ") : null;
}

/** At most one activity summary this often. */
export const ACTIVITY_MIN_INTERVAL_MS = 15_000;
/** How long news waits for its siblings (the outcome lookup, the other poll) before it's spoken. */
export const ACTIVITY_SETTLE_MS = 1_500;

/**
 * When to speak news that just arrived: after a short settle, but never sooner
 * than `minInterval` after the last summary (`lastAt` null: nothing said yet).
 */
export function nextActivityFlushAt(
  lastAt: number | null,
  now: number,
  minInterval = ACTIVITY_MIN_INTERVAL_MS,
  settle = ACTIVITY_SETTLE_MS,
): number {
  const soonest = now + settle;
  return lastAt === null ? soonest : Math.max(soonest, lastAt + minInterval);
}

// ─── Inbox ───────────────────────────────────────────────────────────

/**
 * The Inbox's unread count went from `prev` to `next`: report the new count
 * only when it rose (a run landed). A fall is you reading it; null `prev` is
 * the baseline; undefined `next` is "not answered yet".
 */
export function unreadRise(prev: number | null, next: number | undefined): number | null {
  if (prev === null || next === undefined) return null;
  return next > prev ? next : null;
}

// ─── Teammates ───────────────────────────────────────────────────────

/** The slice of a teammate (lib/team.ts Teammate) the offline rule reads. */
export interface TeammateLike {
  id: string;
  name: string;
  status: string;
}

/** Each teammate's status as last seen, by id. */
export type TeammateSnapshot = ReadonlyMap<string, string>;

/** A snapshot of the teammates, for the next `wentOffline`. */
export function teammateSnapshot(teammates: readonly TeammateLike[]): Map<string, string> {
  return new Map(teammates.map((t) => [t.id, t.status]));
}

/**
 * Names of teammates that were online at the last poll and are offline now
 * (null `prev`: the baseline). One that vanished from the list was dismissed
 * by a human — not news.
 */
export function wentOffline(prev: TeammateSnapshot | null, teammates: readonly TeammateLike[]): string[] {
  if (prev === null) return [];
  return teammates
    .filter((t) => t.status === "offline" && prev.has(t.id) && prev.get(t.id) !== "offline")
    .map((t) => t.name);
}

/** "ripley went offline", "ripley and bishop went offline", "3 teammates went offline". */
export function offlineAnnouncement(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} went offline`;
  if (names.length === 2) return `${names[0]} and ${names[1]} went offline`;
  return `${names.length} teammates went offline`;
}
