/**
 * shared/main-module.ts — "Is this module the entry script?" for Node.
 *
 * Node's stand-in for `import.meta.main` (only in Node >= 24.2, and the package
 * supports all of 24). Compares the entry script (`process.argv[1]`) with the
 * module's own file, both symlink-resolved, so a globally installed `mpt` bin —
 * a symlink into the package — still counts as running the module directly.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/** True when the module at `importMetaUrl` was run directly (`node <file>`), not imported. */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
