/**
 * lib/external-sources.ts — How the UI shows an external (pull-only) Work
 * Source's mirrored defs: the generic read-only tab (pages/ExternalSourcePage)
 * and the read-only WorkDef detail page.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" (external sources).
 *
 * The wire types are hand-mirrored from shared/protocol.ts (`MirroredDefRow`,
 * `MirrorView`), as lib/triage.ts does. Kept pure (no React) so it's
 * unit-tested (tests/external-sources-ui.test.ts).
 */

import { externalSourcePath } from "./work-items.ts";

/** One row of `GET /api/work-sources/:id/defs` (shared/protocol.ts `MirroredDefRow`). */
export interface MirroredDefRow {
  id: string;
  title: string;
  externalId: string;
  url?: string;
  revision?: string;
  status: "active" | "archived";
  latestState: string | null;
  runCount: number;
  lastRunAt: string | null;
}

/** A mirrored WorkDef's provenance (shared/protocol.ts `MirrorView`). */
export interface MirrorInfo {
  sourceId: string;
  sourceLabel: string;
  externalId: string;
  url?: string;
  revision?: string;
  vanished: boolean;
}

/** The label of a row's latest WorkItem state ("Never run" when it has none). */
export function latestStateLabel(state: string | null): string {
  switch (state) {
    case null: return "Never run";
    case "READY": return "Queued";
    case "IN_PROGRESS": return "In progress";
    case "MORIBUND": return "Stalled";
    case "COMPLETE": return "Complete";
    case "FAILED": return "Failed";
    case "CANCELED": return "Canceled";
    default: return state;
  }
}

/** Badge tone for a latest state: in flight, good, bad, or neutral. */
export function latestStateTone(state: string | null): "active" | "ok" | "bad" | "neutral" {
  if (state === "READY" || state === "IN_PROGRESS") return "active";
  if (state === "COMPLETE") return "ok";
  if (state === "FAILED" || state === "MORIBUND") return "bad";
  return "neutral";
}

/**
 * A revision short enough for a table cell: a long opaque marker (a content
 * hash, an etag) is cut to its first 8 characters; a short one (a timestamp,
 * a version number) is shown whole. Absent → "—".
 */
export function shortRevision(revision: string | undefined): string {
  if (!revision) return "—";
  return revision.length > 16 ? revision.slice(0, 8) : revision;
}

/** "Open in Jira": the external link's label. */
export function openInLabel(sourceLabel: string): string {
  return `Open in ${sourceLabel}`;
}

/** Where a mirrored def's page goes Back to (and lives under): its source's tab. */
export function mirroredDefHomePath(mirror: Pick<MirrorInfo, "sourceId">): string {
  return externalSourcePath(mirror.sourceId);
}

/** Why the definition can't be edited here — shown in place of Edit. */
export function readOnlyHint(sourceLabel: string): string {
  return `Mirrored from ${sourceLabel} (pull only): edit it there and the next sync updates it here. ` +
    `Comments and attachments on the Thread still work.`;
}
