/**
 * daemon/main.ts — Entry point for the HTTP daemon.
 *
 * Starts a Hono server using Deno's native serve adapter.
 * Manages the full daemon lifecycle:
 * - Checks for existing daemon (PID file)
 * - Writes PID file on start
 * - Registers SIGTERM/SIGINT handlers for graceful shutdown
 * - Flushes state and cleans up on exit
 */

import { createApp } from "./app.ts";
import { TEAM_DIR } from "../shared/types.ts";
import {
  writePidFile,
  isAlreadyRunning,
  registerSignalHandlers,
  type DaemonContext,
} from "./lifecycle.ts";
import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";

const teamDir = Deno.env.get("TEAM_DIR") || path.join(Deno.cwd(), TEAM_DIR);
const port = Number(Deno.env.get("PORT") ?? 7437);

// Ensure team directory exists
if (!existsSync(teamDir)) {
  Deno.mkdirSync(teamDir, { recursive: true });
}

// Check if another daemon is already running
const existing = isAlreadyRunning(teamDir);
if (existing.running) {
  console.error(`❌ Daemon already running (PID ${existing.pid}). Stop it first or remove ${teamDir}/daemon.pid`);
  Deno.exit(1);
}

// Create the app and store
const { app, store } = createApp(teamDir);

// Start the HTTP server
const server = Deno.serve({ port, hostname: "127.0.0.1" }, app.fetch);

// Write PID file
const pidFile = writePidFile(teamDir);

// Set up graceful shutdown context
const ctx: DaemonContext = { store, server, teamDir, pidFile };
registerSignalHandlers(ctx);

console.log(`🍕 my-pizza-team daemon listening on http://localhost:${port}`);
console.log(`   PID: ${Deno.pid} (${pidFile})`);
console.log(`   Team dir: ${teamDir}`);
console.log(`   Press Ctrl+C to stop.`);
