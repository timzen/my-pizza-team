/**
 * Announcer — The app-wide screen-reader announcer (docs/ACCESSIBILITY.md
 * "Live announcements"): two visually hidden live regions, one polite and one
 * assertive, mounted once at the root (main.tsx) so they exist before anything
 * is said — a live region added together with its text isn't announced.
 *
 * Components speak through `useAnnounce()` (hooks/useAnnounce). Queue and Inbox
 * news goes through `useReportActivity()` instead: it's collected here and
 * spoken as one summary, after a short settle and at most every
 * ACTIVITY_MIN_INTERVAL_MS (lib/live-announce.ts), so a busy team is a line
 * every few seconds, not a line per poll.
 *
 * Saying the same text twice in a row (two "Saved"s) must be heard twice, but
 * a live region only speaks when its content *changes*: so each message clears
 * the region first and writes the text a moment later. The text is cleared
 * again after a while, so a reader browsing the page doesn't find a stale one.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnnouncerContext } from "@/hooks/useAnnounce";
import {
  emptyActivity, mergeActivity, nextActivityFlushAt, summarizeActivity,
  type Activity, type Politeness,
} from "@/lib/live-announce";

/** Gap between clearing a region and writing its new text (long enough for screen readers to see two changes). */
const WRITE_DELAY_MS = 100;
/** How long a message stays in its region. */
const CLEAR_AFTER_MS = 8_000;

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const timers = useRef<Record<Politeness, number[]>>({ polite: [], assertive: [] });

  const announce = useCallback((message: string, politeness: Politeness = "polite") => {
    const text = message.trim();
    if (!text) return;
    const set = politeness === "assertive" ? setAssertive : setPolite;
    for (const t of timers.current[politeness]) clearTimeout(t);
    set("");
    timers.current[politeness] = [
      window.setTimeout(() => set(text), WRITE_DELAY_MS),
      window.setTimeout(() => set(""), WRITE_DELAY_MS + CLEAR_AFTER_MS),
    ];
  }, []);

  // The activity summary: news waits in `pending` until its flush timer fires.
  const pending = useRef<Activity>(emptyActivity());
  const lastSpokeAt = useRef<number | null>(null);
  const flushTimer = useRef<number | null>(null);
  const reportActivity = useCallback((change: Partial<Activity>) => {
    pending.current = mergeActivity(pending.current, change);
    if (flushTimer.current !== null) return;
    const now = Date.now();
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      const message = summarizeActivity(pending.current);
      pending.current = emptyActivity();
      if (!message) return;
      lastSpokeAt.current = Date.now();
      announce(message, "polite");
    }, nextActivityFlushAt(lastSpokeAt.current, now) - now);
  }, [announce]);

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of [...all.polite, ...all.assertive]) clearTimeout(t);
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    };
  }, []);

  const value = useMemo(() => ({ announce, reportActivity }), [announce, reportActivity]);
  return (
    <AnnouncerContext value={value}>
      {children}
      {/* aria-atomic: read the whole message, not just the changed words. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-announcer="polite">{polite}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-announcer="assertive">{assertive}</div>
    </AnnouncerContext>
  );
}
