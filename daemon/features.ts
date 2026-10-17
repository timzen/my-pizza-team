/**
 * daemon/features.ts — Feature toggles: the server-side gate and the turn-off guard.
 *
 * A team can switch the Stories, Tasks (Solitary tasks + Templates), and
 * Schedules work-item kinds off in `config.features` (docs/DESIGN.md "Feature
 * Toggles"). This module is the *only* place that enforces it:
 *
 *   - `registerFeatureGates` installs one middleware per kind in front of the
 *     route modules, so a disabled kind's create/view/edit routes answer
 *     **403** `{ success: false, error: "feature 'stories' is disabled", feature }`.
 *     403 rather than 404: the route exists and the item may too — the team
 *     has chosen not to use the kind, and a client (the UI, the Pi tools) must be
 *     able to tell "switched off" from "no such item".
 *   - `resolveFeaturesUpdate` validates a `PUT /api/config` `features` value and
 *     refuses to switch a kind off while it still has active (non-archived) items.
 *
 * Deliberately **not** gated: the WorkItem queue and Inbox (`/api/work-items`),
 * the agent protocol (`/api/agents/*` — claim, complete, comment), and the
 * ref-scoped WorkDef thread surface (comments, attachments, token usage), so
 * existing work and its history keep working whatever the toggles say.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { RouteContext } from "./routes/types.ts";
import type { Store } from "./store.ts";
import {
  FEATURE_NAMES, type FeatureName, type FeaturesConfig, resolveFeatures, type TeamConfig,
  type TriageProposalKind, type WorkDef, workDefType,
} from "../shared/types.ts";

/** The HTTP status of a request to a disabled feature (see the header for why 403). */
export const FEATURE_DISABLED_STATUS = 403;

/** The JSON body of a refused request: the shared envelope plus which feature. */
export function featureDisabledBody(feature: FeatureName): { success: false; error: string; feature: FeatureName } {
  return { success: false, error: `feature '${feature}' is disabled`, feature };
}

/** Is this kind switched on for the team (the live, in-memory config)? */
export function isFeatureEnabled(config: Pick<TeamConfig, "features">, feature: FeatureName): boolean {
  return resolveFeatures(config)[feature];
}

/**
 * The feature that governs a WorkDef: board tasks belong to Stories, Scheduled
 * ones to Schedules, parent-less (Solitary) ones to Tasks. A triage WorkDef
 * belongs to its note — Thoughts are always on — so it has none.
 */
export function featureForWorkDef(def: Pick<WorkDef, "parent">): FeatureName | null {
  switch (workDefType(def.parent)) {
    case "Board": return "stories";
    case "Scheduled": return "schedules";
    case "Solitary": return "tasks";
    default: return null;
  }
}

/** The feature a triage proposal would create work in (story-task → Stories). */
export function featureForProposalKind(kind: TriageProposalKind): FeatureName {
  switch (kind) {
    case "task": return "tasks";
    case "schedule": return "schedules";
    default: return "stories";
  }
}

/** Decides which feature (if any) a request needs; null lets it through. */
type FeatureResolver = (c: Context) => FeatureName | null | Promise<FeatureName | null>;

/**
 * A middleware that refuses the request when the feature it needs is off. Takes a
 * fixed feature, or a resolver for routes whose feature depends on the target
 * (a WorkDef's type, a proposal's kind). The config is read per request, so a
 * Config-page change applies without a restart.
 */
