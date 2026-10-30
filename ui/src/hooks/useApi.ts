/**
 * useApi — Fetch wrapper for the daemon API, with optional background polling.
 * Returns JSON data with loading/error state.
 * A `null` url fetches nothing (data stays null) — for a source the caller
 * doesn't need right now, e.g. a switched-off kind's list.
 *
 * Polling is a *background* refresh and must never disturb the reader
 * (docs/DESIGN.md "Polling Never Disturbs the Reader"); the rules live in the
 * pure `lib/api-state.ts` reducer:
 *  - `loading` is true only until the current url/deps first answers — never on
 *    a poll or a manual `refetch()` — so `if (loading) return <Spinner/>` can't
 *    unmount a loaded page (and drop the user's text selection).
 *  - An unchanged answer keeps the previous `data` reference (structural
 *    sharing), so nothing re-renders; a changed one only replaces what differs.
 *  - A failed poll keeps the last good `data` and reports `error` beside it.
 * Callers should still gate their "Loading…" placeholder on `!data` rather
 * than `loading` wherever possible.
 */

import { useEffect, useCallback, useReducer, useRef } from "react";
import { apiKey, apiReducer, fetchInto, initialApiState, isLoading, type ApiAction, type ApiState } from "@/lib/api-state";

export function useApi<T>(url: string | null, deps: unknown[] = [], options?: { pollInterval?: number }) {
  const [state, dispatch] = useReducer(
    apiReducer as (s: ApiState<T>, a: ApiAction<T>) => ApiState<T>,
    undefined,
    initialApiState<T>,
  );
  const pollInterval = options?.pollInterval;
  // url + the caller-supplied deps (primitives like ids/filters), serialized so
  // the useCallback dependency list stays a literal array.
  const key = apiKey(url, deps);
  // Overlapping requests may answer out of order: only the newest started applies.
  const seq = useRef(0);

  const refetch = useCallback(() => fetchInto<T>(url, key, dispatch, seq), [url, key]);

  // Data-fetching hook: the fetch is the external system being synced; the
  // dispatches are its protocol (and a no-op dispatch is skipped by React).
  useEffect(() => { void refetch(); }, [refetch]);

  // Auto-refresh polling
  useEffect(() => {
    if (!pollInterval || url === null) return;
    const interval = setInterval(refetch, pollInterval);
    return () => clearInterval(interval);
  }, [refetch, pollInterval, url]);

  // Until the current key's state exists (the render right after a url/deps
  // change), report it as loading with the previous data still shown.
  const current = state.key === key;
  return {
    data: state.data,
    loading: isLoading(state, key, url),
    error: current ? state.error : null,
    refetch,
  };
}

/** POST/PUT/DELETE helper */
export async function apiPost<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export async function apiPut<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function apiDelete<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE" });
  return res.json();
}

export async function apiPatch<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
