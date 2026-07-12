/**
 * cli/start-daemon.ts — Start the daemon in-process.
 *
 * Used by the CLI's foreground `start` command and the compiled binary.
 * Extracts the daemon startup logic from daemon/main.ts into a callable
 * function so compiled binaries don't need to shell out to `deno run`.
 */

import { createApp } from "../daemon/app.ts";
import {
  writePidFile,
  isAlreadyRunning,
  registerSignalHandlers,
  type DaemonContext,
} from "../daemon/lifecycle.ts";
import { resolveToken, validateBindSafety } from "../daemon/auth.ts";
import * as path from "@std/path";
import { existsSync } from "@std/fs";

/**
 * Start the daemon server in the current process.
 * This is what both foreground CLI mode and the compiled binary use.
 */
export async function startDaemonInProcess(
  teamDir: string,
  port: number,
  hostname: string,
): Promise<void> {
  // Ensure team directory exists
  if (!existsSync(teamDir)) {
    Deno.mkdirSync(teamDir, { recursive: true });
  }

  // Check if another daemon is already running
  const existing = isAlreadyRunning(teamDir);
  if (existing.running) {
    console.error(
      `❌ Daemon already running (PID ${existing.pid}). Stop it first or remove ${teamDir}/daemon.pid`,
    );
    Deno.exit(1);
  }

  // Create the app and store
  let app, store;
  try {
    const ctx = createApp(teamDir);
    app = ctx.app;
    store = ctx.store;
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`❌ Failed to initialize daemon: ${msg}`);
    console.error(`   Team dir: ${teamDir}`);
    if (msg.includes("Cannot read properties") || msg.includes("undefined")) {
      console.error(`   This likely means config.json is missing required fields. Try running: mpt upgrade`);
    } else {
      console.error(`   This often means SQLite failed to load. Ensure libsqlite3 is available.`);
    }
    console.error(`   Check daemon.log in the team directory for details.`);
    Deno.exit(1);
  }

  // Validate bind safety: refuse 0.0.0.0 without a token
  const configPath = path.join(teamDir, "config.json");
  const configToken = existsSync(configPath)
    ? (JSON.parse(Deno.readTextFileSync(configPath)).apiToken as string | undefined)
    : undefined;
  const token = resolveToken(configToken);
  const bindCheck = validateBindSafety(hostname, token);
  if (!bindCheck.safe) {
    console.error(`❌ ${bindCheck.reason}`);
    Deno.exit(1);
  }

  // Start the HTTP server
  const server = Deno.serve({ port, hostname }, app.fetch);

  // Write PID file
  const pidFile = writePidFile(teamDir);

  // Set up graceful shutdown context
  const ctx: DaemonContext = { store, server, teamDir, pidFile };
  registerSignalHandlers(ctx);

  console.log(`🍕 my-pizza-team daemon listening on http://localhost:${port}`);
  console.log(`   PID: ${Deno.pid} (${pidFile})`);
  console.log(`   Team dir: ${teamDir}`);
  console.log(`   Press Ctrl+C to stop.`);

  // Keep alive — wait for server to close
  await server.finished;
}
