/**
 * lib/inbox.ts — A window event fired after the Inbox marks WorkItems read or
 * unread, so the toolbar's unread badge (components/NavBar) refetches at once
 * instead of waiting for its next poll. Same pattern as the favorite-directories
 * event in lib/directories.ts. Also the badge text and the home link's
 * accessible name, which says in words what the badges say in numbers.
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

/**
 * The Pizza Team home link's accessible name and tooltip: the badges are only
 * numbers, so the name says what they count — "Pizza Team · 3 unread in Inbox
 * · 2 queued". Counts that are zero or unknown (hidden badges) are left out.
 */
export function homeLinkLabel(queued: number | undefined | null, unread: number | undefined | null): string {
  return ["Pizza Team", ...homeLinkCounts(queued, unread)].join(" · ");
}

/**
 * The counts part of the home link's name, in words (["3 unread in Inbox",
 * "2 queued"]): read after the visible "Pizza Team", so the spoken name still
 * starts with the visible one (WCAG 2.5.3 Label in Name).
 */
export function homeLinkCounts(queued: number | undefined | null, unread: number | undefined | null): string[] {
  const parts: string[] = [];
  if (unread && unread > 0) parts.push(`${unread} unread in Inbox`);
  if (queued && queued > 0) parts.push(`${queued} queued`);
  return parts;
}
