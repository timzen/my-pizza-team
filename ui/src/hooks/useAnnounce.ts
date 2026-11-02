/**
 * useAnnounce — The app-wide announcer's hooks (docs/ACCESSIBILITY.md "Live
 * announcements"): `announce(message, politeness)` speaks a short message
 * through one of the two screen-reader live regions components/Announcer
 * renders, and `reportActivity(change)` hands queue / Inbox news to its
 * rate-limited summary (lib/live-announce.ts).
 *
 * Use it for things that change without a page load and that a sighted user
 * would notice: a save's result, a form's error (assertive), a reply arriving.
 * Never for a poll's answer as such — diff it first (lib/live-announce.ts), so
 * unchanged data is never re-announced (docs/DESIGN.md "Polling Never Disturbs
 * the Reader").
 *
 * The provider lives in `components/Announcer.tsx` (this file stays
 * component-free so fast refresh keeps working). Outside a provider both are
 * no-ops, so a component never has to care whether it's mounted under one.
 */

import { createContext, useContext } from "react";
import type { Activity, Politeness } from "@/lib/live-announce";

export interface AnnouncerValue {
  /** Speak `message` (politely unless said otherwise); the same message twice is spoken twice. */
  announce: (message: string, politeness?: Politeness) => void;
  /** Add queue / Inbox news to the next summary (spoken at most every ACTIVITY_MIN_INTERVAL_MS). */
  reportActivity: (change: Partial<Activity>) => void;
}

const NOOP: AnnouncerValue = { announce: () => {}, reportActivity: () => {} };

export const AnnouncerContext = createContext<AnnouncerValue>(NOOP);

/** The announcer's `announce` — `announce("Saved")`, `announce("Couldn't save", "assertive")`. */
export function useAnnounce(): AnnouncerValue["announce"] {
  return useContext(AnnouncerContext).announce;
}

/** The announcer's `reportActivity`, for the queue and Inbox watchers (hooks/useLiveAnnouncements). */
export function useReportActivity(): AnnouncerValue["reportActivity"] {
  return useContext(AnnouncerContext).reportActivity;
}
