/**
 * daemon/self.ts — How to run *this* mpt again, as an argv.
 *
 * The configured Node (shared/runtime-config.ts: `--node` > `MPT_NODE` >
 * ~/.config/mpt/runtime.json) runs the CLI entry script: `cli/main.ts` from a
 * checkout, or the npm package's compiled `dist/main.js` (shared/paths.ts
 * `cliEntryScript`). With no (usable) configured Node, the running Node
 * (`process.execPath`) is the fallback — the service starts the daemon with the
 * configured Node anyway, so the two normally agree. Used by `mpt start --daemon`
 * (the background child) and by spawn templates' `{mpt}` placeholder (`mpt agent`
 * teammates).
 */

import * as fs from "node:fs";
import { cliEntryScript } from "../shared/paths.ts";
import { configuredNode } from "../shared/runtime-config.ts";

/** The configured Node if it still exists, else null. Cheap: one file read and a stat. */
function savedNode(): string | null {
  const node = configuredNode()?.path;
  return node && fs.existsSync(node) ? node : null;
}

/**
 * The argv that runs the mpt CLI: `[node, <entry script>]` with the configured Node,
 * or — when none is configured — the running Node (`execPath`) with that entry.
 */
export function mptInvocation(execPath: string = process.execPath, node: string | null = savedNode()): string[] {
  if (node) return [node, cliEntryScript()];
  return [execPath, cliEntryScript()];
}
