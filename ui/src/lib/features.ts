/**
 * lib/features.ts — The team's feature toggles (Stories, Tasks, Schedules) as the
 * UI sees them, and which UI surfaces each one governs.
 *
 * The daemon is the authority (daemon/features.ts refuses a disabled kind's
 * routes with 403); the UI only hides what would be refused, so the nav, quick
 * create, and triage don't offer dead ends (docs/DESIGN.md "Feature Toggles").
 * Kept pure (no React) so the mapping is unit-tested (tests/features-ui.test.ts);
 * hooks/useFeatures.ts supplies the live toggles from `/api/status`.
 *
 * The wire types are hand-mirrored from shared/types.ts (`FeaturesConfig`,
 * `FEATURE_NAMES`, `resolveFeatures`), as lib/triage.ts does.
 */

/** One switchable work-item kind (shared/types.ts `FeatureName`). */
export type FeatureName = "stories" | "tasks" | "schedules";

/** Resolved toggles: every kind present (shared/types.ts `Required<FeaturesConfig>`). */
export type Features = Record<FeatureName, boolean>;

/** Every switchable kind, in display order (shared/types.ts `FEATURE_NAMES`). */
export const FEATURE_NAMES: readonly FeatureName[] = ["stories", "tasks", "schedules"];

/** How each kind is named in the UI (Config toggles, "turned off" notices). */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  stories: "Stories",
  tasks: "Tasks",
  schedules: "Schedules",
};

/** What each toggle covers, for the Config page. */
export const FEATURE_DESCRIPTIONS: Record<FeatureName, string> = {
  stories: "Multi-step stories on Work Items → Board, and their Workflows.",
  tasks: "Standalone (Solitary) tasks on Work Items → Tasks.",
  schedules: "Recurring jobs on Work Items → Schedule.",
};

/**
 * Toggles with defaults applied — a missing value is on, like the daemon's
 * `resolveFeatures`. Tolerates a daemon too old to report `features` at all.
 */
export function resolveFeatures(raw: Partial<Record<string, unknown>> | null | undefined): Features {
  return {
    stories: raw?.stories !== false,
    tasks: raw?.tasks !== false,
    schedules: raw?.schedules !== false,
  };
}

/** The feature a `/work-defs/new?type=` form needs (Scheduled → Schedules; else Tasks, incl. Template). */
export function featureForWorkDefForm(search: string): FeatureName {
  const type = new URLSearchParams(search).get("type");
  return type === "Scheduled" ? "schedules" : "tasks";
}

/**
 * First path segment → the feature its pages belong to. The legacy list routes
 * (`/board`, `/tasks`, `/templates`, `/schedule`) redirect to the matching Work
 * Items sub-tab and keep its feature; `/pending` and `/archived` redirect to
 * the mixed tabs, which aren't gated on one kind.
 */
const SEGMENT_FEATURES: Record<string, FeatureName> = {
  board: "stories",
  story: "stories",
  stories: "stories",
  task: "stories",
  tasks: "tasks",
  templates: "tasks",
  schedule: "schedules",
};

/**
 * Work Items sub-tab → its feature. Pending and Archived mix every kind, so
 * they're absent (ungated; a switched-off kind's chip and rows hide inside — pages/LifecyclePage.tsx).
 */
const WORK_ITEMS_TAB_FEATURES: Record<string, FeatureName> = {
  board: "stories",
  tasks: "tasks",
  schedule: "schedules",
};

/**
 * The feature a route's page needs, or null when it isn't gated (home, Thoughts,
 * Config and its Context tab, Work Items' mixed Pending/Archived tabs, …);
 * Config's Workflows tab needs Stories.
 * `/work-defs/:id` returns null: its kind is only known once the WorkDef loads,
 * and the daemon's 403 covers it (the page shows the notice).
 */
export function featureForPath(pathname: string, search = ""): FeatureName | null {
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (!first) return null;
  if (first === "work-defs") return segments[1] === "new" ? featureForWorkDefForm(search) : null;
  // Config's Workflows tab (and a workflow's detail) only applies to stories.
  if (first === "config") return segments[1] === "workflows" ? "stories" : null;
  if (first === "work-items") return WORK_ITEMS_TAB_FEATURES[segments[1] ?? ""] ?? null;
  return SEGMENT_FEATURES[first] ?? null;
}

/** The feature a triage proposal of this kind would create work in (story-task → Stories). */
export function featureForProposalKind(kind: string): FeatureName {
  switch (kind) {
    case "task": return "tasks";
    case "schedule": return "schedules";
    default: return "stories";
  }
}

/**
 * Keep the entries whose feature is on. Entries with no `feature` are always
 * kept; until the toggles have loaded (`null`), gated entries are left out so a
 * team that switched a kind off never sees it flash in.
 */
export function filterByFeatures<T extends { feature?: FeatureName | null }>(items: readonly T[], features: Features | null): T[] {
  return items.filter((item) => !item.feature || (features !== null && features[item.feature]));
}
