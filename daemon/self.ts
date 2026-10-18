/**
 * daemon/self.ts — How to run *this* mpt again, as an argv.
 *
 * From source, the runtime binary (`process.execPath`) runs the CLI script:
 * `node cli/main.ts`. A legacy compiled binary is its own executable. Used by
 * `mpt start --daemon` (the background child) and by spawn templates' `{mpt}`
 * placeholder (`mpt agent` teammates).
 *
 * TODO(node-runtime): use the saved Node setting (~/.config/mpt/runtime.json,
 * MPT_NODE, --node) and the installed package's compiled entry point instead of
 * `process.execPath` + the source tree. Drop the Deno branch once the CLI is
 * ported and the Deno toolchain is removed.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The runtime binary's name, without directory or `.exe`, lower-cased. */
function runtimeName(execPath: string): string {
  return path.basename(execPath).toLowerCase().replace(/\.exe$/, "");
}

/** Running from source (`node cli/main.ts`) rather than a compiled binary? */
export function isRunningFromSource(execPath: string = process.execPath): boolean {
  const base = runtimeName(execPath);
  return base === "node" || base === "deno";
}

/** The argv that runs the mpt CLI: `[node, cli/main.ts]`, or `[binary]` when compiled. */
export function mptInvocation(execPath: string = process.execPath): string[] {
  if (!isRunningFromSource(execPath)) return [execPath];
  const cli = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
  // Still on the Deno toolchain (the CLI isn't ported yet): `deno` needs `run` and
  // the permissions `deno task mpt` grants.
  if (runtimeName(execPath) === "deno") {
    return [execPath, "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run", cli];
  }
  return [execPath, cli];
}
