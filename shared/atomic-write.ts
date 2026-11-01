/**
 * shared/atomic-write.ts — Crash-safe whole-file writes.
 *
 * `writeFileAtomic` writes to a temp file in the target's own directory and then
 * renames it over the target. `rename(2)` within one filesystem is atomic on
 * POSIX, so a reader — or the next start after a crash mid-write — sees either
 * the old file or the new one, never a truncated mix. The temp file has to live
 * beside the target: a rename across filesystems (e.g. from `/tmp`) isn't atomic.
 *
 * Use it for every file that gets rewritten in place (config.json, story and
 * WorkDef files, kv/state json, …). Append-only logs (`*.jsonl` — comments,
 * usage) keep using appends: an append never rewrites what is already there.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write `data` to `file` atomically: temp file in the same directory, then
 * rename over the target. The parent directory must exist (as with
 * `fs.writeFileSync`). On any failure the temp file is removed and the error
 * rethrown; the target is left as it was.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  // pid + random suffix: unique across processes and across concurrent writes
  // of the same file within one process (two in-flight temps never collide).
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}
