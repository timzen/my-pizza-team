/**
 * daemon/features.ts — Feature toggles: the server-side gate and the turn-off guard.
 *
 * A team can switch work-item kinds off in `config.features` (docs/DESIGN.md
 * "Feature Toggles"). The switchable kinds are the registered Work Sources that
 * declare a `toggle` (daemon/sources/types.ts `SourceToggle`) — the built-ins
 * Stories (story), Tasks (task: Solitary tasks + Templates), and Schedules
 * (schedule); Thought declares none, so it's always on. An external (plugin)
 * source gets one by default — `features.<its id>` (daemon/sources/registry.ts
 * `effectiveToggle`) — unless it opts out with `toggle: null`. This module is the *only* place that
 * enforces it, and it never names a kind — everything comes from the registry:
 *
 *   - `registerFeatureGates` installs one middleware per toggleable source in front of the
 *     route modules, so a disabled kind's create/view/edit routes answer
 *     **403** `{ success: false, error: "feature 'stories' is disabled", feature }`.
 *     403 rather than 404: the route exists and the item may too — the team
 *     has chosen not to use the kind, and a client (the UI, the Pi tools) must be
 *     able to tell "switched off" from "no such item".
 *   - `resolveFeaturesUpdate` validates a `PUT /api/config` `features` value and
 *     refuses to switch a kind off while it still has active (non-archived) items.
 *   - `disconnectSource` is the one exception, for external sources only
 *     (`POST /api/work-sources/:id/disconnect`): switch it off *and* archive its
 *     mirrors, as one explicit step.
 *
 * Deliberately **not** gated: the WorkItem queue and Inbox (`/api/work-items`),
 * the agent protocol (`/api/agents/*` — claim, complete, comment), and the
 * ref-scoped WorkDef thread surface (comments, attachments, token usage), so
 * existing work and its history keep working whatever the toggles say.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { RouteContext } from "./routes/types.ts";
import type { Store } from "./store.ts";
import { FEATURE_NAMES, type FeatureName, type FeaturesConfig, type TeamConfig, type TriageProposalKind, type WorkDef } from "../shared/types.ts";
import type { SourceEntry } from "./sources/registry.ts";
import { TASK_SOURCE_ID } from "./sources/registry.ts";
import { SCHEDULE_SOURCE_ID } from "./sources/schedule.ts";
import { STORY_SOURCE_ID } from "./sources/story.ts";
import { activeWorkDefs } from "./sources/toggle.ts";
import type { ActiveSourceItems, SourceToggle } from "./sources/types.ts";
import type { FeatureSourceView } from "../shared/protocol.ts";

/** The HTTP status of a request to a disabled feature (see the header for why 403). */
export const FEATURE_DISABLED_STATUS = 403;

/** The JSON body of a refused request: the shared envelope plus which feature. */
export function featureDisabledBody<F extends string = FeatureName>(feature: F): { success: false; error: string; feature: F } {
  return { success: false, error: `feature '${feature}' is disabled`, feature };
}

/**
 * Is this feature switched on (the live, in-memory config)? A missing block or
 * flag means on, for a built-in or a plugin's feature alike (see `resolveFeatures`).
 */
export function isFeatureEnabled(config: Pick<TeamConfig, "features">, feature: string): boolean {
  return (config.features as Record<string, boolean | undefined> | undefined)?.[feature] !== false;
}

// ─── The registry's view ────────────────────────────────────────────

/** A registered source that can be switched off, with its toggle. */
interface ToggleableSource {
  entry: SourceEntry;
  toggle: SourceToggle;
}

/**
 * Every toggleable source, the built-in features first in their display order
 * (`FEATURE_NAMES`: stories, tasks, schedules), then the rest in registration
 * order — so messages and payloads read as they always have.
 */
function toggleableSources(store: Store): ToggleableSource[] {
  const out = store.listWorkSources()
    .filter((entry) => entry.toggle)
    .map((entry) => ({ entry, toggle: entry.toggle! }));
  const rank = (t: ToggleableSource) => {
    const i = (FEATURE_NAMES as readonly string[]).indexOf(t.toggle.feature);
    return i === -1 ? FEATURE_NAMES.length : i;
  };
  return out.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(({ t }) => t);
}

