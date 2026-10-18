/**
 * lib/work-items.ts — The Work surface: its sub-tabs (Board · Tasks ·
 * Schedule · Pending · Archived), which of them a team's feature toggles show,
 * where `/work-items` lands, where the pre-Work-Items URLs now live, and the
 * "active only" rule the Schedule tab lists by (standalone tasks use
 * lib/pending.ts `filterByPending`).
 *
 * One top-nav item ("Work") replaced the separate Board, Tasks, and
 * Schedule links; each became a route-driven sub-tab (`/work-items/<tab>`).
 * Board, Tasks, and Schedule show **active** work only — pending and archived
 * work of every kind lives on the Pending and Archived tabs (docs/DESIGN.md
 * "Pending: Write, Review, Activate").
 *
 * **External sources** (docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins")
 * get one generic, read-only tab each — `/work-items/source/<id>`, labelled by
 * the source — between Schedule and Pending, and none at all when no external
 * source is registered (`/api/status` `externalSources`). They aren't feature
 * toggles: a registered source's tab always shows.
 *
 * Kept pure (no React) so the rules are unit-tested (tests/work-items-ui.test.ts,
 * tests/external-sources-ui.test.ts).
 */

import type { FeatureName, Features } from "./features.ts";

/** One Work sub-tab. */
export type WorkItemsTab = "board" | "tasks" | "schedule" | "pending" | "archived";

/** The surface's base route; each tab lives at `${WORK_ITEMS_ROOT}/<tab>`. */
export const WORK_ITEMS_ROOT = "/work-items";

/** A sub-tab's route, label, and the work-item kinds it shows. */
export interface WorkItemsTabDef {
  tab: WorkItemsTab;
  path: string;
  label: string;
  /**
   * Shown while **any** of these kinds is on. Board/Tasks/Schedule each belong
   * to one kind; Pending and Archived mix all three, so they stay while any is on.
   */
  features: readonly FeatureName[];
}

const ALL_KINDS: readonly FeatureName[] = ["stories", "tasks", "schedules"];

/** Every Work sub-tab, in display order. */
export const WORK_ITEMS_TABS: readonly WorkItemsTabDef[] = [
  { tab: "board", path: `${WORK_ITEMS_ROOT}/board`, label: "Board", features: ["stories"] },
  { tab: "tasks", path: `${WORK_ITEMS_ROOT}/tasks`, label: "Tasks", features: ["tasks"] },
  { tab: "schedule", path: `${WORK_ITEMS_ROOT}/schedule`, label: "Schedule", features: ["schedules"] },
  { tab: "pending", path: `${WORK_ITEMS_ROOT}/pending`, label: "Pending", features: ALL_KINDS },
  { tab: "archived", path: `${WORK_ITEMS_ROOT}/archived`, label: "Archived", features: ALL_KINDS },
];

/** A registered external (pull-only) Work Source, as `/api/status` reports it. */
export interface ExternalSourceInfo {
  id: string;
  label: string;
}

/** The path segment under the root for external-source tabs (`/work-items/source/<id>`). */
const SOURCE_SEGMENT = "source";

/** An external source's tab route. */
export function externalSourcePath(sourceId: string): string {
  return `${WORK_ITEMS_ROOT}/${SOURCE_SEGMENT}/${encodeURIComponent(sourceId)}`;
}

/** The external source a `/work-items/source/<id>` route shows, or null for any other route. */
export function externalSourceIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "work-items" || segments[1] !== SOURCE_SEGMENT || segments.length !== 3) return null;
  try {
    return decodeURIComponent(segments[2]!);
  } catch {
    return null;
  }
}

/** One rendered Work tab: a kind/lifecycle tab or an external source's. */
export interface WorkItemsTabLink {
  /** Unique key: the tab name, or `source:<id>`. */
  key: string;
  path: string;
  label: string;
  /** Does this tab own `pathname`? */
  isActive(pathname: string): boolean;
}

/**
 * Every tab to render, in order: the visible kind tabs (Board · Tasks ·
 * Schedule), one per external source, then Pending · Archived. With no
 * external sources this is exactly `visibleWorkItemsTabs`. Nothing until the
 * toggles load, so no tab flashes in.
 */
