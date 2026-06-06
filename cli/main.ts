/**
 * cli/main.ts — CLI entry point for the mpt command.
 *
 * Subcommands:
 *   mpt start [--daemon]  — Start the daemon (foreground by default, --daemon to background)
 *   mpt stop              — Send SIGTERM to running daemon
 *   mpt status            — Check if daemon is running + show summary from /api/status
 *
 * Uses Deno's built-in arg parsing (Deno.args). The team directory defaults
 * to .pi-pizza-team in the current working directory (override with TEAM_DIR env).
 */

import { TEAM_DIR } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";
import { install, uninstall } from "./service.ts";
import { migrate, printMigrationResult } from "./migrate.ts";

const VERSION = "0.1.0";
const PID_FILENAME = "daemon.pid";

function getTeamDir(): string {
  return Deno.env.get("TEAM_DIR") || path.join(Deno.cwd(), TEAM_DIR);
}

function getPort(): number {
  return Number(Deno.env.get("PORT") ?? 7437);
}

function getPidFile(teamDir: string): string {
  return path.join(teamDir, PID_FILENAME);
}

/** Read PID from file, return null if missing/invalid */
function readPid(teamDir: string): number | null {
  const pidFile = getPidFile(teamDir);
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(Deno.readTextFileSync(pidFile).trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Check if a process with given PID is alive */
function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

// --- Subcommands ---

async function cmdStart(args: string[]): Promise<void> {
  const daemonize = args.includes("--daemon") || args.includes("-d");
  const teamDir = getTeamDir();
  const port = getPort();

  // Check if already running
  const pid = readPid(teamDir);
  if (pid && isProcessAlive(pid)) {
    console.error(`❌ Daemon already running (PID ${pid}).`);
    Deno.exit(1);
  }

  if (daemonize) {
    // Spawn daemon/main.ts as a detached subprocess
    console.log(`Starting daemon in background...`);
    const mainPath = path.join(path.dirname(path.fromFileUrl(import.meta.url)), "..", "daemon", "main.ts");

    const cmd = new Deno.Command("deno", {
      args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", "--allow-run", mainPath],
      env: { TEAM_DIR: teamDir, PORT: String(port) },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });

    const child = cmd.spawn();
    // Detach — don't wait for it
    child.unref();

    // Wait briefly for PID file to appear
    await new Promise(r => setTimeout(r, 500));
    const newPid = readPid(teamDir);
    if (newPid) {
      console.log(`✅ Daemon started (PID ${newPid}) on http://localhost:${port}`);
    } else {
      console.log(`⚠️  Daemon process spawned but PID file not yet written. Check logs.`);
    }
  } else {
    // Foreground mode — exec the daemon directly
    console.log(`Starting daemon in foreground on http://localhost:${port}...`);
    const mainPath = path.join(path.dirname(path.fromFileUrl(import.meta.url)), "..", "daemon", "main.ts");

    const cmd = new Deno.Command("deno", {
      args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", "--allow-run", mainPath],
      env: { ...Object.fromEntries(Object.entries(Deno.env.toObject())), TEAM_DIR: teamDir, PORT: String(port) },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const status = await cmd.spawn().status;
    Deno.exit(status.code);
  }
}

function cmdStop(): void {
  const teamDir = getTeamDir();
  const pid = readPid(teamDir);

  if (!pid) {
    console.log("No daemon is running (no PID file found).");
    Deno.exit(0);
  }

  if (!isProcessAlive(pid)) {
    console.log(`Stale PID file (process ${pid} not found). Cleaning up.`);
    try { Deno.removeSync(getPidFile(teamDir)); } catch { /* */ }
    Deno.exit(0);
  }

  console.log(`Sending SIGTERM to daemon (PID ${pid})...`);
  try {
    Deno.kill(pid, "SIGTERM");
    console.log("✅ Stop signal sent. Daemon should shut down gracefully.");
  } catch (e) {
    console.error(`❌ Failed to send signal: ${(e as Error).message}`);
    Deno.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  const teamDir = getTeamDir();
  const port = getPort();
  const pid = readPid(teamDir);

  if (!pid || !isProcessAlive(pid)) {
    console.log("🔴 Daemon is not running.");
    if (pid) {
      console.log(`   (Stale PID file for process ${pid})`);
    }
    Deno.exit(1);
  }

  console.log(`🟢 Daemon is running (PID ${pid})`);
  console.log(`   Team dir: ${teamDir}`);

  // Try to fetch status from API
  try {
    const res = await fetch(`http://localhost:${port}/api/status`);
    if (res.ok) {
      const data = await res.json();
      console.log(`   Port: ${port}`);
      console.log(`   Stories: ${data.stories.open} open, ${data.stories.done} done (${data.stories.total} total)`);
      console.log(`   Tasks: ${data.tasks.total} total`);
      console.log(`   Members: ${data.members.total} (${data.members.working} working, ${data.members.idle} idle)`);
      console.log(`   Inbox: ${data.inbox} items needing attention`);
    } else {
      console.log(`   ⚠️  API responded with HTTP ${res.status}`);
    }
  } catch {
    console.log(`   ⚠️  Cannot reach API at http://localhost:${port}`);
  }
}

function cmdUpgrade(): void {
  const teamDir = getTeamDir();
  const result = migrate(teamDir);
  printMigrationResult(result);
}

async function cmdInstall(): Promise<void> {
  const teamDir = getTeamDir();
  const port = getPort();
  await install(teamDir, port);
}

async function cmdUninstall(): Promise<void> {
  await uninstall();
}

function printHelp(): void {
  console.log(`mpt v${VERSION} — my-pizza-team CLI

Usage:
  mpt <command> [options]

Commands:
  start [--daemon|-d]   Start the daemon (foreground, or background with --daemon)
  stop                  Stop the running daemon (sends SIGTERM)
  status                Check if daemon is running and show summary
  upgrade               Migrate team dir from extension-only era to daemon format
  install               Install as system service (auto-start on login)
  uninstall             Remove system service and disable auto-start

Environment:
  TEAM_DIR              Team directory (default: ./${TEAM_DIR})
  PORT                  Daemon port (default: 7437)

Examples:
  mpt start             # Start in foreground (Ctrl+C to stop)
  mpt start --daemon    # Start in background
  mpt status            # Check if running
  mpt stop              # Graceful shutdown
  mpt upgrade           # Migrate old .pi-pizza-team/ to current format
  mpt install           # Install as launchd/systemd service
  mpt uninstall         # Remove service
`);
}

// --- Main ---

if (import.meta.main) {
  const args = Deno.args;
  const command = args[0];

  switch (command) {
    case "start":
      await cmdStart(args.slice(1));
      break;
    case "stop":
      cmdStop();
      break;
    case "status":
      await cmdStatus();
      break;
    case "upgrade":
      cmdUpgrade();
      break;
    case "install":
      await cmdInstall();
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    case "--help":
    case "-h":
    case "help":
      printHelp();
      break;
    case "--version":
    case "-v":
      console.log(`mpt v${VERSION}`);
      break;
    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      printHelp();
      Deno.exit(command ? 1 : 0);
  }
}