/** The toggleable features' names, in display order (what `PUT /api/config` accepts). */
export function featureNames(store: Store): string[] {
  return toggleableSources(store).map((t) => t.toggle.feature);
}

/**
 * Every toggleable feature with defaults applied, for `/api/status` and
 * `GET /api/config`. For the built-ins this is exactly `resolveFeatures`.
 */
export function enabledFeatures(store: Store, config: Pick<TeamConfig, "features">): Record<string, boolean> {
  return Object.fromEntries(featureNames(store).map((name) => [name, isFeatureEnabled(config, name)]));
}

/** The feature of a registered source, by id (null: none registered, or not toggleable). */
function featureForSource(store: Store, sourceId: string): string | null {
  return store.listWorkSources().find((e) => e.source.id === sourceId)?.toggle?.feature ?? null;
}

/**
 * The feature that governs a WorkDef: its source's toggle (board tasks →
 * Stories, Scheduled → Schedules, Solitary → Tasks). A triage WorkDef belongs to
 * its note — Thought declares no toggle — so it has none.
 */
export function featureForWorkDef(store: Store, def: Pick<WorkDef, "parent">): string | null {
  return store.getWorkSourceFor(def)?.toggle?.feature ?? null;
}

/** The source a triage proposal would create work in (story-task → Story). */
function sourceForProposalKind(kind: TriageProposalKind): string {
  switch (kind) {
    case "task": return TASK_SOURCE_ID;
    case "schedule": return SCHEDULE_SOURCE_ID;
    default: return STORY_SOURCE_ID;
  }
}

/**
 * The built-in feature a triage proposal would create work in (story-task →
 * Stories). Pure, so the UI and Pi mirrors can be checked against it; the gate
 * itself resolves through the registry (`proposalFeature`).
 */
export function featureForProposalKind(kind: TriageProposalKind): FeatureName {
  switch (kind) {
    case "task": return "tasks";
    case "schedule": return "schedules";
    default: return "stories";
  }
}

/** Decides which feature (if any) a request needs; null lets it through. */
type FeatureResolver = (c: Context) => string | null | Promise<string | null>;

/**
 * A middleware that refuses the request when the feature it needs is off. Takes a
 * fixed feature, or a resolver for routes whose feature depends on the target
 * (a WorkDef's source, a proposal's kind). The config is read per request, so a
 * Config-page change applies without a restart.
 */
export function requireFeature(config: TeamConfig, feature: string | FeatureResolver): MiddlewareHandler {
  return async (c, next) => {
    const needed = typeof feature === "string" ? feature : await feature(c);
    if (needed && !isFeatureEnabled(config, needed)) {
      return c.json(featureDisabledBody(needed), FEATURE_DISABLED_STATUS);
    }
    await next();
  };
}

/**
 * `/api/work-defs/:id/<action>` sub-routes that stay open whatever the toggles:
 * the ref-scoped thread surface the Inbox, viewers and agents use on existing work.
 */
const UNGATED_WORKDEF_ACTIONS = new Set(["comments", "comment", "attachments", "token-usage"]);

/**
 * The feature a `/api/work-defs…` request needs. Create: the source the body's
 * `type` makes (Scheduled → schedule, otherwise task). One WorkDef and its
 * lifecycle actions: its source's. The list is filtered in its route instead
 * (`isWorkDefVisible`), and unknown ids fall through to the route's 404.
 */
function workDefFeature(store: Store): FeatureResolver {
  return async (c) => {
    const rest = c.req.path.replace(/^\/api\/work-defs\/?/, "").split("/").filter(Boolean);
    if (rest.length === 0) {
      if (c.req.method !== "POST") return null;
      // Hono caches the parsed body, so the route can read it again.
      const body = await c.req.json().catch(() => ({})) as { type?: unknown };
      return featureForSource(store, body.type === "Scheduled" ? SCHEDULE_SOURCE_ID : TASK_SOURCE_ID);
    }
    if (rest.length > 1 && UNGATED_WORKDEF_ACTIONS.has(rest[1]!)) return null;
    const def = store.getWorkDef(decodeURIComponent(rest[0]!));
    return def ? featureForWorkDef(store, def) : null;
  };
}

