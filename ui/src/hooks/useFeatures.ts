/**
 * useFeatures — The team's resolved feature toggles (Stories, Tasks, Schedules,
 * and each switchable plugin source's),
 * read from `/api/status` and shared by every component that hides a kind.
 *
 * One module-level cache serves all subscribers (the NavBar, the dock, route
 * guards, triage), so mounting several doesn't multiply requests. It refetches
 * when the Config page saves (`notifyFeaturesChanged`) and on a slow poll while
 * anything is subscribed, in case the config changed elsewhere (CLI, a hand edit).
 * `null` means "not loaded yet" — callers keep gated things hidden until then
 * (lib/features.ts `filterByFeatures`).
 *
 * The same `/api/status` answer also carries the registered external Work
 * Sources (`externalSources`), served by `useExternalSources` from this cache,
 * so the Work tabs and the NavBar learn of them without another request — and
 * the resolved assistant chat mode (`assistantChatMode`, served by
 * `useAssistantChatMode`), which picks the assistant's chat or terminal view.
 */

import { useSyncExternalStore } from "react";
import { resolveFeatures, type Features } from "@/lib/features";
import type { ExternalSourceInfo } from "@/lib/work-items";
import { resolveAssistantChatMode, type AssistantChatMode } from "@/lib/assistant-mode";

export type { AssistantChatMode } from "@/lib/assistant-mode";

/** Window event: the toggles changed (fired by the Config page after a save). */
const FEATURES_CHANGED_EVENT = "mpt:features-changed";
/** Background refresh while subscribed; Config-page saves refresh at once. */
const POLL_MS = 30_000;

let current: Features | null = null;
let currentSources: ExternalSourceInfo[] | null = null;
let currentChatMode: AssistantChatMode | null = null;
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const body = await res.json() as {
      features?: Record<string, unknown>; externalSources?: ExternalSourceInfo[]; assistantChatMode?: unknown;
    };
    const next = resolveFeatures(body.features);
    // A daemon too old to report sources has none.
    const nextSources = Array.isArray(body.externalSources) ? body.externalSources : [];
    // A daemon too old to report the mode (or an unknown value) means the default.
    const nextChatMode = resolveAssistantChatMode(body.assistantChatMode);
    // Only notify on a real change, so subscribers don't re-render every poll.
    if (current && sameFeatures(current, next) && currentSources && sameSources(currentSources, nextSources)
      && currentChatMode === nextChatMode) return;
    current = next;
    currentSources = nextSources;
    currentChatMode = nextChatMode;
    for (const l of listeners) l();
  } catch { /* offline: keep the last known toggles */ }
}

function sameFeatures(a: Features, b: Features): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function sameSources(a: ExternalSourceInfo[], b: ExternalSourceInfo[]): boolean {
  return a.length === b.length && a.every((s, i) => s.id === b[i]!.id && s.label === b[i]!.label && s.feature === b[i]!.feature);
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

/** The registered external Work Sources, or null until the first `/api/status` answer. */
export function useExternalSources(): ExternalSourceInfo[] | null {
  return useSyncExternalStore(subscribe, () => currentSources, () => null);
}

/** The assistant chat mode ("chat" | "terminal"), or null until the first `/api/status` answer. */
export function useAssistantChatMode(): AssistantChatMode | null {
  return useSyncExternalStore(subscribe, () => currentChatMode, () => null);
}

/** Tell every `useFeatures` consumer to refetch (call after saving the config). */
export function notifyFeaturesChanged(): void {
  globalThis.dispatchEvent(new Event(FEATURES_CHANGED_EVENT));
}
