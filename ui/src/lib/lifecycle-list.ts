/**
 * lib/lifecycle-list.ts — The rows of Work Items → Pending and Work Items →
 * Archived: one mixed list of stories, standalone tasks, and scheduled jobs in
 * that lifecycle state (docs/DESIGN.md "Pending: Write, Review, Activate"),
 * with the kind filter chips, text search, and newest-first sort.
 *
 * The pages compose the existing list endpoints client-side (`/api/stories`,
 * `/api/archived`, `/api/work-defs[?status=archived]`, `/api/schedules`) —
 * the lists are small and already polled by other tabs, so an aggregated
 * endpoint isn't worth a new daemon route (docs/ARCHITECTURE.md "Work Items").
 *
 * What's listed:
 * - **Story** — a pending story (`/api/stories`, `pending`) or an archived one
 *   (`/api/archived`). Board tasks are *not* listed on their own: a pending
 *   board task holds its place in its story's swimlane, so it's reviewed and
 *   activated there (or on its task page), and an archived story's tasks go
 *   with it.
 * - **Task** — a Solitary WorkDef that's pending, or archived.
 * - **Schedule** — a Scheduled WorkDef whose definition *or* Schedule is
 *   pending (lib/work-items.ts `isActiveScheduledJob`), or that's archived.
 *
 * Timestamps: the API exposes no "became pending" time, and only stories carry
 * when they were archived (`archivedAt`). Otherwise a row shows the latest
 * activity there is — a WorkDef's last run, else its Schedule's last fire —
 * and rows without any sort after the dated ones, by title.
 *
 * Kept pure (no React) so the rules are unit-tested (tests/lifecycle-list.test.ts).
 */

import type { Features, FeatureName } from "./features.ts";
import { isActiveScheduledJob } from "./work-items.ts";

/** Which lifecycle list: Work Items → Pending or Work Items → Archived. */
export type LifecycleState = "pending" | "archived";

/** A row's kind (its type badge and filter chip). */
export type LifecycleKind = "story" | "task" | "schedule";

/** What a pending row's **Activate** calls — the definition first, then its Schedule. */
export type ActivateTarget =
  | { kind: "story"; id: string }
  | { kind: "workDef"; id: string }
  | { kind: "schedule"; id: string };

/** One row of the Pending or Archived list. */
export interface LifecycleRow {
  kind: LifecycleKind;
  /** The story id or WorkDef id. */
  id: string;
  title: string;
  directory?: string | null;
  /** Its detail page; null when there is none (an archived story — the row shows its synopsis instead). */
  href: string | null;
  /** The row's timestamp (ISO), or null when none is known. */
  at: string | null;
  /** What `at` means ("Archived", "Last run", "Last fired"); null with `at`. */
  atLabel: string | null;
  /** Pending rows only: what Activate calls (null when nothing can be activated). */
  activate?: ActivateTarget | null;
  /** A scheduled job's cron, when known. */
  cron?: string;
  /** An archived story's synopsis. */
  synopsis?: string;
}

/** The slice of `/api/stories` (shared/protocol.ts StoryView) the lists read. */
export interface StoryLike {
  id: string;
  title: string;
  directory?: string;
  pending?: boolean;
}

/** The slice of `/api/archived` the lists read. */
export interface ArchivedStoryLike {
  id: string;
  title: string;
  archivedAt: string;
  synopsis: string;
}

/** The slice of `/api/work-defs` (shared/protocol.ts WorkDefView) the lists read. */
export interface WorkDefLike {
  id: string;
  title: string;
  type: string;
  parent?: { kind: string; id: string };
  directory?: string | null;
  pending?: boolean;
  lastRunAt?: string | null;
}

/** The slice of `/api/schedules` (shared/protocol.ts ScheduleView) the lists read. */
export interface ScheduleLike {
  id: string;
  cron: string;
  pending?: boolean;
  lastEnqueuedAt?: string | null;
}

/** The kind chips, in display order, with the feature toggle each needs. */
export const LIFECYCLE_KINDS: ReadonlyArray<{ kind: LifecycleKind; label: string; feature: FeatureName }> = [
  { kind: "story", label: "Stories", feature: "stories" },
  { kind: "task", label: "Tasks", feature: "tasks" },
  { kind: "schedule", label: "Schedules", feature: "schedules" },
];

/** A row's type-badge text. */
export const KIND_BADGES: Record<LifecycleKind, string> = { story: "Story", task: "Task", schedule: "Schedule" };

/**
 * The kinds whose chip (and rows) show for the team's toggles: a switched-off
 * kind is hidden entirely. None until the toggles load, so nothing flashes in.
 */
export function enabledKinds(features: Features | null): LifecycleKind[] {
  if (!features) return [];
  return LIFECYCLE_KINDS.filter((k) => features[k.feature]).map((k) => k.kind);
}

/** Turn one kind chip on or off, keeping the rest (the chips are multi-select). */
export function toggleKind(selected: readonly LifecycleKind[], kind: LifecycleKind): LifecycleKind[] {
  return selected.includes(kind) ? selected.filter((k) => k !== kind) : [...selected, kind];
}

