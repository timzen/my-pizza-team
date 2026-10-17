/**
 * lib/nav-section.ts — Which top-nav section a route belongs to, and where a
 * WorkDef's "Back" should land when there's no in-app history.
 *
 * Kept pure (no React) so the rules are unit-tested (tests/nav-section.test.ts)
 * and shared by the NavBar highlight, the WorkDef pages' Back fallback, and the
 * BackButton's "is there anywhere to go back to?" check.
 *
 * Why this exists: the NavBar used raw `startsWith` prefixes, so the Board's
 * `/task` prefix also claimed `/tasks` (Board + Tasks both lit up), and
 * `/work-defs/*` was claimed by nobody (nothing lit up on a WorkDef page). A
 * WorkDef's section depends on its *type*, not its URL — Solitary lives under
 * Tasks, Scheduled under Schedule — so the type has to be fed in.
 */

/** The top-nav sections (NavBar links). */
export type NavSection = "thoughts" | "board" | "tasks" | "schedule" | "context";

/** WorkDef types as the API reports them, plus "Template" (the new-WorkDef form's mode). */
export type WorkDefKind = "Solitary" | "Scheduled" | "Board" | "Triage" | "Template";

/** First path segment → section. Segment (not prefix) matching so `/tasks` ≠ `/task`. */
const SEGMENT_SECTIONS: Record<string, NavSection> = {
  thoughts: "thoughts",
  board: "board",
  backlog: "board",
  archived: "board",
  workflows: "board",
  story: "board",
  stories: "board",
  task: "board",
  tasks: "tasks",
  templates: "tasks",
  schedule: "schedule",
  context: "context",
};

/** The section a WorkDef of this type belongs to (Solitary/Template → Tasks, Scheduled → Schedule). */
export function sectionForWorkDefType(type: WorkDefKind | string | null | undefined): NavSection | null {
  switch (type) {
    case "Solitary":
    case "Template":
      return "tasks";
    case "Scheduled":
      return "schedule";
    case "Board":
      return "board";
    case "Triage":
      return "thoughts";
    default:
      return null;
  }
}

/**
 * The nav section for a route. `/work-defs/*` is shared by several sections,
 * so the caller supplies the WorkDef's type (for `/work-defs/:id`, once loaded)
 * — `/work-defs/new` reads it from its `?type=` param. Returns null when the
 * route belongs to no section (home, help, config, usage, an unloaded WorkDef).
 */
export function navSectionForPath(
  pathname: string,
  opts: { search?: string; workDefType?: string | null } = {},
): NavSection | null {
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (!first) return null;
  if (first === "work-defs") {
    if (segments[1] === "new") {
      // The form defaults to Solitary when ?type is absent.
      const type = new URLSearchParams(opts.search ?? "").get("type") || "Solitary";
      return sectionForWorkDefType(type);
    }
    return sectionForWorkDefType(opts.workDefType);
  }
  return SEGMENT_SECTIONS[first] ?? null;
}

/**
 * The list page a WorkDef of this type belongs to — the Back fallback when the
 * page was opened without in-app history (fresh tab, bookmark), and where to go
 * after deleting it.
 */
export function workDefHomePath(type: WorkDefKind | string | null | undefined): string {
  switch (type) {
    case "Scheduled":
      return "/schedule";
    case "Template":
      return "/templates";
    case "Board":
      return "/board";
    case "Triage":
      return "/thoughts";
    default:
      return "/tasks";
  }
}

/**
 * Is there an earlier in-app entry to go back to? React Router's BrowserRouter
 * stamps `history.state.idx` (0 for the first entry this app created, +1 per
 * push, unchanged by replace). This is more reliable than `location.key ===
 * "default"`, which stops being "default" after any replace (e.g. switching the
 * Details/Thread tab), making a fresh-load Back leave the app entirely.
 */
export function canGoBackInApp(historyState: unknown): boolean {
  const idx = (historyState as { idx?: unknown } | null | undefined)?.idx;
  return typeof idx === "number" && idx > 0;
}
