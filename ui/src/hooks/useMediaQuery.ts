/**
 * useMediaQuery — subscribe to a CSS media query from React.
 *
 * Used to pick the assistant's *presentation* (left dock vs floating panel)
 * rather than rendering both and hiding one with CSS: two mounted chats would
 * mean duplicate `msg-*` DOM ids, two scroll containers, and double polling.
 *
 * `useSyncExternalStore` is the right tool here — matchMedia is an external
 * store, so there's no effect and no setState-in-effect cascade.
 */

import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  // Server snapshot is unused (no SSR), but the signature requires it.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Tailwind's `lg` breakpoint — where the shell has room for side columns. */
export const LG_QUERY = "(min-width: 1024px)";