export function requireFeature(config: TeamConfig, feature: FeatureName | FeatureResolver): MiddlewareHandler {
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
 * The feature a `/api/work-defs…` request needs. Create: the body's `type`
 * (Scheduled → Schedules, otherwise Tasks). One WorkDef and its lifecycle
 * actions: the def's own type. The list is filtered in its route instead
 * (`isWorkDefVisible`), and unknown ids fall through to the route's 404.
 */
function workDefFeature(store: Store): FeatureResolver {
  return async (c) => {
    const rest = c.req.path.replace(/^\/api\/work-defs\/?/, "").split("/").filter(Boolean);
    if (rest.length === 0) {
      if (c.req.method !== "POST") return null;
      // Hono caches the parsed body, so the route can read it again.
      const body = await c.req.json().catch(() => ({})) as { type?: unknown };
      return body.type === "Scheduled" ? "schedules" : "tasks";
    }
    if (rest.length > 1 && UNGATED_WORKDEF_ACTIONS.has(rest[1]!)) return null;
    const def = store.getWorkDef(decodeURIComponent(rest[0]!));
    return def ? featureForWorkDef(def) : null;
  };
}

/** Accepting a triage proposal creates work, so it needs that kind to be on. */
function proposalFeature(store: Store): FeatureResolver {
  return (c) => {
    const thoughtId = c.req.param("id");
    const proposalId = c.req.param("proposalId");
    if (!thoughtId || !proposalId || !store.getThought(thoughtId)) return null;
    const state = [...store.getTriageThread(thoughtId).proposals].reverse().find((s) => s.proposal.id === proposalId);
    return state ? featureForProposalKind(state.proposal.kind) : null;
  };
}

/** Should a WorkDef appear in `GET /api/work-defs`? Not when its kind is off. */
export function isWorkDefVisible(config: TeamConfig, def: Pick<WorkDef, "parent">): boolean {
  const feature = featureForWorkDef(def);
  return feature === null || isFeatureEnabled(config, feature);
}

/**
 * Install every feature gate. Must run before the route modules register, so the
 * middleware sits in front of their handlers (Hono runs matches in order).
 */
export function registerFeatureGates(ctx: RouteContext): void {
  const { app, store, config } = ctx;
  const gate = (paths: string[], feature: FeatureName | FeatureResolver) => {
    const mw = requireFeature(config, feature);
    for (const p of paths) app.use(p, mw);
  };
  // Stories and their board tasks (create-in-story, reorder, move, delete),
  // the backlog and the archive.
  gate(["/api/stories", "/api/stories/*", "/api/tasks/*", "/api/archived", "/api/backlog", "/api/backlog/*"], "stories");
  // Templates are molds for Solitary tasks, so the Tasks toggle owns them.
  gate(["/api/templates", "/api/templates/*"], "tasks");
  gate(["/api/schedules", "/api/schedules/*"], "schedules");
  gate(["/api/work-defs", "/api/work-defs/*"], workDefFeature(store));
  gate(["/api/thoughts/:id/proposals/:proposalId/accept"], proposalFeature(store));
}

// ─── Turning a feature off ──────────────────────────────────────────

/** What still holds a feature on: the active item count, worded for the user. */
export interface ActiveFeatureItems {
  count: number;
  /** e.g. "3 stories", "2 tasks and 1 template". */
  description: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Active (non-archived) items of one kind. Archived items never block turning a
 * kind off; backlogged stories do (they aren't archived, just shelved), and
 * drafts do (they're work in progress).
 */
export function activeFeatureItems(store: Store, feature: FeatureName): ActiveFeatureItems {
  if (feature === "stories") {
    const count = store.getStories().length + store.getBacklogStories().length;
    return { count, description: plural(count, "story", "stories") };
  }
  const defs = store.getWorkDefs("active").filter((d) => featureForWorkDef(d) === feature);
  if (feature === "schedules") {
    return { count: defs.length, description: plural(defs.length, "scheduled task", "scheduled tasks") };
  }
  const templates = store.getTemplates().length;
  const parts = [
    ...(defs.length > 0 || templates === 0 ? [plural(defs.length, "task", "tasks")] : []),
    ...(templates > 0 ? [plural(templates, "template", "templates")] : []),
  ];
  return { count: defs.length + templates, description: parts.join(" and ") };
}

/**
 * Every kind's active items (`activeFeatureItems`), for `GET /api/config`: the
 * Config page uses it to pre-disable a toggle that the turn-off guard would refuse.
 */
export function featureUsage(store: Store): Record<FeatureName, ActiveFeatureItems> {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, activeFeatureItems(store, name)])) as Record<FeatureName, ActiveFeatureItems>;
}

/**
 * The `features` a `PUT /api/config` would leave in place, or why it's refused.
 *
 * Absent keeps the current value; `null` clears the block (everything on). An
 * object is a partial update over the resolved current toggles and is stored in
 * full, so config.json says exactly what's on. Switching a kind **off** is refused
 * (409) while it still has active items — hiding live work would strand it.
 * Leaving an already-off kind off is never refused, whatever is on disk.
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
  const input = body.features as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    if (!(FEATURE_NAMES as readonly string[]).includes(key)) {
      return { error: `Unknown feature "${key}" (known: ${FEATURE_NAMES.join(", ")})`, status: 400 };
    }
    if (value !== undefined && typeof value !== "boolean") return { error: `features.${key} must be a boolean`, status: 400 };
  }
  const current = resolveFeatures(config);
  const next = { ...current };
  for (const name of FEATURE_NAMES) {
    if (typeof input[name] === "boolean") next[name] = input[name] as boolean;
  }
  for (const name of FEATURE_NAMES) {
    if (!current[name] || next[name]) continue;
    const active = activeFeatureItems(store, name);
    if (active.count > 0) {
      return { error: `Can't turn off ${name}: archive or delete ${active.description} first`, status: 409 };
    }
  }
  return { features: next };
}
