/**
 * cli/main.ts — The mpt CLI: argument parsing + subcommand routing.
 *
 * Exposes a callable `main()` used by the compiled binary entry point
 * (root main.ts) and runs directly under `deno run cli/main.ts`.
 */

import { TEAM_DIR, LEGACY_TEAM_DIR } from "../shared/types.ts";
import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { install, uninstall } from "./service.ts";
import { migrate, printMigrationResult } from "./migrate.ts";
import { generateToken } from "../daemon/auth.ts";
import { startDaemonInProcess } from "./start-daemon.ts";

const VERSION = "0.1.0";
const PID_FILENAME = "daemon.pid";

function getTeamDir(): string {
  const envDir = Deno.env.get("TEAM_DIR");
  if (envDir) {
    if (envDir.endsWith(TEAM_DIR) || envDir.endsWith(LEGACY_TEAM_DIR)) return envDir;
    if (existsSync(path.join(envDir, TEAM_DIR))) return path.join(envDir, TEAM_DIR);
    if (existsSync(path.join(envDir, LEGACY_TEAM_DIR))) return path.join(envDir, LEGACY_TEAM_DIR);
    return envDir;
  }
  const primary = path.join(Deno.cwd(), TEAM_DIR);
  if (existsSync(primary)) return primary;
  const legacy = path.join(Deno.cwd(), LEGACY_TEAM_DIR);
  if (existsSync(legacy)) return legacy;
  return primary;
}

function getPort(): number {
  return Number(Deno.env.get("PORT") ?? 7437);
}

function getPidFile(teamDir: string): string {
  return path.join(teamDir, PID_FILENAME);
}

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
  const hostname = Deno.env.get("HOST") || "127.0.0.1";

  // Check if already running
  const pid = readPid(teamDir);
  if (pid && isProcessAlive(pid)) {
    console.error(`❌ Daemon already running (PID ${pid}).`);
    Deno.exit(1);
  }

  if (daemonize) {
    // Background mode: spawn the binary itself with an internal flag
    console.log(`Starting daemon in background...`);

    // Get the path to the current executable
    const execPath = Deno.execPath();

    const cmd = new Deno.Command(execPath, {
      args: ["start", "--foreground-internal"],
      env: { ...Deno.env.toObject(), TEAM_DIR: teamDir, PORT: String(port) },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });

    const child = cmd.spawn();
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
    // Foreground mode: start daemon in-process (works for both compiled and deno run)
    await startDaemonInProcess(teamDir, port, hostname);
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

  try {
    const res = await fetch(`http://localhost:${port}/api/status`);
    if (res.ok) {
      const data = await res.json();
      console.log(`   Port: ${port}`);
      console.log(`   Stories: ${data.stories.open} open, ${data.stories.done} done (${data.stories.total} total)`);
      console.log(`   Tasks: ${data.tasks.total} total`);
      console.log(`   Members: ${data.members.total} (${data.members.working} working, ${data.members.idle} idle)`);
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

function cmdRotateToken(): void {
  const teamDir = getTeamDir();
  const configPath = `${teamDir}/config.json`;

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(Deno.readTextFileSync(configPath));
    } catch {
      console.error("❌ Failed to parse config.json");
      Deno.exit(1);
    }
  } else if (!existsSync(teamDir)) {
    Deno.mkdirSync(teamDir, { recursive: true });
  }

  const token = generateToken();
  config.apiToken = token;
  Deno.writeTextFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`✅ New API token generated and saved to config.json`);
  console.log(`\n   Token: ${token}`);
  console.log(`\n   Use in requests:`);
  console.log(`     Authorization: Bearer ${token}`);
  console.log(`\n   Or set environment:`);
  console.log(`     export MPT_API_TOKEN=${token}`);
  console.log(`\n   ⚠️  Restart the daemon for the new token to take effect.`);
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
  rotate-token          Generate a new API token (saved to config.json)
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
  mpt rotate-token      # Generate new API token
  mpt install           # Install as launchd/systemd service
  mpt uninstall         # Remove service
`);
}

// --- Exported main ---

export async function main(): Promise<void> {
  const args = Deno.args;
  const command = args[0];

  switch (command) {
    case "start":
      // Handle internal flag for daemonized background process
      if (args.includes("--foreground-internal")) {
        const teamDir = getTeamDir();
        const port = getPort();
        const hostname = Deno.env.get("HOST") || "127.0.0.1";
        await startDaemonInProcess(teamDir, port, hostname);
      } else {
        await cmdStart(args.slice(1));
      }
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
    case "rotate-token":
      cmdRotateToken();
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


if (import.meta.main) {
  await main();
}
