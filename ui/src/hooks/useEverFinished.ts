/**
 * useEverFinished — Has any work finished at all, read or not? The Inbox asks
 * when its "Unread only" list comes back empty, to tell **Inbox zero**
 * (everything's been read) from **nothing has finished yet** — two different
 * empty states (docs/DESIGN.md "An Empty Screen Teaches"). Shared by the
 * desktop Inbox (pages/InboxPage) and the phone's (mobile/MobileInbox).
 */

import { useApi } from "@/hooks/useApi";

/**
 * Whether any COMPLETE/FAILED WorkItem exists. Fetched (one `limit=1` count,
 * polled slowly) only while `ask`; null until it answers, or when not asked.
 */
export function useEverFinished(ask: boolean): boolean | null {
  const { data } = useApi<{ total: number }>(
    ask ? "/api/work-items?state=COMPLETE,FAILED&limit=1" : null, [ask], { pollInterval: 15_000 },
  );
  return ask && data ? data.total > 0 : null;
}
