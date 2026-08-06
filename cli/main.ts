/**
 * cli/main.ts — The mpt CLI: argument parsing + subcommand routing.
 *
 * Exposes a callable `main()` used by the compiled binary entry point
 * (root main.ts) and runs directly under `deno run cli/main.ts`.
 */

import { TEAM_DIR } from "../shared/types.ts";
import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { install, uninstall, detectInstalledService } from "./service.ts";
import { generateToken } from "../daemon/auth.ts";
import { startDaemonInProcess } from "./start-daemon.ts";
// Single source of truth for the version: the package manifest. Bundled into
// the compiled binary by `deno compile` (JSON imports are part of the module
// graph), and read directly under `deno run`.
import denoConfig from "../deno.json" with { type: "json" };

const VERSION = denoConfig.version;
const PID_FILENAME = "daemon.pid";
// Self-update source: the GitHub repo whose Releases carry per-platform mpt
// binaries (see .github/workflows/release.yml + scripts/build.sh).
const RELEASE_REPO = "timzen/my-pizza-team";

function getTeamDir(): string {
  const envDir = Deno.env.get("TEAM_DIR");
  if (envDir) {
    if (envDir.endsWith(TEAM_DIR)) return envDir;
    if (existsSync(path.join(envDir, TEAM_DIR))) return path.join(envDir, TEAM_DIR);
    return envDir;
  }
  return path.join(Deno.cwd(), TEAM_DIR);
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

// --- Self-update (`mpt upgrade`) ---

/** Map the running platform to its release asset name, or null if unsupported. */
function releaseAssetName(): string | null {
  const os = Deno.build.os;      // "darwin" | "linux" | "windows"
  const arch = Deno.build.arch;  // "x86_64" | "aarch64"
  if (os === "darwin" && arch === "aarch64") return "mpt-darwin-arm64";
  if (os === "darwin" && arch === "x86_64") return "mpt-darwin-x64";
  if (os === "linux" && arch === "x86_64") return "mpt-linux-x64";
  if (os === "linux" && arch === "aarch64") return "mpt-linux-arm64";
  if (os === "windows" && arch === "x86_64") return "mpt-windows-x64.exe";
  return null;
}

/** True if `latest` (X.Y.Z) is strictly newer than `current` (X.Y.Z). */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer so the type satisfies BufferSource<ArrayBuffer>.
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Download the latest release binary for this platform and replace the running
 * executable in place. `--check` only reports whether an update is available.
 *
 * Only meaningful for the compiled binary; when running under `deno run` the
 * executable is `deno` itself, so we bail with build instructions instead.
 */
async function cmdUpgrade(args: string[]): Promise<void> {
  const checkOnly = args.includes("--check");
  const execPath = Deno.execPath();

  // Guard: running from source (deno run) — there's no mpt binary to replace.
  const execBase = path.basename(execPath).toLowerCase();
  if (execBase === "deno" || execBase === "deno.exe") {
    console.error("⚠️  Running from source (deno run), not the compiled binary — nothing to upgrade.");
    console.error("    Build the latest from source instead: deno task compile");
    Deno.exit(1);
  }

  const asset = releaseAssetName();
  if (!asset) {
    console.error(`❌ No prebuilt mpt binary for your platform (${Deno.build.os}/${Deno.build.arch}).`);
    Deno.exit(1);
  }

  console.log("Checking for the latest release…");
  const apiHeaders = { "Accept": "application/vnd.github+json", "User-Agent": "mpt-cli" };
  let rel: { tag_name?: string; html_url?: string; assets?: Array<{ name: string; browser_download_url: string }> };
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: apiHeaders });
    if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
    rel = await res.json();
  } catch (e) {
    console.error(`❌ Could not check for updates: ${(e as Error).message}`);
    Deno.exit(1);
  }

  const latest = String(rel.tag_name || "").replace(/^v/, "");
  if (!latest) { console.error("❌ Latest release has no version tag."); Deno.exit(1); }

  if (!isNewerVersion(latest, VERSION)) {
    console.log(`✅ Already up to date (v${VERSION}${latest !== VERSION ? `; latest release is v${latest}` : ""}).`);
    return;
  }

  console.log(`⬆️  Update available: v${VERSION} → v${latest}`);
  if (checkOnly) {
    if (rel.html_url) console.log(`   ${rel.html_url}`);
    console.log(`   Run "mpt upgrade" to install.`);
    return;
  }

  const assetObj = (rel.assets || []).find((a) => a.name === asset);
  if (!assetObj) {
    console.error(`❌ Release v${latest} has no asset named "${asset}".`);
    Deno.exit(1);
  }

  console.log(`Downloading ${asset}…`);
  let bytes: Uint8Array;
  try {
    const dl = await fetch(assetObj.browser_download_url, { headers: { "User-Agent": "mpt-cli" } });
    if (!dl.ok) throw new Error(`HTTP ${dl.status}`);
    bytes = new Uint8Array(await dl.arrayBuffer());
  } catch (e) {
    console.error(`❌ Download failed: ${(e as Error).message}`);
    Deno.exit(1);
  }

  // Verify against checksums.sha256 when the release publishes it.
  const sumAsset = (rel.assets || []).find((a) => a.name === "checksums.sha256");
  if (sumAsset) {
    try {
      const sums = await (await fetch(sumAsset.browser_download_url, { headers: { "User-Agent": "mpt-cli" } })).text();
      const want = sums.split("\n").map((l) => l.trim()).find((l) => l.endsWith(asset))?.split(/\s+/)[0];
      if (want) {
        const got = await sha256Hex(bytes);
        if (got !== want) {
          console.error(`❌ Checksum mismatch for ${asset} — refusing to install.`);
          Deno.exit(1);
        }
        console.log("   Checksum verified.");
      }
    } catch {
      console.warn("   ⚠️  Could not verify checksum (continuing).");
    }
  }

  // Replace the running executable. On Unix a running binary can be renamed
  // over atomically (same directory ⇒ same filesystem); on Windows the locked
  // .exe must be moved aside first.
  try {
    if (Deno.build.os === "windows") {
      try { Deno.renameSync(execPath, `${execPath}.old`); } catch { /* best effort */ }
      Deno.writeFileSync(execPath, bytes);
    } else {
      const tmp = path.join(path.dirname(execPath), `.mpt-upgrade-${Date.now()}`);
      Deno.writeFileSync(tmp, bytes, { mode: 0o755 });
      Deno.renameSync(tmp, execPath);
    }
  } catch (e) {
    // Typically a permission error (e.g. installed under /usr/local/bin). Stage
    // the download somewhere writable and print manual install instructions.
    const staged = `${Deno.makeTempDirSync({ prefix: "mpt-upgrade-" })}/${asset}`;
    try { Deno.writeFileSync(staged, bytes, { mode: 0o755 }); } catch { /* ignore */ }
    console.error(`❌ Couldn't replace ${execPath}: ${(e as Error).message}`);
    console.error(`   Downloaded v${latest} to: ${staged}`);
    console.error(`   Install it manually, e.g.:  sudo mv "${staged}" "${execPath}"`);
    Deno.exit(1);
  }

  console.log(`✅ Upgraded to v${latest}.`);

  // If a service manages the daemon, restart it (in-place binary replace leaves
  // the old process running until restarted). The service launches a specific
  // absolute path, so warn if we upgraded a different copy.
  const svc = detectInstalledService();
  if (svc) {
    if (svc.programPath && path.resolve(svc.programPath) !== path.resolve(execPath)) {
      console.log(`\n⚠️  Your ${svc.manager} service runs a different binary:`);
      console.log(`     service:  ${svc.programPath}`);
      console.log(`     upgraded: ${execPath}`);
      console.log(`   Re-run upgrade from that binary, or re-point the service:  mpt install`);
      return;
    }
    console.log(`   Restarting the ${svc.manager} service…`);
    const ok = await svc.restart();
    console.log(ok ? `   ✅ Service restarted on v${latest}.` : `   ⚠️  Couldn't restart automatically. Run:  ${svc.restartHint}`);
  } else {
    console.log(`   Restart the daemon to run the new version:  mpt stop && mpt start --daemon`);
  }
}

function printHelp(): void {
  console.log(`mpt v${VERSION} — my-pizza-team CLI

Usage:
  mpt <command> [options]

Commands:
  start [--daemon|-d]   Start the daemon (foreground, or background with --daemon)
  stop                  Stop the running daemon (sends SIGTERM)
  status                Check if daemon is running and show summary
  rotate-token          Generate a new API token (saved to config.json)
  install               Install as system service (auto-start on login)
  uninstall             Remove system service and disable auto-start
  upgrade [--check]     Update mpt to the latest release (--check only reports)

Environment:
  TEAM_DIR              Team directory (default: ./${TEAM_DIR})
  PORT                  Daemon port (default: 7437)

Examples:
  mpt start             # Start in foreground (Ctrl+C to stop)
  mpt start --daemon    # Start in background
  mpt status            # Check if running
  mpt stop              # Graceful shutdown
  mpt rotate-token      # Generate new API token
  mpt install           # Install as launchd/systemd service
  mpt uninstall         # Remove service
  mpt upgrade           # Self-update to the latest release
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
    case "rotate-token":
      cmdRotateToken();
      break;
    case "install":
      await cmdInstall();
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    case "upgrade":
      await cmdUpgrade(args.slice(1));
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
