/**
 * shared/directory.ts — `normalizeDirectory`, the one directory normalization the
 * daemon applies at write time and compare time (affinity, the exclusive lease,
 * favorites).
 *
 * It lives apart from shared/types.ts because it reads the file system
 * (`realpathSync`) and `$HOME`: shared/types.ts stays free of `node:` imports so the
 * web UI can import its types directly.
 */

import * as fs from "node:fs";

/**
 * Normalize a directory value for comparison: expand a leading `~` to $HOME,
 * strip a trailing slash, then resolve symlinks to the real path (so
 * `/home/u/repo` and `/local/home/u/repo` via a `/home/u` symlink compare
 * equal). If the path doesn't exist or can't be resolved on this machine, the
 * `~`/slash-only form is returned — this never throws. Applied at write time
 * *and* at compare time in `Store.getNextWorkItem`, so rows stored before
 * symlink resolution (or before the path existed) still match. Directory
 * matching is only a soft affinity bias, so an imperfect normalization (e.g. a
 * path missing on the daemon's host) merely loses the preference — it never
 * strands work (docs/DESIGN.md "Work Matching: Directory Affinity"). The
 * exclusive directory lease compares the same normalized form (see
 * `directoriesOverlap`); a miss there only lets two items run side by side, as
 * they would with the lease off.
 */
export function normalizeDirectory(dir: string): string {
  const expanded = dir.replace(/^~(?=$|\/)/, process.env["HOME"] || "~");
  // Keep a bare "/" as-is rather than stripping it to the empty string.
  const stripped = expanded.replace(/\/+$/, "") || (expanded ? "/" : "");
  if (!stripped) return stripped;
  try {
    return fs.realpathSync(stripped);
  } catch {
    // Missing, unreadable, or no --allow-read: fall back to the string form.
    return stripped;
  }
}
