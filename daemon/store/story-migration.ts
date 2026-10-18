/**
 * daemon/store/story-migration.ts — Migrate pre-pending story files on load.
 *
 * Stories used to have two ways of being held back: a `paused: true` flag in
 * `stories/<id>.json`, and the `backlog/` directory (a story moved there, plus
 * every story that transitively depended on it, with a `backloggedAt` stamp).
 * Both are now the one reversible **pending** state (docs/DESIGN.md "Pending:
 * Write, Review, Activate"). This module rewrites old files into the new shape
 * before `Store.loadFromDisk` reads them:
 *
 *   - `stories/<id>.json` with `paused` → `pending: true` (when paused was true);
 *     the `paused` and any stray `backloggedAt` fields are dropped.
 *   - `backlog/<id>.json` → `stories/<id>.json` with `pending: true` and no
 *     `backloggedAt`; the `backlog/` directory is removed once empty.
 *
 * It's idempotent: a migrated team has no `paused` fields and no `backlog/`, so a
 * second run changes nothing. A backlog file whose id already exists in
 * `stories/` is left in place (never clobber a live story) and reported, so it
 * can be resolved by hand.
 */

import * as path from "node:path";
import { existsSync } from "node:fs";
import { STORIES_DIR } from "../../shared/types.ts";

/** The retired backlog directory (`<teamDir>/backlog/`). Only migration reads it. */
export const LEGACY_BACKLOG_DIR = "backlog";

/** What a migration pass changed (all story ids). */
export interface StoryMigrationResult {
  /** `stories/` files rewritten because they carried `paused`/`backloggedAt`. */
  rewritten: string[];
  /** Stories moved from `backlog/` back into `stories/` as pending. */
  unbacklogged: string[];
  /** Backlog files left in place because `stories/` already has that id. */
  conflicts: string[];
}

/**
 * Normalize one story object in place to the pending shape. Returns true when
 * anything changed. `forcePending` marks it pending regardless (backlogged
 * stories were shelved, so they come back pending).
 */
function normalizeStoryData(data: Record<string, unknown>, forcePending: boolean): boolean {
  let changed = false;
  if ("paused" in data) {
    if (data.paused === true) data.pending = true;
    delete data.paused;
    changed = true;
  }
  if ("backloggedAt" in data) {
    delete data.backloggedAt;
    changed = true;
  }
  if (forcePending && data.pending !== true) {
    data.pending = true;
    changed = true;
  }
  return changed;
}

/** Read a JSON object file, or null when it's missing or malformed. */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(Deno.readTextFileSync(file));
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: Record<string, unknown>): void {
  Deno.writeTextFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Rewrite a team directory's legacy story files (`paused`, `backlog/`) into the
 * pending model. Safe to run on every load; see the file header for the rules.
 */
export function migrateLegacyStoryFiles(teamDir: string): StoryMigrationResult {
  const result: StoryMigrationResult = { rewritten: [], unbacklogged: [], conflicts: [] };
  const storiesDir = path.join(teamDir, STORIES_DIR);

  // 1. paused → pending in the live stories.
  if (existsSync(storiesDir)) {
    for (const entry of Deno.readDirSync(storiesDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const file = path.join(storiesDir, entry.name);
      const data = readJsonObject(file);
      if (!data || !normalizeStoryData(data, false)) continue;
      writeJson(file, data);
      result.rewritten.push(String(data.id ?? entry.name.slice(0, -5)));
    }
  }

  // 2. backlog/<id>.json → stories/<id>.json (pending). Board tasks are WorkDefs
  // under tasks/ and never moved with the story, so the file move is all it takes.
  const backlogDir = path.join(teamDir, LEGACY_BACKLOG_DIR);
  if (existsSync(backlogDir)) {
    Deno.mkdirSync(storiesDir, { recursive: true });
    for (const entry of Deno.readDirSync(backlogDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const src = path.join(backlogDir, entry.name);
      const data = readJsonObject(src);
      if (!data) continue; // malformed: leave it for a human, like loadFromDisk skips it
      const dest = path.join(storiesDir, entry.name);
      const id = String(data.id ?? entry.name.slice(0, -5));
      if (existsSync(dest)) { result.conflicts.push(id); continue; }
      normalizeStoryData(data, true);
      writeJson(dest, data);
      Deno.removeSync(src);
      result.unbacklogged.push(id);
    }
    // Drop the directory once nothing is left in it (conflicts keep it).
    if ([...Deno.readDirSync(backlogDir)].length === 0) Deno.removeSync(backlogDir);
  }

  return result;
}
