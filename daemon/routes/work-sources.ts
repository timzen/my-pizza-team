/**
 * daemon/routes/work-sources.ts — External (pull-only) Work Sources: the
 * generic read-only view of what each one mirrors.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" (external sources).
 *
 *   GET  /api/work-sources            — the registered external sources ({ id, label }), and
 *                                       `plugins`: each plugin package's load status
 *                                       (daemon/plugins/loader.ts)
 *   GET  /api/work-sources/:id/defs   — its mirrored defs: title, external link,
 *                                       last revision, latest WorkItem state, run count,
 *                                       mode ("triage" for a triage-mode item) and,
 *                                       for those, `triageBadge` (the latest analysis's badge)
 *   POST /api/work-sources/:id/sync   — sync it now (ignores a failure backoff;
 *                                       409 `skipped: "disabled"` while it's off)
 *   POST /api/work-sources/:id/disconnect — switch it off *and* archive its mirrors
 *                                       (daemon/features.ts `disconnectSource`)
 *
 * A mirrored def's detail and thread are the ordinary `/api/work-defs/:id`
 * routes (edit/delete refused there). Feature-gated: an external source gets a
 * toggle by default (`features.<id>`; daemon/sources/registry.ts
 * `defaultExternalToggle`), which 403s `/defs` and `/sync` while it's off. The
 * list and `disconnect` stay open, so the UI can still name it and finish a
 * disconnect.
 */

import type { RouteContext } from "./types.ts";
import type { WorkDef } from "../../shared/types.ts";
import type { DisconnectSourceResponse, ExternalSourceView, MirroredDefRow, MirroredDefsResponse, MirrorView, WorkSourcesResponse } from "../../shared/protocol.ts";
import type { Store } from "../store.ts";
import { sourceIdForWorkDef } from "../sources/registry.ts";
import { disconnectSource } from "../features.ts";

/** A source's display name: its `label`, else its id (also for one no longer registered). */
export function sourceLabel(store: Store, sourceId: string): string {
  return store.listExternalSources().find((e) => e.source.id === sourceId)?.source.label ?? sourceId;
}

/** The registered external sources, for `/api/status` and the UI's tabs. */
export function externalSourceViews(store: Store): ExternalSourceView[] {
  return store.listExternalSources().map(({ source, toggle }) => ({
    id: source.id, label: source.label ?? source.id, ...(toggle ? { feature: toggle.feature } : {}),
  }));
}

/** A mirrored def's provenance (WorkDefView.mirror), or undefined for any other def. */
export function mirrorView(store: Store, def: WorkDef): MirrorView | undefined {
  if (def.parent?.kind !== "external") return undefined;
  const sourceId = sourceIdForWorkDef(def);
  const { revision, vanished, mode, personaOverride } = store.getMirrorState(def);
  return {
    sourceId, sourceLabel: sourceLabel(store, sourceId), externalId: def.parent.id, url: def.url, revision, vanished, mode,
    ...(personaOverride ? { personaOverride } : {}),
  };
}

/**
 * Why MPT refuses to edit/delete/create a mirrored def: it's pull only, so the
 * change belongs in the external system (and the next sync brings it here).
 */
export function mirroredReadOnlyError(label: string): string {
  return `This WorkDef is mirrored from ${label}, which is pull only: MPT never edits, deletes, or creates it. ` +
    `Change it in ${label} and the next sync updates it here. Comments and attachments on its thread still work.`;
}

export function registerWorkSourceRoutes(ctx: RouteContext): void {
  const { app, store, config } = ctx;

  app.get("/api/work-sources", (c) => c.json({ sources: externalSourceViews(store), plugins: store.getPluginStatuses() } satisfies WorkSourcesResponse));

  app.get("/api/work-sources/:id/defs", (c) => {
    const id = c.req.param("id");
    const source = externalSourceViews(store).find((s) => s.id === id);
    if (!source) return c.json({ success: false, error: `No external source "${id}"` }, 404);
    const status = c.req.query("status");
    const stats = store.getExecutionStats();
    const defs: MirroredDefRow[] = store.getWorkDefs(status === "all" ? undefined : status === "archived" ? "archived" : "active")
      .filter((d) => d.parent?.kind === "external" && sourceIdForWorkDef(d) === id)
      .map((d) => {
        const exec = stats.get(d.id) ?? { executionCount: 0, lastRunAt: null };
        const mirror = store.getMirrorState(d);
        return {
          id: d.id, title: d.title, externalId: d.parent!.id, url: d.url,
          revision: mirror.revision, mode: mirror.mode,
          status: d.status === "archived" ? "archived" : "active",
          latestState: store.getLatestWorkItemState(d.id),
          runCount: exec.executionCount, lastRunAt: exec.lastRunAt,
          ...(mirror.mode === "triage" ? { triageBadge: store.getTriageThreadForWorkDef(d.id).badge } : {}),
        };
      });
    return c.json({ source, defs } satisfies MirroredDefsResponse);
  });

  app.post("/api/work-sources/:id/sync", async (c) => {
    const id = c.req.param("id");
    if (!externalSourceViews(store).some((s) => s.id === id)) return c.json({ success: false, error: `No external source "${id}"` }, 404);
    const outcome = await store.syncWorkSource(id, { force: true });
    return c.json({ success: outcome.ok, ...outcome }, outcome.ok ? 200 : outcome.skipped ? 409 : 502);
  });

  // Disconnect: the explicit opt-in past the turn-off guard's 409 — switch the
  // source off, archive (never delete) its mirrors, cancel their READY items;
  // in-flight ones finish. Saved to config.json like a Config-page save.
  app.post("/api/work-sources/:id/disconnect", (c) => {
    const result = disconnectSource(config, store, c.req.param("id"));
    if ("error" in result) return c.json({ success: false, error: result.error } satisfies DisconnectSourceResponse, result.status);
    store.saveConfig();
    return c.json({ success: true, ...result } satisfies DisconnectSourceResponse);
  });
}