const storyHref = (id: string) => `/story/${encodeURIComponent(id)}`;
const workDefHref = (id: string) => `/work-defs/${encodeURIComponent(id)}`;

/** A WorkDef's "latest activity" timestamp: its last run, else its Schedule's last fire. */
function activityOf(def: WorkDefLike, schedule?: ScheduleLike): Pick<LifecycleRow, "at" | "atLabel"> {
  if (def.lastRunAt) return { at: def.lastRunAt, atLabel: "Last run" };
  if (schedule?.lastEnqueuedAt) return { at: schedule.lastEnqueuedAt, atLabel: "Last fired" };
  return { at: null, atLabel: null };
}

/** The job's Schedule, when its parent is one we know. */
function scheduleFor(def: WorkDefLike, schedules: readonly ScheduleLike[]): ScheduleLike | undefined {
  return def.parent?.kind === "schedule" ? schedules.find((s) => s.id === def.parent!.id) : undefined;
}

/**
 * The Pending list's rows: pending stories, pending Solitary tasks, and
 * scheduled jobs held back by their definition or their Schedule. `workDefs`
 * is the active list (`/api/work-defs`). Unsorted — see `sortNewestFirst`.
 *
 * A scheduled job's Activate goes to its definition while that's pending
 * (one-way; it then fires once its Schedule is active too), otherwise to its
 * Schedule (reversible).
 */
export function pendingRows(
  stories: readonly StoryLike[],
  workDefs: readonly WorkDefLike[],
  schedules: readonly ScheduleLike[],
): LifecycleRow[] {
  const rows: LifecycleRow[] = [];
  for (const s of stories) {
    if (!s.pending) continue;
    rows.push({ kind: "story", id: s.id, title: s.title, directory: s.directory, href: storyHref(s.id), at: null, atLabel: null, activate: { kind: "story", id: s.id } });
  }
  for (const d of workDefs) {
    if (d.type === "Solitary" && d.pending === true) {
      rows.push({ kind: "task", id: d.id, title: d.title, directory: d.directory, href: workDefHref(d.id), ...activityOf(d), activate: { kind: "workDef", id: d.id } });
    } else if (d.type === "Scheduled") {
      const sched = scheduleFor(d, schedules);
      if (isActiveScheduledJob(d, sched)) continue;
      const activate: ActivateTarget | null = d.pending ? { kind: "workDef", id: d.id } : sched ? { kind: "schedule", id: sched.id } : null;
      rows.push({ kind: "schedule", id: d.id, title: d.title, directory: d.directory, href: workDefHref(d.id), ...activityOf(d, sched), activate, cron: sched?.cron });
    }
  }
  return rows;
}

/**
 * The Archived list's rows: archived stories (with their synopses — there's no
 * detail page for an archived story) and archived Solitary/Scheduled WorkDefs
 * (`/api/work-defs?status=archived`). Unsorted — see `sortNewestFirst`.
 */
export function archivedRows(
  stories: readonly ArchivedStoryLike[],
  workDefs: readonly WorkDefLike[],
  schedules: readonly ScheduleLike[],
): LifecycleRow[] {
  const rows: LifecycleRow[] = stories.map((s) => ({
    kind: "story" as const, id: s.id, title: s.title, href: null,
    at: s.archivedAt || null, atLabel: s.archivedAt ? "Archived" : null, synopsis: s.synopsis,
  }));
  for (const d of workDefs) {
    if (d.type !== "Solitary" && d.type !== "Scheduled") continue;
    const sched = d.type === "Scheduled" ? scheduleFor(d, schedules) : undefined;
    rows.push({ kind: d.type === "Solitary" ? "task" : "schedule", id: d.id, title: d.title, directory: d.directory, href: workDefHref(d.id), ...activityOf(d, sched), cron: sched?.cron });
  }
  return rows;
}

/**
 * Keep the rows whose kind is selected and that match the search: a
 * case-insensitive substring of the title, id, or directory (blank matches all).
 */
export function filterRows(rows: readonly LifecycleRow[], kinds: readonly LifecycleKind[], query = ""): LifecycleRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) =>
    kinds.includes(r.kind) &&
    (!q || [r.title, r.id, r.directory ?? ""].some((f) => f.toLowerCase().includes(q)))
  );
}

/** Newest first; rows without a timestamp go last, by title (then id, so the order is stable). */
export function sortNewestFirst(rows: readonly LifecycleRow[]): LifecycleRow[] {
  return [...rows].sort((a, b) => {
    if (a.at && b.at && a.at !== b.at) return Date.parse(b.at) - Date.parse(a.at);
    if (a.at && !b.at) return -1;
    if (!a.at && b.at) return 1;
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}

/** How many rows of each kind (the chips' counts, before search). */
export function countByKind(rows: readonly LifecycleRow[]): Record<LifecycleKind, number> {
  const counts: Record<LifecycleKind, number> = { story: 0, task: 0, schedule: 0 };
  for (const r of rows) counts[r.kind]++;
  return counts;
}
