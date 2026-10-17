/**
 * ui/src/lib/directories.ts — Ordering rules for directory-picker suggestions
 * (components/ui/directory-input.tsx). Pure, so tests/directories.test.ts can
 * check it without a DOM. See docs/DESIGN.md "Favorite Directories".
 */

/** One row of a directory picker's dropdown. */
export interface DirectorySuggestion {
  dir: string;
  favorite: boolean;
}

/**
 * Order the dropdown: favorites, then recent, then caller extras — deduped
 * (first occurrence wins, so a favorite never reappears lower down) and
 * filtered by a case-insensitive substring of `query`.
 */
export function orderDirectorySuggestions(
  favorites: string[], recent: string[], extras: string[], query: string,
): DirectorySuggestion[] {
  const fav = new Set(favorites);
  const all = [...new Set([...favorites, ...recent, ...extras])].filter(Boolean);
  const q = query.trim().toLowerCase();
  return all
    .filter((d) => !q || d.toLowerCase().includes(q))
    .map((dir) => ({ dir, favorite: fav.has(dir) }));
}

/**
 * Window event fired after any favorite is added or removed, so every mounted
 * picker (and the Config page's list) refetches instead of showing a stale star.
 */
export const FAVORITES_CHANGED_EVENT = "mpt:favorite-directories-changed";

/** Tell every mounted directory picker that the favorites changed. */
export function notifyFavoritesChanged(): void {
  globalThis.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
}
