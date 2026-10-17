/**
 * useFeatures — The team's resolved feature toggles (Stories, Tasks, Schedules),
 * read from `/api/status` and shared by every component that hides a kind.
 *
 * One module-level cache serves all subscribers (the NavBar, the dock, route
 * guards, triage), so mounting several doesn't multiply requests. It refetches
 * when the Config page saves (`notifyFeaturesChanged`) and on a slow poll while
 * anything is subscribed, in case the config changed elsewhere (CLI, a hand edit).
 * `null` means "not loaded yet" — callers keep gated things hidden until then
 * (lib/features.ts `filterByFeatures`).
 */

import { useSyncExternalStore } from "react";
import { resolveFeatures, type Features } from "@/lib/features";

/** Window event: the toggles changed (fired by the Config page after a save). */
const FEATURES_CHANGED_EVENT = "mpt:features-changed";
/** Background refresh while subscribed; Config-page saves refresh at once. */
const POLL_MS = 30_000;

let current: Features | null = null;
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const next = resolveFeatures((await res.json() as { features?: Record<string, unknown> }).features);
    // Only notify on a real change, so subscribers don't re-render every poll.
    if (current && sameFeatures(current, next)) return;
    current = next;
    for (const l of listeners) l();
  } catch { /* offline: keep the last known toggles */ }
}

function sameFeatures(a: Features, b: Features): boolean {
  return a.stories === b.stories && a.tasks === b.tasks && a.schedules === b.schedules;
}

function onChanged() { void load(); }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void load();
    pollTimer = setInterval(load, POLL_MS);
    globalThis.addEventListener(FEATURES_CHANGED_EVENT, onChanged);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      globalThis.removeEventListener(FEATURES_CHANGED_EVENT, onChanged);
    }
  };
}

/** The resolved toggles, or null until the first `/api/status` answer. */
export function useFeatures(): Features | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** Tell every `useFeatures` consumer to refetch (call after saving the config). */
export function notifyFeaturesChanged(): void {
  globalThis.dispatchEvent(new Event(FEATURES_CHANGED_EVENT));
}
