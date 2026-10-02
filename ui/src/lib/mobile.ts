/**
 * lib/mobile.ts — The phone view's pure rules (`/m`, ui/src/mobile/): which
 * shell a path belongs to, when a phone landing on the home page is sent to the
 * phone view, which bottom tab a path shows, and how the Inbox picks and keeps
 * the rows you're reading.
 *
 * The phone view is a separate shell, not a responsive version of the desktop
 * one (docs/DESIGN.md "A Phone Is a Peek"). Dependency-free so it's unit-tested
 * in tests/mobile.test.ts.
 */

/** The phone view's root. Every phone route lives under it. */
export const MOBILE_ROOT = "/m";

/**
 * A phone: a narrow viewport *and* a touch pointer. Width alone would catch a
 * narrow desktop window; a coarse pointer alone would catch an iPad, which has
 * room for the desktop shell.
 */
export const PHONE_QUERY = "(max-width: 640px) and (pointer: coarse)";

/**
 * localStorage key for the explicit choice of view. "desktop" means "I asked
 * for the full UI on this device — stop redirecting me"; visiting `/m` clears it.
 */
export const VIEW_PREF_KEY = "mpt.mobile.view";

export type ViewPref = "desktop" | null;

/** Does this path belong to the phone shell? (`/m` and below, not `/mobile` or `/metrics`.) */
export function isMobilePath(pathname: string): boolean {
  return pathname === MOBILE_ROOT || pathname.startsWith(`${MOBILE_ROOT}/`);
}

/**
 * Should the desktop shell hand this visit to the phone view?
 *
 * Only the home page redirects. A deep link (the "Open full" links the phone
 * view itself offers, or a URL pasted from a desktop) means "show me that
 * page", so it is never hijacked.
 */
export function shouldRedirectToMobile(opts: { pathname: string; isPhone: boolean; pref: ViewPref }): boolean {
  return opts.isPhone && opts.pref !== "desktop" && opts.pathname === "/";
}

/** Read the view preference. Anything unreadable is "no preference". */
export function readViewPref(storage: Pick<Storage, "getItem"> | undefined): ViewPref {
  try {
    return storage?.getItem(VIEW_PREF_KEY) === "desktop" ? "desktop" : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

/** Remember (or clear, with null) the view preference. Failures are ignored: it's a preference, not data. */
export function writeViewPref(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, pref: ViewPref): void {
  try {
    if (pref) storage?.setItem(VIEW_PREF_KEY, pref);
    else storage?.removeItem(VIEW_PREF_KEY);
  } catch {
    // private mode / storage disabled
  }
}

export type MobileTab = "team" | "chat" | "thoughts" | "inbox";

/** The bottom tab a phone path belongs to. A teammate's live view is part of Team. */
export function mobileTabOf(pathname: string): MobileTab {
  const rest = pathname.slice(MOBILE_ROOT.length);
  if (rest === "/chat" || rest.startsWith("/chat/")) return "chat";
  if (rest === "/thoughts" || rest.startsWith("/thoughts/")) return "thoughts";
  if (rest === "/inbox" || rest.startsWith("/inbox/")) return "inbox";
  return "team";
}

/** Each tab's root path, for the bottom bar. */
export const MOBILE_TAB_PATHS: Record<MobileTab, string> = {
  team: MOBILE_ROOT,
  chat: `${MOBILE_ROOT}/chat`,
  thoughts: `${MOBILE_ROOT}/thoughts`,
  inbox: `${MOBILE_ROOT}/inbox`,
};

// ─── Inbox ─────────────────────────────────────────────────────────

/** The fields of a ref comment the outcome picker reads. */
export interface OutcomeComment {
  from: string;
  body: string;
  at: string;
}

/** The fields of a finished WorkItem the outcome picker reads. */
export interface OutcomeItem {
  memberId?: string | null;
  lastStateChangeAt: string;
}

/**
 * How long after a comment the state change may land and still count as "the
 * comment that finished it". A teammate posts `[done] …` then sets COMPLETE, so
 * the two are milliseconds apart; the slack only absorbs clock rounding.
 */
const OUTCOME_SLACK_MS = 60_000;

/** The tags the harnesses prefix a run's closing comment with. */
const CLOSING_TAG = /^\[(done|failed)\]\s*/;

/**
 * The comment that says how a finished WorkItem went — what the phone Inbox
 * shows when you open a row, instead of sending you to the task's full thread.
 *
 * Comments live on the ref (the WorkDef), not the item, so a task reworked three
 * times has every attempt's comments in one thread. The item's own outcome is the
 * last closing comment (`[done]` / `[failed]`) posted before its state changed;
 * failing that (a human force-failed it, or an auto-triage analysis), the last
 * comment its teammate posted by then; failing that, nothing.
 */
export function inboxOutcome<C extends OutcomeComment>(comments: C[], item: OutcomeItem): C | null {
  const cutoff = new Date(item.lastStateChangeAt).getTime() + OUTCOME_SLACK_MS;
  const before = comments.filter((c) => new Date(c.at).getTime() <= cutoff);
  for (let i = before.length - 1; i >= 0; i--) {
    if (CLOSING_TAG.test(before[i]!.body)) return before[i]!;
  }
  if (item.memberId) {
    for (let i = before.length - 1; i >= 0; i--) {
      if (before[i]!.from === item.memberId) return before[i]!;
    }
  }
  return null;
}

/**
 * A closing comment's body without its machine prefix: `[done] Work complete.
 * Summary:\n…` reads as just the summary.
 */
export function outcomeBody(body: string): string {
  return body.replace(CLOSING_TAG, "").replace(/^Work complete\. Summary:\s*\n?/, "").trim();
}

/** The fields of an Inbox row the merge reads. */
export interface InboxRowLike {
  id: string;
  enqueuedAt: string;
}

/**
 * The rows to show: the latest fetch plus the rows you've opened in this visit.
 *
 * Opening a row marks it read, and with "unread only" on the next poll would drop
 * it — out from under the summary you're reading. So opened rows are retained
 * until you leave or change the filter. A fetched row wins over its retained copy
 * (it's fresher). Ordered like the API: newest enqueued first.
 */
export function mergeInboxRows<R extends InboxRowLike>(fetched: R[], retained: R[]): R[] {
  const byId = new Map<string, R>();
  for (const r of retained) byId.set(r.id, r);
  for (const r of fetched) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.enqueuedAt.localeCompare(a.enqueuedAt) || a.id.localeCompare(b.id));
}
