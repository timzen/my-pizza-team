/**
 * daemon/sources/revision.ts — "Enqueue once per revision of the source content."
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins".
 *
 * The core dedupe a source gets as `SourceContext.enqueueRevision`. Triage is
 * its prototype (a note is analysed once per edit; daemon/sources/thought.ts),
 * and an external source's `sync` reuses it: a Jira issue whose `updated`
 * hasn't moved since the last run isn't run again.
 *
 * The rule, in order:
 *   1. an item already in flight for the def → refuse (one run at a time);
 *   2. `revision` equals the one last handed over → refuse, unless `force`;
 *   3. enqueue through the single `enqueueFor` (which still refuses pending);
 *   4. on success, stamp the revision — **at enqueue**, not at completion, so
 *      a change landing mid-run is due again after it, and a failed run
 *      doesn't retry every sweep (re-running it is an explicit `force`).
 *
 * Revisions are opaque: equality is the only comparison, so an etag works as
 * well as a timestamp.
 */

import type { WorkItem } from "../../shared/types.ts";
import type { EnqueueRevisionOptions, RevisionCursor, SourceKv } from "./types.ts";

/** The kv key a def's last-handed-over revision is kept under. */
export function revisionKey(defId: string): string {
  return `revision:${defId}`;
}

/** The default cursor: the source's own kv store. */
export function kvRevisionCursor(kv: SourceKv): RevisionCursor {
  return {
    get: (defId) => kv.get(revisionKey(defId)),
    set: (defId, revision) => kv.set(revisionKey(defId), revision),
  };
}

/** What `enqueueRevision` needs from the daemon (a subset of `SourceContext`). */
export interface RevisionDeps {
  hasActiveItem(defId: string): boolean;
  enqueue(defId: string): WorkItem | null;
}

/**
 * Enqueue `defId` unless it's in flight or `revision` was already handed over
 * (see the rule above); stamp `revision` on success. Returns the new item, or
 * null when refused.
 */
export function enqueueRevision(
  deps: RevisionDeps,
  defaultCursor: RevisionCursor,
  defId: string,
  revision: string,
  opts: EnqueueRevisionOptions = {},
): WorkItem | null {
  const cursor = opts.cursor ?? defaultCursor;
  if (deps.hasActiveItem(defId)) return null;
  if (!opts.force && cursor.get(defId) === revision) return null;
  const item = deps.enqueue(defId);
  if (!item) return null;
  cursor.set(defId, revision);
  return item;
}
