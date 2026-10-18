/**
 * daemon/lifecycle.ts — Process lifecycle management for the daemon.
 *
 * Handles:
 * - PID file creation and cleanup
 * - Signal handling (SIGTERM, SIGINT) for graceful shutdown
 * - State flushing (Store.flushToDisk + Store.close) on exit
 * - Logging to <teamDir>/daemon.log when running in the background
 *
 * The PID file is written to <teamDir>/daemon.pid on start and removed on stop.
 * This allows CLI tools to detect if the daemon is running and send signals.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { inspect } from "node:util";
import type { ServerType } from "@hono/node-server";
import type { Store } from "./store.ts";

const PID_FILENAME = "daemon.pid";
/** A background daemon's output; the previous run's is kept as `daemon.log.1`. */
export const LOG_FILENAME = "daemon.log";

export interface DaemonContext {
  store: Store | null;
  server: ServerType | null;
  teamDir: string;
  pidFile: string;
}

/** Write the PID file. Returns the path written. */
export function writePidFile(teamDir: string): string {
  const pidFile = path.join(teamDir, PID_FILENAME);
  fs.writeFileSync(pidFile, String(process.pid));
  return pidFile;
}

/** Remove the PID file if it exists and contains our PID. */
export function removePidFile(pidFile: string): void {
  try {
    if (existsSync(pidFile)) {
      const content = fs.readFileSync(pidFile, "utf8").trim();
      // Only remove if it's our PID (safety check)
      if (content === String(process.pid)) {
        fs.rmSync(pidFile);
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
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (isNaN(pid)) return { running: false };

    // Check if process exists by sending signal 0 (no-op, just checks existence)
    try {
      process.kill(pid, 0);
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
      // Stop accepting, then drop open connections (keep-alive, SSE streams) so
      // nothing holds the close open; the process exits right after anyway.
      ctx.server.close();
      if ("closeAllConnections" in ctx.server) ctx.server.closeAllConnections();
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
    process.exit(0);
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

/**
 * Send this process's console output to `<teamDir>/daemon.log`. Returns its path.
 *
 * For the background daemon `mpt start --daemon` launches: its parent exits
 * straight away, so there is no terminal to print to, and before this everything it
 * said — startup errors included — was lost. The previous run's log is kept as
 * `daemon.log.1`, so a crash can still be read after a restart. Uncaught errors are
 * logged on their way out, since the runtime would print them to the (discarded)
 * stderr. Both files are runtime state, excluded from autosave (store/git-sync.ts).
 */
export function redirectOutputToLog(teamDir: string): string {
  const logPath = path.join(teamDir, LOG_FILENAME);
  try { fs.renameSync(logPath, `${logPath}.1`); } catch { /* no previous log */ }
  const fd = fs.openSync(logPath, "w");
  const write = (level: string, args: unknown[]) => {
    // Leading newlines are terminal spacing; in a log they'd split a line from its timestamp.
    const text = args.map((a) => (typeof a === "string" ? a : inspect(a, { colors: false, depth: 6 }))).join(" ").replace(/^\n+/, "");
    try {
      fs.writeSync(fd, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch { /* a full disk must not take the daemon down */ }
  };
  console.log = (...a: unknown[]) => write("info ", a);
  console.info = (...a: unknown[]) => write("info ", a);
  console.debug = (...a: unknown[]) => write("debug", a);
  console.warn = (...a: unknown[]) => write("warn ", a);
  console.error = (...a: unknown[]) => write("error", a);
  // A monitor only observes: the process still crashes as it would have. Unhandled
  // rejections arrive here too (Node raises them as uncaught exceptions by default).
  process.on("uncaughtExceptionMonitor", (err, origin) => {
    write("fatal", origin === "unhandledRejection" ? ["unhandled rejection:", err] : [err]);
  });
  return logPath;
}
