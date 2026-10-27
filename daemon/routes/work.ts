/**
 * daemon/routes/work.ts — WorkItem queue routes (the legible record of what
 * will / is / did happen). Powers the Inbox and the sidebar, plus the recovery
 * actions: cancel (READY), force-fail (MORIBUND), re-enqueue (by ref), and
 * read/unread. READY items blocked by a directory lease report `blockedBy`;
 * a triage-mode external item's runs report `triage: true`.
 * See docs/DESIGN.md "The WorkItem".
 */

import type { RouteContext } from "./types.ts";
import type { WorkItem, WorkItemState, WorkItemRef } from "../../shared/types.ts";
import type { WorkItemView, WorkItemsResponse, WorkItemMutationResponse, ForceFailWorkItemRequest, ReEnqueueRequest } from "../../shared/protocol.ts";

const ALL_STATES: WorkItemState[] = ["READY", "IN_PROGRESS", "MORIBUND", "COMPLETE", "FAILED", "CANCELED"];

export function registerWorkRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  /**
   * The wire view of a WorkItem. A READY item held back by an exclusive
   * directory lease carries `blockedBy` (who holds the directory, on what), so
   * the Queue page can say why it's waiting (docs/DESIGN.md "Work Matching:
   * Directory Affinity").
   */
  function view(wi: WorkItem): WorkItemView {
    const def = store.getWorkDef(wi.ref.workDefId);
    const blocker = wi.state === "READY" ? store.getDirectoryBlocker(wi) : null;
    const holder = blocker?.memberId ? store.getMember(blocker.memberId) : null;
    return {
      id: wi.id, title: wi.title, ref: wi.ref, parent: def?.parent, directory: wi.directory,
      state: wi.state, read: wi.read, memberId: wi.memberId,
      enqueuedAt: wi.enqueuedAt, lastStateChangeAt: wi.lastStateChangeAt,
      attempt: wi.attempt, retryAt: wi.retryAt, error: wi.error,
      // A triage-mode external item's run: its outcome is on the mirror's Triage tab.
      ...(def && store.isTriageModeMirror(def) ? { triage: true } : {}),
      ...(blocker
        ? {
          blockedBy: {
            workItemId: blocker.id, title: blocker.title, directory: blocker.directory,
            memberId: blocker.memberId, memberName: holder?.name ?? blocker.memberId,
          },
        }
        : {}),
    };
  }

  // List WorkItems. Filters: ?state=READY,IN_PROGRESS  ?read=false  ?limit=&offset=
  app.get("/api/work-items", (c) => {
    const stateParam = c.req.query("state");
    const states = stateParam
      ? stateParam.split(",").map(s => s.trim().toUpperCase()).filter((s): s is WorkItemState => (ALL_STATES as string[]).includes(s))
      : undefined;
    const readParam = c.req.query("read");
    const read = readParam === undefined ? undefined : readParam === "true";
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;

    const { items, total } = store.getWorkItems({ states, read, limit, offset });
    return c.json({ items: items.map(view), total } satisfies WorkItemsResponse);
  });

  app.get("/api/work-items/:id", (c) => {
    const item = store.getWorkItem(c.req.param("id"));
    if (!item) return c.json({ success: false, error: "WorkItem not found" }, 404);
    return c.json({ item: view(item) });
  });

  // Cancel a READY item (human).
  app.post("/api/work-items/:id/cancel", (c) => {
    const ok = store.cancelWorkItem(c.req.param("id"));
    if (!ok) return c.json({ success: false, error: "WorkItem is not READY" } satisfies WorkItemMutationResponse, 400);
    return c.json({ success: true } satisfies WorkItemMutationResponse);
  });

  // Force a MORIBUND item to FAILED, optionally re-enqueuing a fresh attempt.
  app.post("/api/work-items/:id/force-fail", async (c) => {
    const body = await c.req.json().catch(() => ({})) as ForceFailWorkItemRequest;
    const res = store.forceFailWorkItem(c.req.param("id"), !!body.reEnqueue);
    if (!res.ok) return c.json({ success: false, error: res.error } satisfies WorkItemMutationResponse, 400);
    return c.json({ success: true } satisfies WorkItemMutationResponse);
  });

  // Mark read/unread (Inbox). ?read=false to mark unread.
  app.post("/api/work-items/:id/read", (c) => {
    const read = c.req.query("read") !== "false";
    const ok = store.markWorkItemRead(c.req.param("id"), read);
    if (!ok) return c.json({ success: false, error: "WorkItem not found" } satisfies WorkItemMutationResponse, 404);
    return c.json({ success: true } satisfies WorkItemMutationResponse);
  });

  // Re-enqueue a ref that has no active WorkItem (recovery for stuck/failed work).
  app.post("/api/work-items/re-enqueue", async (c) => {
    const body = await c.req.json().catch(() => ({})) as ReEnqueueRequest;
    if (!body.ref) return c.json({ success: false, error: "Field 'ref' is required" } satisfies WorkItemMutationResponse, 400);
    const item = store.reEnqueueRef(body.ref as WorkItemRef);
    if (!item) return c.json({ success: false, error: "Ref has an active WorkItem, or is unknown" } satisfies WorkItemMutationResponse, 400);
    return c.json({ success: true } satisfies WorkItemMutationResponse);
  });
}
