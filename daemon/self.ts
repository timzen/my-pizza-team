/**
 * daemon/self.ts — How to run *this* mpt again, as an argv.
 *
 * The runtime binary (`process.execPath`) runs the CLI entry script: `cli/main.ts`
 * from a checkout, or the npm package's compiled `dist/main.js`
 * (shared/paths.ts `cliEntryScript`). Used by `mpt start --daemon` (the
 * background child) and by spawn templates' `{mpt}` placeholder (`mpt agent`
 * teammates).
 *
 * TODO(node-runtime): use the saved Node setting (~/.config/mpt/runtime.json,
 * MPT_NODE, --node) instead of `process.execPath`. Drop the Deno and
 * compiled-binary branches once the Deno toolchain is removed.
 */

import * as path from "node:path";
import { cliEntryScript } from "../shared/paths.ts";

/** The runtime binary's name, without directory or `.exe`, lower-cased. */
function runtimeName(execPath: string): string {
  return path.basename(execPath).toLowerCase().replace(/\.exe$/, "");
}

/** The argv that runs the mpt CLI: `[node, <entry script>]`, or `[binary]` for a legacy `deno compile` binary. */
export function mptInvocation(execPath: string = process.execPath): string[] {
  const runtime = runtimeName(execPath);
  if (runtime !== "node" && runtime !== "deno") return [execPath];
  // Still on the Deno toolchain: `deno` needs `run` and the permissions `deno task mpt` grants.
  if (runtime === "deno") {
    return [execPath, "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run", cliEntryScript()];
  }
  return [execPath, cliEntryScript()];
}
