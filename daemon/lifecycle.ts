/**
 * daemon/lifecycle.ts — Process lifecycle management for the daemon.
 *
 * Handles:
 * - PID file creation and cleanup
 * - Signal handling (SIGTERM, SIGINT) for graceful shutdown
 * - State flushing (Store.flushToDisk + Store.close) on exit
 *
 * The PID file is written to <teamDir>/daemon.pid on start and removed on stop.
 * This allows CLI tools to detect if the daemon is running and send signals.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import type { Store } from "./store.ts";

const PID_FILENAME = "daemon.pid";

export interface DaemonContext {
  store: Store | null;
  server: Deno.HttpServer | null;
  teamDir: string;
  pidFile: string;
}

/** Write the PID file. Returns the path written. */
export function writePidFile(teamDir: string): string {
  const pidFile = path.join(teamDir, PID_FILENAME);
  Deno.writeTextFileSync(pidFile, String(Deno.pid));
  return pidFile;
}

/** Remove the PID file if it exists and contains our PID. */
export function removePidFile(pidFile: string): void {
  try {
    if (existsSync(pidFile)) {
      const content = Deno.readTextFileSync(pidFile).trim();
      // Only remove if it's our PID (safety check)
      if (content === String(Deno.pid)) {
        Deno.removeSync(pidFile);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

/** Check if another daemon is already running by reading the PID file. */
export function isAlreadyRunning(teamDir: string): { running: boolean; pid?: number } {
  const pidFile = path.join(teamDir, PID_FILENAME);
  if (!existsSync(pidFile)) return { running: false };

  try {
    const pid = parseInt(Deno.readTextFileSync(pidFile).trim(), 10);
    if (isNaN(pid)) return { running: false };

    // Check if process exists by sending signal 0 (no-op, just checks existence)
    try {
      Deno.kill(pid, "SIGCONT");
      return { running: true, pid };
    } catch {
      // Process doesn't exist — stale PID file
      removePidFile(pidFile);
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

/**
 * Perform graceful shutdown:
 * 1. Stop the HTTP server
 * 2. Flush dirty tasks to disk
 * 3. Close the database
 * 4. Remove the PID file
 */
export function shutdown(ctx: DaemonContext): void {
  console.log("\n🛑 Shutting down...");

  try {
    if (ctx.server) {
      ctx.server.shutdown();
    }
  } catch {
    // Server may already be closed
  }

  try {
    if (ctx.store) {
      ctx.store.close(); // flushes + stops timers + closes DB
    }
  } catch (e) {
    console.error("Error during store close:", e);
  }

  removePidFile(ctx.pidFile);
  console.log("✅ Daemon stopped cleanly.");
}

/**
 * Register signal handlers for graceful shutdown.
 * SIGTERM (from `kill`) and SIGINT (from Ctrl+C) both trigger shutdown.
 */
export function registerSignalHandlers(ctx: DaemonContext): void {
  const handler = () => {
    shutdown(ctx);
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGTERM", handler);
  Deno.addSignalListener("SIGINT", handler);
}
