/**
 * daemon/routes/work-defs.ts — WorkDef CRUD + enqueue.
 *
 * WorkDefs are standalone work definitions (Solitary one-shots and Scheduled
 * cron work), stored as markdown on disk. Creating one enqueues a WorkItem by
 * default; "save without enqueueing" passes `enqueue: false`. See the plan.
 *
 * **Pending** (docs/DESIGN.md "Pending: Write, Review, Activate"). `pending: true`
 * on create saves a WorkDef that is never enqueued. Its definition is editable
 * with PUT only while it is pending; `POST /:id/activate` ends pending, after
 * which a PUT that touches the definition is refused (409) — revisions go through
 * the thread plus Run. A Scheduled job's cron lives on its Schedule, not the
 * definition, so a cron-only PUT is still accepted after activating.
 *
 * **Deprecated aliases (one release).** Requests may still say `draft: true`
 * (read as `pending: true`) and `POST /:id/publish` (same as `/activate`), so an
 * older Pi extension keeps working across the rename. Responses only carry
 * `pending`.
 *
 * Every view carries `executionCount` / `lastRunAt`, derived from the WorkItem
 * table (CANCELED excluded) — docs/DESIGN.md "Execution Count: Derived, not Counted".
 *
 * **Feature toggles.** daemon/features.ts gates these routes by the WorkDef's
 * kind (403 when its feature is off) and the list hides those kinds; the thread
 * surface (comments, attachments, token usage) is never gated.
 *
 * **A triage WorkDef is not editable here.** It's an empty container owned by its
 * note (TODO.md "Auto Triage"): its content comes from the triage persona plus the note,
 * its lifecycle follows the note, and a run is started with
 * `POST /api/thoughts/:id/triage`. Editing or deleting it directly would leave a
 * note pointing at something that no longer describes it, so those verbs 409 and
 * name the note instead.
 *
 * **A mirrored (External) WorkDef is read-only here too.** An external source is
 * pull only (docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins"): its defs
 * are written by sync, so PUT and DELETE 409 with "change it in <source>", and a
 * create asking for `type: "External"` is refused. Its thread (comments,
 * attachments), Run, and archive/restore work as for any WorkDef. On a
 * triage-mode mirror Run is **Triage now** (Store.runWorkDef), and its proposals
 * are decided through daemon/routes/triage.ts. Its one editable setting is a
 * person's **persona override**, `PUT /:id/persona` — kept in the source's kv,
 * not the synced file, so re-syncs never touch it (docs/DESIGN.md "Work Source
 * personas").
 */

import * as fs from "node:fs";
import type { RouteContext } from "./types.ts";
import { workDefType, type WorkDef } from "../../shared/types.ts";
import type { WorkDefsResponse, WorkDefResponse, SaveWorkDefRequest, UpdateWorkDefRequest, SaveWorkDefResponse, ActivateWorkDefRequest, ActivateWorkDefResponse, MirrorPersonaRequest } from "../../shared/protocol.ts";
import { isValidCron } from "../cron.ts";
import { estimateTokenCost } from "../token-cost.ts";
import type { WorkDefExecutionStats } from "../store.ts";
import { isWorkDefVisible } from "../features.ts";
import { mirroredReadOnlyError, mirrorView } from "./work-sources.ts";
import { contextFieldRefusal } from "./personas.ts";

/**
 * The API shape of a WorkDef. `stats` is passed in by the list route, which
 * fetches every def's execution stats in one aggregate query; single-def routes
 * omit it and look up just this one.
 */