export function workItemsTabLinks(features: Features | null, sources: readonly ExternalSourceInfo[] | null = null): WorkItemsTabLink[] {
  if (!features) return [];
  const toLink = (t: WorkItemsTabDef): WorkItemsTabLink => ({
    key: t.tab, path: t.path, label: t.label, isActive: (p) => workItemsTabFromPath(p) === t.tab,
  });
  const visible = visibleWorkItemsTabs(features);
  const lifecycle = (t: WorkItemsTabDef) => t.tab === "pending" || t.tab === "archived";
  const external = (sources ?? []).map((s): WorkItemsTabLink => ({
    key: `source:${s.id}`, path: externalSourcePath(s.id), label: s.label, isActive: (p) => externalSourceIdFromPath(p) === s.id,
  }));
  return [...visible.filter((t) => !lifecycle(t)).map(toLink), ...external, ...visible.filter(lifecycle).map(toLink)];
}

/** The route of one sub-tab (e.g. `workItemsPath("board")` → `/work-items/board`). */
export function workItemsPath(tab: WorkItemsTab): string {
  return `${WORK_ITEMS_ROOT}/${tab}`;
}

/**
 * The tabs to show for the team's toggles. Until the toggles load (`null`)
 * nothing is shown, so a switched-off kind never flashes in (lib/features.ts
 * `filterByFeatures` follows the same rule). With all three kinds off, no tab
 * is shown — and the NavBar hides the "Work" item.
 */
export function visibleWorkItemsTabs(features: Features | null): WorkItemsTabDef[] {
  if (!features) return [];
  return WORK_ITEMS_TABS.filter((t) => t.features.some((f) => features[f]));
}

/**
 * Is any Work kind switched on, or an external source registered?
 * (Whether the NavBar shows "Work".)
 */
export function hasAnyWorkItemsFeature(features: Features | null, sources: readonly ExternalSourceInfo[] | null = null): boolean {
  return workItemsTabLinks(features, sources).length > 0;
}

/**
 * Where `/work-items` lands: the first tab shown, or null while the toggles are
 * loading or when every kind is off and no external source is registered.
 */
export function defaultWorkItemsPath(features: Features | null, sources: readonly ExternalSourceInfo[] | null = null): string | null {
  return workItemsTabLinks(features, sources)[0]?.path ?? null;
}

/** The sub-tab a `/work-items/<tab>` route shows, or null for any other route. */
export function workItemsTabFromPath(pathname: string): WorkItemsTab | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "work-items" || segments.length !== 2) return null;
  return WORK_ITEMS_TABS.find((t) => t.tab === segments[1])?.tab ?? null;
}

/**
 * Where a pre-Work-Items URL now lives: `/board`, `/tasks`, `/schedule`,
 * `/pending`, `/backlog` (the Pending tab's old name), and `/archived` map to
 * their sub-tab. Templates are hidden from the UI (being deprecated), so
 * `/templates` and `/templates/:id` go to the Tasks tab. Null for any other
 * path. App.tsx redirects these with `replace`, so old bookmarks keep working
 * without leaving a dead history entry.
 */
export function legacyWorkItemsPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const [first] = segments;
  if (first === "templates" && segments.length <= 2) return workItemsPath("tasks");
  if (segments.length !== 1) return null;
  switch (first) {
    case "board": return workItemsPath("board");
    case "tasks": return workItemsPath("tasks");
    case "schedule": return workItemsPath("schedule");
    case "pending":
    case "backlog": return workItemsPath("pending");
    case "archived": return workItemsPath("archived");
    default: return null;
  }
}

/**
 * Is this scheduled job active? Only when both its definition and its Schedule
 * are: a pending definition (one-way) or a pending Schedule (reversible) both
 * stop it firing, and either puts it on the Pending tab (docs/DESIGN.md
 * "Pending schedules: reversible, no catch-up").
 */
export function isActiveScheduledJob(def: { pending?: boolean }, schedule: { pending?: boolean } | undefined): boolean {
  return def.pending !== true && schedule?.pending !== true;
}
