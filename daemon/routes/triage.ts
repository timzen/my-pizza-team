/**
 * daemon/routes/triage.ts — Triage proposals on any triage subject's WorkDef,
 * and the request/response handling every accept/reject route shares.
 * See docs/DESIGN.md "Auto Triage" and "External sources" — "Triage mode".
 *
 * A triage subject is a WorkDef whose thread holds analyses, proposals, and
 * decisions: a note's triage container (`triage-<noteId>`), or a triage-mode
 * mirror of an external item. The note routes (`/api/thoughts/:id/proposals/…`,
 * daemon/routes/thoughts.ts) address a subject by its note; these address it by
 * its WorkDef id, which is what a mirror has:
 *
 *   GET  /api/work-defs/:id/triage                                — thread, proposals folded
 *                                                                    with decisions, badge
 *   POST /api/work-defs/:id/triage/proposals/:proposalId/accept   — create the work (never start it)
 *   POST /api/work-defs/:id/triage/proposals/:proposalId/reject   — one appended line
 *
 * **Run** (`POST /api/work-defs/:id/enqueue`) on a triage-mode mirror is
 * **Triage now** (Store.runWorkDef). Decisions are appended to the def's own
 * `comments.jsonl`, as a note's are.
 */

import type { Context } from "hono";
import type { RouteContext } from "./types.ts";
import type { AcceptProposalOptions, ProposalResult, TriageProposalOverrides } from "../store.ts";
import { mirrorView } from "./work-sources.ts";

/** Read an accept request's body: `workDefId` (the "Edit" path's already-created work), `overrides`, `from`. */
export async function readAcceptOptions(c: Context): Promise<AcceptProposalOptions> {
  const body = await c.req.json().catch(() => ({})) as {
    workDefId?: unknown; overrides?: Record<string, unknown>; from?: unknown;
  };
  return {
    from: typeof body.from === "string" ? body.from : undefined,
    existingWorkDefId: typeof body.workDefId === "string" ? body.workDefId : undefined,
    overrides: body.overrides as TriageProposalOverrides | undefined,
  };
}

/** Read a reject request's `from`, if any. */
export async function readRejectFrom(c: Context): Promise<string | undefined> {
  const body = await c.req.json().catch(() => ({})) as { from?: unknown };
  return typeof body.from === "string" ? body.from : undefined;
}

/** An accept/reject result as a response: 404 for a missing proposal, 409 for one already decided. */
export function proposalResponse(c: Context, res: ProposalResult) {
  if (!res.ok) return c.json({ success: false, error: res.error }, res.code === "not-found" ? 404 : 409);
  return c.json({ success: true, decision: res.decision });
}

export function registerTriageRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  // Everything a triage subject's page shows: the thread (analyses *and*
  // decisions), its proposals folded with what was decided, the badge, and for
  // a mirror its provenance. 409 for a WorkDef that isn't a triage subject.
  app.get("/api/work-defs/:id/triage", (c) => {
    const id = c.req.param("id");
    const def = store.getWorkDef(id);
    if (!def) return c.json({ success: false, error: "WorkDef not found" }, 404);
    const subject = store.triageSubjectOf(id);
    if (!subject) return c.json({ success: false, error: `WorkDef "${id}" isn't triaged (not a note's triage, nor an external item in triage mode)` }, 409);
    const thread = store.getTriageThreadForWorkDef(id);
    return c.json({
      workDefId: id,
      subject: subject.kind,
      ...(subject.kind === "thought" ? { thoughtId: subject.thoughtId } : {}),
      mirror: mirrorView(store, def),
      entries: thread.entries,
      proposals: thread.proposals,
      pending: thread.pending,
      badge: thread.badge,
      latestOutcome: thread.latestOutcome,
    });
  });

  // Accept: create the work and record the decision. Creates only — nothing is enqueued.
  app.post("/api/work-defs/:id/triage/proposals/:proposalId/accept", async (c) => {
    const res = store.acceptProposalOn(c.req.param("id"), c.req.param("proposalId"), await readAcceptOptions(c));
    return proposalResponse(c, res);
  });

  // Reject: one appended line, no reason, not a turn.
  app.post("/api/work-defs/:id/triage/proposals/:proposalId/reject", async (c) => {
    const res = store.rejectProposalOn(c.req.param("id"), c.req.param("proposalId"), await readRejectFrom(c));
    return proposalResponse(c, res);
  });
}
