/**
 * daemon/self.ts — How to run *this* mpt again, as an argv.
 *
 * The compiled binary is its own executable. From source, `Deno.execPath()` is
 * `deno`, so re-running needs `run`, the permissions `deno task mpt` grants, and the
 * CLI script. Used by `mpt start --daemon` (the background child) and by spawn
 * templates' `{mpt}` placeholder (`mpt agent` teammates).
 */

import * as path from "@std/path";

/** Running from source (`deno run cli/main.ts`) rather than the compiled binary? */
export function isRunningFromSource(execPath: string = Deno.execPath()): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === "deno" || base === "deno.exe";
}

/** The argv that runs the mpt CLI: `[binary]`, or `[deno, run, …perms, cli/main.ts]`. */
export function mptInvocation(execPath: string = Deno.execPath()): string[] {
  if (!isRunningFromSource(execPath)) return [execPath];
  const cli = path.fromFileUrl(new URL("../cli/main.ts", import.meta.url));
  return [execPath, "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run", cli];
}
