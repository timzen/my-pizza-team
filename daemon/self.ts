/**
 * daemon/self.ts — How to run *this* mpt again, as an argv.
 *
 * The configured Node (shared/runtime-config.ts: `--node` > `MPT_NODE` >
 * ~/.config/mpt/runtime.json) runs the CLI entry script: `cli/main.ts` from a
 * checkout, or the npm package's compiled `dist/main.js` (shared/paths.ts
 * `cliEntryScript`). With no (usable) configured Node, the running binary
 * (`process.execPath`) is the fallback — the service starts the daemon with the
 * configured Node anyway, so the two normally agree. Used by `mpt start --daemon`
 * (the background child) and by spawn templates' `{mpt}` placeholder (`mpt agent`
 * teammates).
 *
 * TODO(node-runtime): drop the Deno and compiled-binary branches once the Deno
 * toolchain is removed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { cliEntryScript } from "../shared/paths.ts";
import { configuredNode } from "../shared/runtime-config.ts";

/** The configured Node if it still exists, else null. Cheap: one file read and a stat. */
function savedNode(): string | null {
  const node = configuredNode()?.path;
  return node && fs.existsSync(node) ? node : null;
}

/** The runtime binary's name, without directory or `.exe`, lower-cased. */
function runtimeName(execPath: string): string {
  return path.basename(execPath).toLowerCase().replace(/\.exe$/, "");
}

/**
 * The argv that runs the mpt CLI: `[node, <entry script>]` with the configured Node,
 * or — when none is configured — derived from `execPath`: `[node, <entry>]`, or
 * `[binary]` for a legacy `deno compile` binary.
 */
export function mptInvocation(execPath: string = process.execPath, node: string | null = savedNode()): string[] {
  if (node) return [node, cliEntryScript()];
  const runtime = runtimeName(execPath);
  if (runtime !== "node" && runtime !== "deno") return [execPath];
  // Still on the Deno toolchain: `deno` needs `run` and the permissions `deno task mpt` grants.
  if (runtime === "deno") {
    return [execPath, "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run", cliEntryScript()];
  }
  return [execPath, cliEntryScript()];
}
