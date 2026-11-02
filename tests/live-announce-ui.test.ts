/**
 * tests/live-announce-ui.test.ts — The web UI's live announcements
 * (docs/ACCESSIBILITY.md "Live announcements"; ui/src/lib/live-announce.ts):
 * what a screen reader is told when the chat, the queue, the Inbox or the team
 * changes — and, as much, that a poll which found nothing new says nothing
 * (docs/DESIGN.md "Polling Never Disturbs the Reader"), the first answer is a
 * baseline, and queue news is summarized and rate-limited. Plus one source
 * check: a form's error line is a FormError (announced), not a bare red `<p>`.
 */

import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { assertEquals } from "./_assert.ts";
import {
  ACTIVITY_MIN_INTERVAL_MS, ACTIVITY_SETTLE_MS,
  diffQueue, emptyActivity, isEmptyQueueChange, mergeActivity, newAssistantReplies, nextActivityFlushAt,
  offlineAnnouncement, outcomeOf, queueSnapshot, replyAnnouncement, summarizeActivity, teammateSnapshot,
  unreadRise, wentOffline,
} from "../ui/src/lib/live-announce.ts";

const msg = (id: string, role: string, minute: number) => ({ id, role, createdAt: `2025-01-01T10:${String(minute).padStart(2, "0")}:00Z` });

test("newAssistantReplies: the first transcript is a baseline; an unchanged one says nothing", () => {
  const history = [msg("u1", "user", 0), msg("a1", "assistant", 1)];
  const first = newAssistantReplies(null, history);
  assertEquals(first.replies, 0);
  // The same answer again (a reconcile, a re-render) is not news.
  assertEquals(newAssistantReplies(first.snapshot, history).replies, 0);
  assertEquals(newAssistantReplies(first.snapshot, [...history]).replies, 0);
});

test("newAssistantReplies: counts only new assistant bubbles, never your own", () => {
  const { snapshot } = newAssistantReplies(null, [msg("u1", "user", 0)]);
  const withMine = newAssistantReplies(snapshot, [msg("u1", "user", 0), msg("u2", "user", 2)]);
  assertEquals(withMine.replies, 0);
  const withReply = newAssistantReplies(withMine.snapshot, [msg("u1", "user", 0), msg("u2", "user", 2), msg("a2", "assistant", 3)]);
  assertEquals(withReply.replies, 1);
  // A deleted bubble isn't news either.
  assertEquals(newAssistantReplies(withReply.snapshot, [msg("u1", "user", 0)]).replies, 0);
});

test("newAssistantReplies: an empty session's first reply counts; an older transcript swapped in doesn't", () => {
  const empty = newAssistantReplies(null, []);
  assertEquals(newAssistantReplies(empty.snapshot, [msg("a1", "assistant", 5)]).replies, 1);
  // Resuming an earlier chat replaces the transcript with older messages: history, not replies.
  const today = newAssistantReplies(null, [msg("a9", "assistant", 50)]);
  assertEquals(newAssistantReplies(today.snapshot, [msg("old1", "assistant", 1), msg("old2", "assistant", 2)]).replies, 0);
});

test("replyAnnouncement: short, and never the message itself", () => {
  assertEquals(replyAnnouncement(0), null);
  assertEquals(replyAnnouncement(1), "Assistant replied");
  assertEquals(replyAnnouncement(3), "Assistant replied (3 messages)");
});

const item = (id: string, state: string, title = id) => ({ id, state, title });

test("diffQueue: the first poll is a baseline; an unchanged poll is an empty change", () => {
  const items = [item("w1", "READY"), item("w2", "IN_PROGRESS")];
  assertEquals(isEmptyQueueChange(diffQueue(null, items)), true);
  const snap = queueSnapshot(items);
  assertEquals(isEmptyQueueChange(diffQueue(snap, items)), true);
  // Same content in another order (sortQueue reorders as time passes) is still nothing.
  assertEquals(isEmptyQueueChange(diffQueue(snap, [...items].reverse())), true);
});

test("diffQueue: started, at risk, and left the queue", () => {
  const snap = queueSnapshot([item("w1", "READY", "Fix login"), item("w2", "IN_PROGRESS", "Docs"), item("w3", "IN_PROGRESS", "Build")]);
  const change = diffQueue(snap, [
    item("w1", "IN_PROGRESS", "Fix login"), // claimed
    item("w3", "MORIBUND", "Build"),        // its teammate went quiet
    item("w4", "IN_PROGRESS", "Hotfix"),    // enqueued and claimed between two polls
    item("w5", "READY", "Later"),           // just waiting: not news
  ]);
  assertEquals(change.started, ["Fix login", "Hotfix"]);
  assertEquals(change.atRisk, ["Build"]);
  assertEquals(change.left, [{ id: "w2", title: "Docs" }]);
});

