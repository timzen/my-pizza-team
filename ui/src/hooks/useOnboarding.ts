/**
 * useOnboarding — The Welcome checklist's live state (`GET /api/onboarding`),
 * for the card on Home and the phone's Team tab, plus the two writes that
 * change whether it shows: Dismiss and Help's "Show the Welcome checklist".
 *
 * Polled through useApi, so an unchanged answer re-renders nothing
 * (docs/DESIGN.md "Polling Never Disturbs the Reader"): every 5s while the card
 * is on screen — a step done in another tab, the CLI or by the assistant ticks
 * off here within seconds — and every minute while it isn't. A dismiss or
 * reopen anywhere fires `ONBOARDING_CHANGED_EVENT`, and every mounted copy
 * refetches at once (the dock's Help panel reopening the card under it).
 *
 * Each step that ticks off is announced politely (lib/onboarding.ts
 * `welcomeNews`, diffed against the last answer; the first is a baseline).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OnboardingResponse } from "@shared/protocol";
import { apiPost, useApi } from "@/hooks/useApi";
import { useAnnounce } from "@/hooks/useAnnounce";
import { ONBOARDING_CHANGED_EVENT, welcomeMode, welcomeNews, type WelcomeMode } from "@/lib/onboarding";

/** Poll intervals: while the card shows, and while it doesn't. */
const VISIBLE_POLL_MS = 5_000;
const HIDDEN_POLL_MS = 60_000;

/** Tell every mounted Welcome card the daemon's answer changed. */
function notifyOnboardingChanged(): void {
  window.dispatchEvent(new Event(ONBOARDING_CHANGED_EVENT));
}

/** Help's "Show the Welcome checklist": reopen the card (even for a finished team). */
export async function reopenWelcome(): Promise<boolean> {
  try {
    const res = await apiPost<OnboardingResponse>("/api/onboarding/reopen");
    notifyOnboardingChanged();
    return Array.isArray(res?.steps);
  } catch {
    return false;
  }
}

export interface OnboardingState {
  data: OnboardingResponse | null;
  mode: WelcomeMode;
  /** Re-ask now (after the sample task is created, say). */
  refetch: () => void;
  /** Dismiss (or, once finished, close) the card: hidden at once, stored by the daemon. */
  dismiss: () => Promise<void>;
}

/** The checklist's state, polled and announced. */
export function useOnboarding(): OnboardingState {
  const [fast, setFast] = useState(true);
  const { data, refetch } = useApi<OnboardingResponse>("/api/onboarding", [], { pollInterval: fast ? VISIBLE_POLL_MS : HIDDEN_POLL_MS });
  // Did this screen show the steps unfinished? Then it shows "You're set" when they finish.
  const [sawChecklist, setSawChecklist] = useState(false);
  const [closed, setClosed] = useState(false);
  const announce = useAnnounce();

  // Derived during render (React's "adjusting state when a prop changes"), not in an effect.
  const mode = welcomeMode(data, { sawChecklist, closed });
  if (mode === "checklist" && !sawChecklist) setSawChecklist(true);
  if ((mode !== "hidden") !== fast) setFast(mode !== "hidden");

  // A dismiss or reopen anywhere: ask again, and let a reopen show the card here.
  useEffect(() => {
    const onChange = () => { setClosed(false); void refetch(); };
    window.addEventListener(ONBOARDING_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ONBOARDING_CHANGED_EVENT, onChange);
  }, [refetch]);

  // Speak the steps that ticked off since the last answer (while the card is up).
  const last = useRef<OnboardingResponse | null>(null);
  useEffect(() => {
    if (!data) return;
    const news = mode === "hidden" ? [] : welcomeNews(last.current, data);
    last.current = data;
    if (news.length) announce(news.join(" "));
  }, [data, mode, announce]);

  const dismiss = useCallback(async () => {
    setClosed(true);
    setSawChecklist(false);
    try {
      await apiPost("/api/onboarding/dismiss");
    } finally {
      // Other copies refetch; this one stays closed until a reopen clears it.
      window.dispatchEvent(new Event(ONBOARDING_CHANGED_EVENT));
      setClosed(true);
    }
  }, []);

  return { data, mode, refetch: () => { void refetch(); }, dismiss };
}
