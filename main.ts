/**
 * main.ts — Unified entry point for the compiled mpt binary.
 *
 * Routes to either the CLI (argument handling) or directly starts
 * the daemon when no arguments are provided with `start` subcommand.
 * This ensures the compiled binary supports all CLI commands including -h.
 */

import { main as cliMain } from "./cli/main.ts";

if (import.meta.main) {
  await cliMain();
}
