/**
 * daemon/store/source-kv.ts — On-disk IO for a Work Source's key/value store.
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins".
 *
 * Each source gets one flat `sources/<sourceId>.json` file: a `{ key: value }`
 * map of strings. It is where a source keeps its runtime state — cursors,
 * revision stamps, sync tokens — so that state never lands in the authored
 * `workdef.md` (the "authored-only" invariant). It is team content (committed),
 * like a Schedule's `lastEnqueuedAt`, so a revision already handed over stays
 * handed over across a restart or a fresh clone.
 *
 * Reads go to disk every time (no cache): the files are tiny, and it keeps a
 * hand edit or a git pull visible without a reload.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import type { SourceKv } from "../sources/types.ts";

/** The team-dir subdirectory holding one JSON file per source. */
export const SOURCES_DIR = "sources";

function file(teamDir: string, sourceId: string): string {
  return path.join(teamDir, SOURCES_DIR, `${sourceId}.json`);
}

function read(teamDir: string, sourceId: string): Record<string, string> {
  const f = file(teamDir, sourceId);
  if (!existsSync(f)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Keep only string values: the store is string-typed, and a hand edit
    // shouldn't hand a source a number where it expects a revision string.
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

function write(teamDir: string, sourceId: string, data: Record<string, string>): void {
  const f = file(teamDir, sourceId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // Sorted keys so the committed file diffs cleanly.
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(f, JSON.stringify(sorted, null, 2) + "\n");
}

/** The file-backed key/value store for one source (`sources/<sourceId>.json`). */
export function fileSourceKv(teamDir: string, sourceId: string): SourceKv {
  return {
    get: (key) => read(teamDir, sourceId)[key],
    set: (key, value) => {
      const data = read(teamDir, sourceId);
      if (data[key] === value) return; // no-op writes keep the team dir clean
      data[key] = value;
      write(teamDir, sourceId, data);
    },
    delete: (key) => {
      const data = read(teamDir, sourceId);
      if (!(key in data)) return;
      delete data[key];
      write(teamDir, sourceId, data);
    },
  };
}