/**
 * Accepting a triage proposal creates work, so it needs that kind's source to be
 * on. `by` says what the route's `:id` names: a note, or a triage subject's
 * WorkDef (`/api/work-defs/:id/triage/…` — a triage-mode mirror, say).
 */
function proposalFeature(store: Store, by: "thought" | "workDef"): FeatureResolver {
  return (c) => {
    const id = c.req.param("id");
    const proposalId = c.req.param("proposalId");
    if (!id || !proposalId) return null;
    if (by === "thought" && !store.getThought(id)) return null;
    const thread = by === "thought" ? store.getTriageThread(id) : store.getTriageThreadForWorkDef(id);
    const state = [...thread.proposals].reverse().find((s) => s.proposal.id === proposalId);
    return state ? featureForSource(store, sourceForProposalKind(state.proposal.kind)) : null;
  };
}

/** Should a WorkDef appear in `GET /api/work-defs`? Not when its source is off. */
export function isWorkDefVisible(store: Store, config: TeamConfig, def: Pick<WorkDef, "parent">): boolean {
  const feature = featureForWorkDef(store, def);
  return feature === null || isFeatureEnabled(config, feature);
}

/**
 * Install every feature gate: each toggleable source's own `routes`, the
 * generic WorkDef routes (by the def's source), and proposal acceptance. Must
 * run before the route modules register, so the middleware sits in front of
 * their handlers (Hono runs matches in order). Sources registered after this
 * still get the WorkDef and proposal gates (resolved per request), but not
 * their `routes`.
 */
export function registerFeatureGates(ctx: RouteContext): void {
  const { app, store, config } = ctx;
  const gate = (paths: readonly string[], feature: string | FeatureResolver) => {
    const mw = requireFeature(config, feature);
    for (const p of paths) app.use(p, mw);
  };
  for (const { toggle } of toggleableSources(store)) {
    if (toggle.routes?.length) gate(toggle.routes, toggle.feature);
  }
  gate(["/api/work-defs", "/api/work-defs/*"], workDefFeature(store));
  gate(["/api/thoughts/:id/proposals/:proposalId/accept"], proposalFeature(store, "thought"));
  gate(["/api/work-defs/:id/triage/proposals/:proposalId/accept"], proposalFeature(store, "workDef"));
}

// ─── Turning a feature off ──────────────────────────────────────────

/** What still holds a feature on: the active item count, worded for the user. */
export type ActiveFeatureItems = ActiveSourceItems;

/**
 * Active (non-archived) items of one feature, from its source's `activeItems`
 * (default: the source's non-archived WorkDefs). Archived items never block
 * turning a kind off; pending ones do (work in progress, just held). An
 * unknown feature has none.
 */
export function activeFeatureItems(store: Store, feature: string): ActiveFeatureItems {
  const t = toggleableSources(store).find((s) => s.toggle.feature === feature);
  if (!t) return { count: 0, description: "0 items" };
  return t.toggle.activeItems ? t.toggle.activeItems(t.entry.ctx) : activeWorkDefs(t.entry.ctx);
}

/**
 * Every toggleable feature's active items (`activeFeatureItems`), for `GET
 * /api/config`: the Config page uses it to pre-disable a toggle that the
 * turn-off guard would refuse.
 */
export function featureUsage(store: Store): Record<string, ActiveFeatureItems> {
  return Object.fromEntries(featureNames(store).map((name) => [name, activeFeatureItems(store, name)]));
}

/**
 * Every toggleable feature with what the Config page shows for it, in display
 * order (`GET /api/config` `featureSources`): its source, the source's label,
 * and whether it's external (can be disconnected). The built-ins carry their
 * own labels in the UI.
 */
export function featureSources(store: Store): FeatureSourceView[] {
  return toggleableSources(store).map(({ entry, toggle }) => ({
    feature: toggle.feature,
    sourceId: entry.source.id,
    label: entry.source.label ?? entry.source.id,
    external: typeof entry.source.sync === "function",
  }));
}