test("outcomeOf: a terminal state's bucket; anything else says nothing", () => {
  assertEquals(outcomeOf("COMPLETE"), "finished");
  assertEquals(outcomeOf("FAILED"), "failed");
  assertEquals(outcomeOf("CANCELED"), "canceled");
  assertEquals(outcomeOf("IN_PROGRESS"), null);
  assertEquals(outcomeOf(undefined), null);
});

test("summarizeActivity: one event is named, several are counted, unread rides along", () => {
  assertEquals(summarizeActivity(emptyActivity()), null);
  assertEquals(summarizeActivity(mergeActivity(emptyActivity(), { started: ["Fix login"] })), "“Fix login” started");
  assertEquals(summarizeActivity(mergeActivity(emptyActivity(), { atRisk: ["Build"] })), "“Build” is at risk");
  const busy = mergeActivity(mergeActivity(emptyActivity(), { started: ["a", "b"], failed: ["c"] }), { finished: ["d"], unread: 4 });
  assertEquals(summarizeActivity(busy), "Queue: 2 started, 1 finished, 1 failed · 4 unread in Inbox");
  assertEquals(summarizeActivity(mergeActivity(emptyActivity(), { unread: 1 })), "1 unread in Inbox");
  // The latest count wins when it rose twice before being spoken.
  assertEquals(mergeActivity(mergeActivity(emptyActivity(), { unread: 2 }), { unread: 3 }).unread, 3);
  assertEquals(mergeActivity(mergeActivity(emptyActivity(), { unread: 2 }), { started: ["x"] }).unread, 2);
});

test("nextActivityFlushAt: a short settle, then at most one summary per interval", () => {
  assertEquals(nextActivityFlushAt(null, 1000), 1000 + ACTIVITY_SETTLE_MS);
  // Spoke 2s ago: wait out the interval.
  assertEquals(nextActivityFlushAt(10_000, 12_000), 10_000 + ACTIVITY_MIN_INTERVAL_MS);
  // Spoke long ago: just the settle.
  assertEquals(nextActivityFlushAt(0, 100_000), 100_000 + ACTIVITY_SETTLE_MS);
  assertEquals(nextActivityFlushAt(0, 50, 100, 10), 100);
});

test("unreadRise: only a rise is news; a fall is you reading, the first answer a baseline", () => {
  assertEquals(unreadRise(null, 3), null);
  assertEquals(unreadRise(3, undefined), null);
  assertEquals(unreadRise(3, 3), null);
  assertEquals(unreadRise(3, 2), null);
  assertEquals(unreadRise(2, 4), 4);
});

const mate = (id: string, status: string) => ({ id, name: id, status });

test("wentOffline: online → offline only; the baseline, the unchanged and the dismissed say nothing", () => {
  const team = [mate("ripley", "working"), mate("bishop", "idle"), mate("hicks", "offline")];
  assertEquals(wentOffline(null, team), []);
  const snap = teammateSnapshot(team);
  assertEquals(wentOffline(snap, team), []);
  assertEquals(wentOffline(snap, [mate("ripley", "offline"), mate("hicks", "offline")]), ["ripley"]); // bishop dismissed
  assertEquals(wentOffline(snap, [...team, mate("vasquez", "offline")]), []); // new, never seen online
});

test("offlineAnnouncement: names one or two, counts more", () => {
  assertEquals(offlineAnnouncement([]), null);
  assertEquals(offlineAnnouncement(["ripley"]), "ripley went offline");
  assertEquals(offlineAnnouncement(["ripley", "bishop"]), "ripley and bishop went offline");
  assertEquals(offlineAnnouncement(["a", "b", "c"]), "3 teammates went offline");
});

test("form errors go through FormError (announced), not a bare `{error && <p className=\"… text-destructive\">}`", () => {
  const root = path.join(import.meta.dirname, "..", "ui", "src");
  // `{error && <p className="… text-destructive">{error}</p>}` — the shape every error line had.
  const bare = /\{([\w.?]+) && <p className="[^"]*text-destructive">\{\1\}<\/p>\}/;
  const offenders: string[] = [];
  for (const file of fs.readdirSync(root, { recursive: true }) as string[]) {
    if (!file.endsWith(".tsx")) continue;
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, i) => { if (bare.test(line)) offenders.push(`${file}:${i + 1}`); });
  }
  assertEquals(offenders, []);
});
