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

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import type { Store } from "./store.ts";

const PID_FILENAME = "daemon.pid";
/** A background daemon's output; the previous run's is kept as `daemon.log.1`. */
export const LOG_FILENAME = "daemon.log";

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
  try { Deno.renameSync(logPath, `${logPath}.1`); } catch { /* no previous log */ }
  const file = Deno.openSync(logPath, { write: true, create: true, truncate: true });
  const encoder = new TextEncoder();
  const write = (level: string, args: unknown[]) => {
    // Leading newlines are terminal spacing; in a log they'd split a line from its timestamp.
    const text = args.map((a) => (typeof a === "string" ? a : Deno.inspect(a, { colors: false, depth: 6 }))).join(" ").replace(/^\n+/, "");
    try {
      file.writeSync(encoder.encode(`${new Date().toISOString()} ${level} ${text}\n`));
    } catch { /* a full disk must not take the daemon down */ }
  };
  console.log = (...a: unknown[]) => write("info ", a);
  console.info = (...a: unknown[]) => write("info ", a);
  console.debug = (...a: unknown[]) => write("debug", a);
  console.warn = (...a: unknown[]) => write("warn ", a);
  console.error = (...a: unknown[]) => write("error", a);
  globalThis.addEventListener("error", (e) => write("fatal", [e.error ?? e.message]));
  globalThis.addEventListener("unhandledrejection", (e) => write("fatal", ["unhandled rejection:", e.reason]));
  return logPath;
}