function view(d: WorkDef, store: RouteContext["store"], stats?: Map<string, WorkDefExecutionStats>) {
  const exec = stats ? (stats.get(d.id) ?? { executionCount: 0, lastRunAt: null }) : store.getExecutionStatsFor(d.id);
  return {
    id: d.id, title: d.title, type: workDefType(d.parent), parent: d.parent,
    goal: d.goal, acceptanceCriteria: d.acceptanceCriteria,
    additionalContext: d.additionalContext, directory: d.directory,
    ...(d.persona ? { persona: d.persona } : {}),
    pending: d.pending === true,
    // Aggregate cost/tokens across this def's runs (recorded on the ref).
    tokenUsage: store.getTokenUsageSummaryForRef({ workDefId: d.id }) || undefined,
    executionCount: exec.executionCount,
    lastRunAt: exec.lastRunAt,
    mirror: mirrorView(store, d),
  };
}

/** A mirrored (External) def is read-only here; this is the refusal, or null for any other def. */
function mirroredRefusal(store: RouteContext["store"], def: WorkDef | null): string | null {
  const mirror = def ? mirrorView(store, def) : undefined;
  return mirror ? mirroredReadOnlyError(mirror.sourceLabel) : null;
}

/** A triage WorkDef is owned by its note; this is the refusal for direct edits. */
function triageOwned(store: RouteContext["store"], id: string): { kind: "thought"; id: string } | null {
  const parent = store.getWorkDef(id)?.parent;
  return parent?.kind === "thought" ? { kind: "thought", id: parent.id } : null;
}

/** Why a PUT to an active WorkDef's definition is refused. */
const ACTIVE_LOCKED_ERROR =
  "This WorkDef is active, so its definition is locked. To revise it, add a comment " +
  "to its thread and Run it again (or create a new pending one).";

/**
 * Does a create request ask for a pending WorkDef? `pending: true`, or the
 * deprecated pre-rename `draft: true` (accepted for one release — see the file
 * header). Shared by every route that creates WorkDefs.
 */
export function requestsPending(body: { pending?: unknown; draft?: unknown } | null | undefined): boolean {
  return body?.pending === true || body?.draft === true;
}

/** The UpdateWorkDefRequest fields that are the authored definition (everything but cron). */
const DEFINITION_FIELDS = ["title", "goal", "acceptanceCriteria", "additionalContext", "directory"] as const;

/**
 * Why a requested `persona` is refused, or null when it's acceptable (absent,
 * `null` to clear, or an id that resolves). Board tasks are refused outright:
 * they get their persona from the workflow state (per-board-task overrides are
 * a non-goal — TODO.md "Personas"). A persona is *how* the work is done, not
 * what it is, so it is not part of the locked definition: it can be changed
 * after activating, like a schedule's cron.
 */
function personaRefusal(store: RouteContext["store"], persona: unknown, def?: WorkDef | null): string | null {
  if (persona === undefined || persona === null || persona === "") return null;
  if (def?.parent?.kind === "story") return "Board tasks get their persona from the workflow state; set it on the state instead.";
  if (typeof persona !== "string") return "Field 'persona' must be a persona id or null";
  return store.getPersona(persona) ? null : `Persona "${persona}" doesn't exist`;
}

const TRIAGE_OWNED_ERROR = (thoughtId: string) =>
  `This is the auto-triage thread for note ${thoughtId}; edit the note instead ` +
  `(and use POST /api/thoughts/${thoughtId}/triage to re-run it).`;

