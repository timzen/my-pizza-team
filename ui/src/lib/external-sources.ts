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
import type { TriageBadge } from "./triage.ts";

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
  /** "triage" for a triage-mode item (docs/DESIGN.md "External sources" — "Triage mode"). */
  mode?: "work" | "triage";
  /** Triage-mode items only: the latest analysis's badge. */
  triageBadge?: TriageBadge;
}

/** A mirrored WorkDef's provenance (shared/protocol.ts `MirrorView`). */
export interface MirrorInfo {
  sourceId: string;
  sourceLabel: string;
  externalId: string;
  url?: string;
  revision?: string;
  vanished: boolean;
  /** "triage": a teammate triages it into proposals instead of working it. */
  mode?: "work" | "triage";
  /** A person's persona override for this mirror (`PUT /api/work-defs/:id/persona`), when set. */
  personaOverride?: string;
}

/** Is this mirror (or row) in triage mode — its page leads with a Triage tab, its Run is Triage now? */
export function isTriageMode(mirror: { mode?: "work" | "triage" } | undefined): boolean {
  return mirror?.mode === "triage";
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

/** Where a thread comment came from, when sync pulled it from the source (shared/types.ts `CommentExternal`). */
export interface ExternalCommentInfo {
  source: string;
  id: string;
  channel?: string;
  author: string;
}

/**
 * The badge beside an inbound comment's author on a mirror's Thread: the
 * source and, when it has several threads, the channel ("SIM-T · Worklog").
 * docs/DESIGN.md "External sources" — "A mirrored thread".
 */
export function externalCommentLabel(ext: ExternalCommentInfo, sourceLabel?: string): string {
  const source = sourceLabel || ext.source;
  return ext.channel ? `${source} · ${ext.channel}` : source;
}

/**
 * A thread, newest first, by each comment's own time. Comments written in MPT
 * are appended in time order already; ones pulled from a source arrive at
 * sync time but carry the time they were written there, so file order alone
 * would misplace them. Stable for equal (or unparsable) times.
 */
export function newestFirst<T extends { at: string }>(comments: readonly T[]): T[] {
  const time = (c: T) => {
    const t = Date.parse(c.at);
    return Number.isNaN(t) ? 0 : t;
  };
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => time(b.c) - time(a.c) || b.i - a.i)
    .map(({ c }) => c);
}