/**
 * The `features` a `PUT /api/config` would leave in place, or why it's refused.
 *
 * Absent keeps the current value; `null` clears the block (everything on). An
 * object is a partial update over the resolved current toggles and is stored in
 * full, so config.json says exactly what's on (a flag for a source that isn't
 * registered right now is kept as it was). Switching a feature **off** is
 * refused (409) while its source still has active items — hiding live work
 * would strand it. Leaving an already-off feature off is never refused,
 * whatever is on disk.
 */
export function resolveFeaturesUpdate(
  config: TeamConfig,
  body: { features?: unknown },
  store: Store,
): { features: FeaturesConfig | undefined } | { error: string; status: 400 | 409 } {
  if (body.features === undefined) return { features: config.features };
  if (body.features === null) return { features: undefined };
  if (typeof body.features !== "object" || Array.isArray(body.features)) {
    return { error: "features must be an object, e.g. { \"stories\": true, \"tasks\": true, \"schedules\": false }", status: 400 };
  }
  const names = featureNames(store);
  const input = body.features as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    if (!names.includes(key)) {
      return { error: `Unknown feature "${key}" (known: ${names.join(", ")})`, status: 400 };
    }
    if (value !== undefined && typeof value !== "boolean") return { error: `features.${key} must be a boolean`, status: 400 };
  }
  const current = enabledFeatures(store, config);
  const next: Record<string, boolean> = { ...(config.features as Record<string, boolean> | undefined), ...current };
  for (const name of names) {
    if (typeof input[name] === "boolean") next[name] = input[name] as boolean;
  }
  for (const name of names) {
    if (!current[name] || next[name]) continue;
    const active = activeFeatureItems(store, name);
    if (active.count > 0) {
      // An external source's mirrors can't be archived by hand one by one (sync
      // owns them), so name the explicit opt-in that archives them for you.
      const t = toggleableSources(store).find((x) => x.toggle.feature === name)!;
      const hint = typeof t.entry.source.sync === "function"
        ? ` (or disconnect it: POST /api/work-sources/${t.entry.source.id}/disconnect switches it off and archives them)`
        : "";
      return { error: `Can't turn off ${name}: archive or delete ${active.description} first${hint}`, status: 409 };
    }
  }
  return { features: next as FeaturesConfig };
}

// ─── Disconnecting an external source ───────────────────────────────

/** What a disconnect did: the feature switched off and the mirrors it archived. */
export interface DisconnectResult {
  feature: string;
  archived: string[];
}

/**
 * Switch an external source off **and** archive its mirrors — the explicit
 * opt-in past the 409 turn-off guard (docs/DESIGN.md "Feature Toggles":
 * disconnecting). The order matters: the feature goes off first (in the live
 * config), so a sync already in flight drops its result instead of
 * re-mirroring, then every non-archived mirror is archived — never deleted —
 * and its READY item canceled; an IN_PROGRESS one finishes
 * (`Store.archiveExternalMirrors`). `features` is stored in full, as a PUT
 * would. The caller saves the config. Idempotent: disconnecting an
 * already-off source archives whatever is left and keeps it off.
 *
 * Only external sources: the built-ins' guard is unchanged (their items are
 * yours to archive or delete), and a source that opted out of its toggle
 * (`toggle: null`) can't be switched off at all.
 */
export function disconnectSource(
  config: TeamConfig, store: Store, sourceId: string,
): DisconnectResult | { error: string; status: 400 | 404 } {
  const entry = store.listExternalSources().find((e) => e.source.id === sourceId);
  if (!entry) return { error: `No external source "${sourceId}"`, status: 404 };
  if (!entry.toggle) return { error: `Source "${sourceId}" can't be switched off (it declares toggle: null)`, status: 400 };
  const feature = entry.toggle.feature;
  config.features = {
    ...(config.features as Record<string, boolean> | undefined),
    ...enabledFeatures(store, config),
    [feature]: false,
  } as FeaturesConfig;
  const archived = store.archiveExternalMirrors(sourceId);
  return { feature, archived };
}