export function registerWorkDefRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/api/work-defs", (c) => {
    const status = c.req.query("status");
    // Default to active-only (unlike thoughts which default to all)
    const filter = status === "archived" ? "archived" : status === "all" ? undefined : "active";
    const stats = store.getExecutionStats();
    // A switched-off kind's WorkDefs are hidden (daemon/features.ts gates the rest).
    const defs = store.getWorkDefs(filter).filter((d) => isWorkDefVisible(store, ctx.config, d));
    return c.json({ workDefs: defs.map((d) => view(d, store, stats)) } satisfies WorkDefsResponse);
  });

  app.get("/api/work-defs/:id", (c) => {
    const def = store.getWorkDef(c.req.param("id"));
    if (!def) return c.json({ success: false, error: "WorkDef not found" } satisfies WorkDefResponse, 404);
    return c.json({ workDef: view(def, store) } satisfies WorkDefResponse);
  });

  app.post("/api/work-defs", async (c) => {
    const body = (await c.req.json()) as SaveWorkDefRequest;
    if (!body.title) return c.json({ success: false, error: "Field 'title' is required" } satisfies SaveWorkDefResponse, 400);
    if (!body.goal) return c.json({ success: false, error: "Field 'goal' is required" } satisfies SaveWorkDefResponse, 400);
    // External work arrives by sync only (pull only): MPT never creates it.
    if ((body.type as string) === "External") {
      return c.json({ success: false, error: "External work is mirrored from its source by sync (pull only); MPT never creates it." } satisfies SaveWorkDefResponse, 409);
    }
    const refused = contextFieldRefusal(body) ?? personaRefusal(store, body.persona);
    if (refused) return c.json({ success: false, error: refused } satisfies SaveWorkDefResponse, 400);
    const scheduled = body.type === "Scheduled";
    let parent;
    if (scheduled) {
      if (!body.cron || !isValidCron(body.cron)) return c.json({ success: false, error: "Scheduled work needs a valid 5-field 'cron'" } satisfies SaveWorkDefResponse, 400);
      // Scheduled work: create a cron Schedule parent, then point the WorkDef at it.
      const sched = store.createSchedule({ title: body.title, cron: body.cron });
      parent = { kind: "schedule" as const, id: sched.id };
    }
    const def = store.createWorkDef({
      title: body.title, parent, goal: body.goal, acceptanceCriteria: body.acceptanceCriteria || "",
      additionalContext: body.additionalContext, directory: body.directory,
      persona: body.persona || undefined,
      pending: requestsPending(body),
    }, body.enqueue !== false && !scheduled);
    return c.json({ success: true, workDef: view(def, store) } satisfies SaveWorkDefResponse, 201);
  });

  app.put("/api/work-defs/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as UpdateWorkDefRequest;
    const existing = store.getWorkDef(id);
    if (!existing) return c.json({ success: false, error: "WorkDef not found" } satisfies SaveWorkDefResponse, 404);
    const owned = triageOwned(store, id);
    if (owned) return c.json({ success: false, error: TRIAGE_OWNED_ERROR(owned.id) } satisfies SaveWorkDefResponse, 409);
    const mirrored = mirroredRefusal(store, existing);
    if (mirrored) return c.json({ success: false, error: mirrored } satisfies SaveWorkDefResponse, 409);
    const refused = contextFieldRefusal(body) ?? personaRefusal(store, body.persona, existing);
    if (refused) return c.json({ success: false, error: refused } satisfies SaveWorkDefResponse, 400);
    // Active ⇒ locked: only a pending WorkDef's definition may change.
    const touchesDefinition = DEFINITION_FIELDS.some((f) => body[f] !== undefined);
    if (touchesDefinition && !existing.pending) {
      return c.json({ success: false, error: ACTIVE_LOCKED_ERROR } satisfies SaveWorkDefResponse, 409);
    }
    if (body.cron !== undefined && body.cron !== null && !isValidCron(body.cron)) return c.json({ success: false, error: "Invalid 'cron' expression" } satisfies SaveWorkDefResponse, 400);
    // A cron edit updates the WorkDef's parent Schedule, not the WorkDef itself.
    if (body.cron && existing.parent?.kind === "schedule") {
      store.updateScheduleDetails(existing.parent.id, { cron: body.cron });
    }
    const def = store.updateWorkDefDetails(id, {
      title: body.title, goal: body.goal, acceptanceCriteria: body.acceptanceCriteria,
      additionalContext: body.additionalContext, directory: body.directory,
      persona: body.persona === "" ? null : body.persona,
    });
    if (!def) return c.json({ success: false, error: "Update failed" } satisfies SaveWorkDefResponse, 400);
    return c.json({ success: true, workDef: view(def, store) } satisfies SaveWorkDefResponse);
  });

  app.delete("/api/work-defs/:id", (c) => {
    const owned = triageOwned(store, c.req.param("id"));
    if (owned) return c.json({ success: false, error: TRIAGE_OWNED_ERROR(owned.id) }, 409);
    // Archived, never deleted: the mirror (and its thread) is how MPT remembers the item.
    const mirrored = mirroredRefusal(store, store.getWorkDef(c.req.param("id")));
    if (mirrored) return c.json({ success: false, error: mirrored }, 409);
    const ok = store.deleteWorkDef(c.req.param("id"));
    if (!ok) return c.json({ success: false, error: "WorkDef not found" }, 404);
    return c.json({ success: true });
  });

  // ── Archive / Restore ─────────────────────────────────────────────

  app.post("/api/work-defs/:id/archive", (c) => {
    const updated = store.archiveWorkDef(c.req.param("id"));
    if (!updated) return c.json({ success: false, error: "WorkDef not found" }, 404);
    return c.json({ success: true, workDef: view(updated, store) });
  });

  app.post("/api/work-defs/:id/restore", (c) => {
    const updated = store.restoreWorkDef(c.req.param("id"));
    if (!updated) return c.json({ success: false, error: "WorkDef not found" }, 404);
    return c.json({ success: true, workDef: view(updated, store) });
  });

  // Activate a pending WorkDef: locks its definition and lets its parent enqueue it
  // (Solitary: now, unless `enqueue: false`; Board: admission; Scheduled: next cron).
  // `/publish` is the deprecated pre-rename alias, kept for one release.
  for (const action of ["activate", "publish"]) {
    app.post(`/api/work-defs/:id/${action}`, async (c) => {
      const id = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) as ActivateWorkDefRequest;
      const res = store.activateWorkDef(id, { enqueue: body.enqueue });
      if (!res) return c.json({ success: false, error: "WorkDef not found" } satisfies ActivateWorkDefResponse, 404);
      if ("error" in res) return c.json({ success: false, error: res.error } satisfies ActivateWorkDefResponse, 409);
      return c.json({ success: true, workDef: view(res.def, store), workItemId: res.workItem?.id ?? null } satisfies ActivateWorkDefResponse);
    });
  }

  // A mirror's persona override (docs/DESIGN.md "Work Source personas"): the one
  // edit a mirror accepts, since it lives in the source's kv, not the synced file.
  app.put("/api/work-defs/:id/persona", async (c) => {
    const body = (await c.req.json().catch(() => null)) as MirrorPersonaRequest | null;
    const persona = body?.persona;
    if (!body || (persona !== null && persona !== "" && typeof persona !== "string")) {
      return c.json({ success: false, error: 'Body must be { "persona": id | null }' }, 400);
    }
    const res = store.setMirrorPersona(c.req.param("id"), persona || null);
    if (!res.ok) return c.json({ success: false, error: res.error }, res.status);
    return c.json({ success: true, workDef: view(store.getWorkDef(c.req.param("id"))!, store) });
  });

  // Enqueue a READY WorkItem for this def (manual trigger / "save then enqueue").
  app.post("/api/work-defs/:id/enqueue", (c) => {
    // The WorkDef's source decides what Run means (Solitary: refuse pending or
    // in-flight, else enqueue; Triage: Triage now, which knows the note's rules).
    const res = store.runWorkDef(c.req.param("id"));
    if (!res.ok) return c.json({ success: false, error: res.error }, res.conflict ? 409 : 400);
    return c.json({ success: true, workItemId: res.workItem.id });
  });

  // Comments live on the WorkDef (per-def run thread).
  app.get("/api/work-defs/:id/comments", (c) => {
    const id = c.req.param("id");
    if (!store.getWorkDef(id)) return c.json({ comments: [] });
    return c.json({ comments: store.getCommentsForRef({ workDefId: id }) });
  });

  app.post("/api/work-defs/:id/comment", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { from?: string; body?: string; attachments?: Array<{ name: string; size: number; type: string }> };
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    if (!body.from || !body.body) return c.json({ success: false, error: "Fields 'from' and 'body' are required" }, 400);
    store.addCommentForRef({ workDefId: id }, body.from, body.body, body.attachments);
    return c.json({ success: true });
  });

  // ── Attachments (on the ref) ─────────────────────────────────────────
  // The canonical attachment routes: they work for ANY WorkDef (board /
  // Solitary / Scheduled). The board-only /api/tasks/:taskId/attachments
  // duplicates were removed in P1a-5 with their last client, mpt-mcp-server.

  const MIME_TYPES: Record<string, string> = {
    diff: "text/x-diff", patch: "text/x-diff", md: "text/markdown",
    txt: "text/plain", json: "application/json",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  };

  app.post("/api/work-defs/:id/attachments", async (c) => {
    const id = c.req.param("id");
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    const body = await c.req.json() as { name?: string; content?: string; encoding?: string };
    if (!body.name || !body.content) return c.json({ success: false, error: "Fields 'name' and 'content' are required" }, 400);

    let data: string | Uint8Array = body.content;
    if (body.encoding === "base64") {
      const bin = atob(body.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      data = bytes;
    }
    const storedName = store.saveAttachmentForRef({ workDefId: id }, body.name, data);
    if (!storedName) return c.json({ success: false, error: "Failed to save attachment" }, 500);
    const ext = body.name.split(".").pop()?.toLowerCase() || "";
    const typeMap: Record<string, string> = { diff: "diff", patch: "diff", md: "markdown", txt: "text", json: "json", png: "image", jpg: "image", jpeg: "image" };
    return c.json({ success: true, storedName, type: typeMap[ext] || "other", size: body.content.length });
  });

  app.get("/api/work-defs/:id/attachments", (c) => {
    const id = c.req.param("id");
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    return c.json({ attachments: store.getAttachmentsForRef({ workDefId: id }) });
  });

  app.get("/api/work-defs/:id/attachments/:filename", (c) => {
    const id = c.req.param("id");
    const filename = c.req.param("filename");
    if (!store.getWorkDef(id)) return c.json({ error: "WorkDef not found", id }, 404);
    const filePath = store.getAttachmentPathForRef({ workDefId: id }, filename);
    if (!filePath) return c.json({ error: "Attachment not found", id, filename }, 404);
    const content = fs.readFileSync(filePath);
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    return new Response(content, { headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" } });
  });

  app.delete("/api/work-defs/:id/attachments/:filename", (c) => {
    const id = c.req.param("id");
    const deleted = store.deleteAttachmentForRef({ workDefId: id }, c.req.param("filename"));
    if (!deleted) return c.json({ success: false, error: "Attachment not found" }, 404);
    return c.json({ success: true });
  });

  // ── Token usage (on the ref) ─────────────────────────────────────────
  app.post("/api/work-defs/:id/token-usage", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { inputTokens?: number; outputTokens?: number; model?: string; costUsd?: number };
    if (typeof body.inputTokens !== "number" || typeof body.outputTokens !== "number" || !body.model) {
      return c.json({ success: false, error: "Fields inputTokens, outputTokens, model required" }, 400);
    }
    if (!store.getWorkDef(id)) return c.json({ success: false, error: "WorkDef not found" }, 404);
    // Prefer the harness-reported cost; estimate only as a fallback.
    const costUsd = typeof body.costUsd === "number" ? body.costUsd : estimateTokenCost(body.model, body.inputTokens, body.outputTokens);
    store.addTokenUsageForRef({ workDefId: id }, body.inputTokens, body.outputTokens, body.model, costUsd);
    return c.json({ success: true, costUsd });
  });
}
