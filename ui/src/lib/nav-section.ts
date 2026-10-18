/**
 * lib/nav-section.ts — Which top-nav section a route belongs to, and where a
 * WorkDef's "Back" should land when there's no in-app history.
 *
 * Kept pure (no React) so the rules are unit-tested (tests/nav-section.test.ts)
 * and shared by the NavBar highlight, the WorkDef pages' Back fallback, and the
 * BackButton's "is there anywhere to go back to?" check.
 *
 * Why this exists: the NavBar used raw `startsWith` prefixes, so the Board's
 * `/task` prefix also claimed `/tasks`, and `/work-defs/*` was claimed by
 * nobody (nothing lit up on a WorkDef page). A WorkDef's section depends on its
 * *type*, not its URL — Solitary/Scheduled/Board work lives under Work, a
 * triage run under Thoughts — so the type has to be fed in.
 *
 * Board, Tasks, and Schedule used to be three nav sections; they are now
 * sub-tabs of the one **Work** section (lib/work-items.ts), which also
 * claims story/task/WorkDef detail pages. The old top-level list URLs redirect
 * into `/work/*` but are still mapped here, so the redirect's first
 * render lights the right item.
 */

import { workItemsPath } from "./work-items.ts";

/** The top-nav sections (NavBar links). */
export type NavSection = "thoughts" | "work-items";

/** WorkDef types as the API reports them, plus "Template" (the retired new-WorkDef form mode). */
export type WorkDefKind = "Solitary" | "Scheduled" | "Board" | "Triage" | "Template" | "External";

/**
 * First path segment → section. Segment (not prefix) matching keeps unrelated
 * routes that merely share a prefix out. Workflows and Context live under
 * `/config` (lit by the gear, not a section).
 */
const SEGMENT_SECTIONS: Record<string, NavSection> = {
  thoughts: "thoughts",
  work: "work-items",
  // The surface's old root (`/work-items/*` redirects to `/work/*`).
  "work-items": "work-items",
  story: "work-items",
  stories: "work-items",
  task: "work-items",
  // Legacy list routes (redirect into /work/*).
  board: "work-items",
  tasks: "work-items",
  schedule: "work-items",
  pending: "work-items",
  backlog: "work-items",
  archived: "work-items",
  templates: "work-items",
};

/** The section a WorkDef of this type belongs to (standalone and board work → Work, triage → Thoughts). */
export function sectionForWorkDefType(type: WorkDefKind | string | null | undefined): NavSection | null {
  switch (type) {
    case "Solitary":
    case "Template":
    case "Scheduled":
    case "Board":
    case "External": // a mirrored def lives on its source's Work tab
      return "work-items";
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
 * after deleting it: its Work sub-tab (Scheduled → Schedule, Board →
 * Board, anything else → Tasks; Templates are hidden, so they land on Tasks too).
 */
export function workDefHomePath(type: WorkDefKind | string | null | undefined): string {
  switch (type) {
    case "Scheduled":
      return workItemsPath("schedule");
    case "Board":
      return workItemsPath("board");
    case "Triage":
      return "/thoughts";
    default:
      return workItemsPath("tasks");
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
