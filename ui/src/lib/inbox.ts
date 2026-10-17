/**
 * lib/inbox.ts — A window event fired after the Inbox marks WorkItems read or
 * unread, so the toolbar's unread badge (components/NavBar) refetches at once
 * instead of waiting for its next poll. Same pattern as the favorite-directories
 * event in lib/directories.ts.
 */

/** Window event name for "Inbox read state changed". */
export const INBOX_CHANGED_EVENT = "mpt:inbox-changed";

/** Tell listeners (the NavBar badges) that some WorkItem's read state changed. */
export function notifyInboxChanged(): void {
  globalThis.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
}

/**
 * What a toolbar count badge shows: hidden (null) at zero or unknown, capped at
 * "99+" so it stays icon-sized.
 */
export function badgeLabel(count: number | undefined | null): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}
