/**
 * api-state — The pure state machine behind `hooks/useApi.ts`.
 *
 * Kept free of React so the rules that protect the reader are unit-tested
 * (tests/api-state.test.ts) rather than trusted:
 *
 *  - `loading` means "this url/deps has not answered yet". It is true only for
 *    the first fetch of a key; a background poll or a manual `refetch()` of the
 *    same key never sets it, so a page that shows a spinner while loading
 *    doesn't unmount its content (and the user's text selection) every poll.
 *  - A successful answer goes through `shareStructure`, so an unchanged
 *    response returns the very same state object — React bails out of the
 *    update and nothing re-renders.
 *  - A failed poll keeps the last good `data`; the error is reported alongside
 *    it, and cleared by the next good answer.
 *  - Answers for a key that is no longer current are dropped.
 *
 * See docs/DESIGN.md "Polling Never Disturbs the Reader".
 */

import { shareStructure } from "./structural.ts";

export interface ApiState<T> {
  /** The url/deps this state belongs to (`apiKey`); null before any fetch. */
  key: string | null;
  data: T | null;
  /** The key's first answer hasn't arrived yet. */
  loading: boolean;
  error: string | null;
}

export type ApiAction<T> =
  /** A fetch is starting for `key` (initial, poll, or manual refetch). */
  | { type: "start"; key: string }
  | { type: "success"; key: string; data: T }
  | { type: "failure"; key: string; error: string }
  /** The url is null: nothing to fetch. */
  | { type: "idle"; key: string };

/** One string per url + caller deps, so a change of either is a new key. */
export function apiKey(url: string | null, deps: unknown[]): string {
  return JSON.stringify([url, deps]);
}

/** The state before anything was fetched. */
export function initialApiState<T>(): ApiState<T> {
  return { key: null, data: null, loading: false, error: null };
}

/**
 * Apply one fetch event. Returns `state` itself whenever nothing visible
 * changes, so React's `useReducer` skips the render.
 */
export function apiReducer<T>(state: ApiState<T>, action: ApiAction<T>): ApiState<T> {
  switch (action.type) {
    case "start":
      // Same key: a background refresh. Keep everything as it is — no spinner,
      // no cleared error or data.
      if (action.key === state.key) return state;
      // A new url/deps: it hasn't answered yet. The previous key's data stays
      // until the new answer lands (no flash of an empty page).
      return { key: action.key, data: state.data, loading: true, error: null };
    case "success": {
      if (action.key !== state.key) return state;
      const data = shareStructure(state.data, action.data);
      if (data === state.data && !state.loading && state.error === null) return state;
      return { key: state.key, data, loading: false, error: null };
    }
    case "failure":
      if (action.key !== state.key) return state;
      if (!state.loading && state.error === action.error) return state;
      return { ...state, loading: false, error: action.error };
    case "idle":
      if (action.key === state.key && !state.loading) return state;
      return { key: action.key, data: state.data, loading: false, error: null };
  }
}

/**
 * The `loading` a caller sees: also true during the render where the key has
 * just changed but the effect that dispatches `start` hasn't run yet.
 */
export function isLoading<T>(state: ApiState<T>, key: string, url: string | null): boolean {
  if (url === null) return false;
  return state.key !== key || state.loading;
}

/** The newest request started for one hook instance (shared by its polls and refetches). */
export interface RequestCounter { current: number }

/**
 * One fetch of `url` for `key`, reported through `dispatch`: `start`, then
 * `success` or `failure`. Overlapping requests (a slow poll and a manual
 * refetch) may answer out of order, so only the newest one started (`counter`)
 * may apply its answer. `fetchImpl` is injectable for tests.
 */
export async function fetchInto<T>(
  url: string | null,
  key: string,
  dispatch: (action: ApiAction<T>) => void,
  counter: RequestCounter,
  fetchImpl: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<void> {
  if (url === null) { dispatch({ type: "idle", key }); return; }
  const mine = ++counter.current;
  dispatch({ type: "start", key });
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as T;
    if (mine === counter.current) dispatch({ type: "success", key, data: json });
  } catch (e) {
    if (mine === counter.current) dispatch({ type: "failure", key, error: (e as Error).message });
  }
}
