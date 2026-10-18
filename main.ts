/**
 * main.ts — Unified entry point for mpt (`node main.ts <command>`).
 *
 * Hands every argument to the CLI (cli/main.ts), so this entry supports all CLI
 * commands, including `start` (which runs the daemon) and -h.
 */

import { main as cliMain } from "./cli/main.ts";
import { isMainModule } from "./shared/main-module.ts";

if (isMainModule(import.meta.url)) {
  await cliMain();
}
