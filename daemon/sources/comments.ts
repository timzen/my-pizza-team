/**
 * daemon/sources/comments.ts — A mirrored WorkDef's thread, pulled from its
 * external source: validating and merging `ExternalDef.comments`, and the kv
 * record of comments MPT wrote back. See docs/DESIGN.md "External sources" —
 * "A mirrored thread".
 *
 * The mirror's `comments.jsonl` stays one append-only file holding both sides:
 * comments written in MPT (a person, a teammate, the daemon) and comments
 * pulled from the source, which carry `external: { source, id, channel,
 * author }`. Pure functions here; the Store does the file IO.
 *
 * **Dedupe, per item, by the source's comment id**, from two places:
 *   - the thread itself — every inbound comment carries its `external.id`, so
 *     the file is the record of what was pulled (nothing extra to keep in sync);
 *   - the source's kv (`sources/<id>.json`), `wroteback:<defId>:<commentId>` —
 *     the ids `onComment` returned for comments MPT posted, which come back
 *     from the source as if they were someone else's. They are already in the
 *     thread (as the MPT comment), so they're skipped, never appended again.
 */

import type { Comment, ThreadEntry } from "../../shared/types.ts";
import type { ExternalComment, SourceKv } from "./types.ts";

/** kv key: a comment MPT wrote back to the source, by the id the source gave it. Value: when. */
export function wroteBackKey(defId: string, commentExternalId: string): string {
  return `wroteback:${defId}:${commentExternalId}`;
}

/** Why one entry of `ExternalDef.comments` can't be used, or null when it can. */
export function invalidExternalComment(c: unknown): string | null {
  if (!c || typeof c !== "object") return "not an object";
  const d = c as Record<string, unknown>;
  for (const key of ["externalId", "author", "createdAt", "body"] as const) {
    if (typeof d[key] !== "string" || (d[key] as string).trim() === "") return `missing '${key}'`;
  }
  if (Number.isNaN(Date.parse(d.createdAt as string))) return "'createdAt' is not a date";
  if (d.channel !== undefined && typeof d.channel !== "string") return "'channel' is not a string";
  return null;
}

/** The thread line an inbound comment becomes. */
export function toThreadComment(sourceId: string, c: ExternalComment): Comment {
  const author = c.author.trim();
  const channel = c.channel?.trim();
  return {
    from: author,
    body: c.body,
    at: new Date(Date.parse(c.createdAt)).toISOString(),
    external: { source: sourceId, id: c.externalId, ...(channel ? { channel } : {}), author },
  };
}

/** The result of `mergeExternalComments`. */
export interface CommentMerge {
  /** New thread lines to append, oldest first. */
  added: Comment[];
  /** Entries refused as invalid, with why (for the source's log). */
  invalid: string[];
}

/**
 * Which of a source's reported comments are new to a mirror's thread: not
 * already pulled (an `external.id` in `thread`), not one MPT wrote back (kv),
 * not repeated in the batch. Returned oldest first, so a first sync lays the
 * history down in order. Pure: appending them is the caller's.
 */
export function mergeExternalComments(
  sourceId: string, defId: string, thread: ThreadEntry[], kv: Pick<SourceKv, "get">, reported: unknown[],
): CommentMerge {
  const known = new Set<string>();
  for (const e of thread) {
    const ext = (e as Comment).external;
    if (ext?.source === sourceId && typeof ext.id === "string") known.add(ext.id);
  }
  const added: Comment[] = [];
  const invalid: string[] = [];
  for (const [i, c] of reported.entries()) {
    const why = invalidExternalComment(c);
    if (why) {
      invalid.push(`comment #${i + 1}: ${why}`);
      continue;
    }
    const ext = c as ExternalComment;
    if (known.has(ext.externalId) || kv.get(wroteBackKey(defId, ext.externalId)) !== undefined) continue;
    known.add(ext.externalId);
    added.push(toThreadComment(sourceId, ext));
  }
  // Stable: equal timestamps keep the source's order.
  added.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { added, invalid };
}
