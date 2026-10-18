/**
 * cli/service.ts — Platform service installer/uninstaller.
 *
 * Generates and installs:
 * - macOS: user-level launchd plist (~/.local/share/my-pizza-team/com.my-pizza-team.daemon.plist)
 *          symlinked into ~/Library/LaunchAgents/
 * - Linux: user-level systemd unit (~/.config/systemd/user/my-pizza-team.service)
 *
 * Enables auto-start on login. `mpt uninstall` removes the service and disables auto-start.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { existsSync } from "node:fs";

/** This module's directory (`import.meta.dirname`, spelled so Deno's types accept it too). */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SERVICE_LABEL = "com.my-pizza-team.daemon";
const SYSTEMD_UNIT_NAME = "my-pizza-team.service";

/** Detect the current platform */
function getPlatform(): "darwin" | "linux" {
  const os = process.platform;
  if (os === "darwin") return "darwin";
  if (os === "linux") return "linux";
  throw new Error(`Unsupported platform: ${os}. Only macOS and Linux are supported.`);
}

/** Run a service-manager command, capturing stderr. Never throws: a missing
 *  launchctl/systemctl reads as a failed command, with the reason as stderr. */
function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, _stdout, stderr) => {
      if (!err) return resolve({ code: 0, stderr });
      const code = typeof err.code === "number" ? err.code : 1;
      resolve({ code, stderr: stderr || err.message });
    });
  });
}

/**
 * The argv the service runs: this Node binary, the CLI entry script, `start`.
 *
 * `process.execPath` as-is, never symlink-resolved, so a stable launcher path
 * such as /opt/homebrew/bin/node survives `brew upgrade`.
 *
 * TODO(node-runtime): use the saved Node (~/.config/mpt/runtime.json, MPT_NODE,
 * --node) instead of `process.execPath`, and the installed package's compiled
 * entry point when running from the npm package.
 */
export function serviceProgramArguments(): string[] {
  return [process.execPath, cliEntryScript(), "start"];
}

/** Absolute path to the CLI entry script beside this module (cli/main.ts, or main.js once compiled). */
function cliEntryScript(): string {
  const ts = path.join(HERE, "main.ts");
  return existsSync(ts) ? ts : path.join(HERE, "main.js");
}

/**
 * Environment the service runs with. TEAM_DIR and PORT pick the team; PATH is
 * captured from the installing shell, because launchd and systemd start services
 * with a bare system PATH, and the daemon must still find tmux, pi, git, … .
 */
function serviceEnv(teamDir: string, port: number): Array<[string, string]> {
  const env: Array<[string, string]> = [["TEAM_DIR", teamDir], ["PORT", String(port)]];
  const pathVar = process.env["PATH"];
  if (pathVar) env.push(["PATH", pathVar]);
  return env;
}

// --- macOS launchd ---

/** Generate a launchd plist XML for the daemon */
export function generateLaunchdPlist(opts: {
  teamDir: string;
  port: number;
  logDir: string;
}): string {
  const programArgs = `    <array>
${serviceProgramArguments().map((a) => `      <string>${a}</string>`).join("\n")}
    </array>`;
  const envEntries = serviceEnv(opts.teamDir, opts.port)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>

  <key>ProgramArguments</key>
${programArgs}

  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${path.join(opts.logDir, "daemon.stdout.log")}</string>

  <key>StandardErrorPath</key>
  <string>${path.join(opts.logDir, "daemon.stderr.log")}</string>

  <key>WorkingDirectory</key>
  <string>${opts.teamDir}</string>
</dict>
</plist>
`;
}

function getLaunchAgentsDir(): string {
  const home = process.env["HOME"];
  if (!home) throw new Error("HOME environment variable not set");
  return path.join(home, "Library", "LaunchAgents");
}

function getPlistPath(): string {
  return path.join(getLaunchAgentsDir(), `${SERVICE_LABEL}.plist`);
}

async function installLaunchd(teamDir: string, port: number): Promise<void> {
  const home = process.env["HOME"]!;
  const logDir = path.join(home, ".local", "share", "my-pizza-team", "logs");

  // Ensure log directory exists
  if (!existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Ensure LaunchAgents directory exists
  const launchAgentsDir = getLaunchAgentsDir();
  if (!existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  const plistContent = generateLaunchdPlist({ teamDir, port, logDir });
  const plistPath = getPlistPath();

  // Write plist file
  fs.writeFileSync(plistPath, plistContent);
  console.log(`✅ Wrote launchd plist: ${plistPath}`);

  // Load the service
  const result = await run("launchctl", ["load", "-w", plistPath]);

  if (result.code === 0) {
    console.log(`✅ Service loaded and enabled (auto-start on login)`);
    console.log(`   Label: ${SERVICE_LABEL}`);
    console.log(`   Logs:  ${logDir}/`);
    console.log(`\n   Manage with:`);
    console.log(`     launchctl stop ${SERVICE_LABEL}    # stop`);
    console.log(`     launchctl start ${SERVICE_LABEL}   # start`);
    console.log(`     mpt uninstall                      # remove completely`);
  } else {
    const stderr = result.stderr;
    console.error(`⚠️  Plist written but launchctl load failed: ${stderr.trim()}`);
    console.log(`   You can manually load with: launchctl load -w ${plistPath}`);
  }
}

async function uninstallLaunchd(): Promise<void> {
  const plistPath = getPlistPath();

  if (!existsSync(plistPath)) {
    console.log("No launchd service installed (plist not found).");
    return;
  }

  // Unload the service
  const result = await run("launchctl", ["unload", "-w", plistPath]);

  if (result.code !== 0) {
    const stderr = result.stderr;
    console.warn(`⚠️  launchctl unload warning: ${stderr.trim()}`);
  }

  // Remove plist file
  try {
    fs.rmSync(plistPath);
    console.log(`✅ Removed plist: ${plistPath}`);
  } catch (e) {
    console.error(`❌ Failed to remove plist: ${(e as Error).message}`);
  }

  console.log(`✅ Service uninstalled. Auto-start disabled.`);
}

// --- Linux systemd ---

/** Generate a systemd user unit file */
export function generateSystemdUnit(opts: {
  teamDir: string;
  port: number;
}): string {
  // systemd splits ExecStart on whitespace; quote any argument that contains it.
  const execStart = serviceProgramArguments().map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  const environment = serviceEnv(opts.teamDir, opts.port).map(([k, v]) => `Environment="${k}=${v}"`).join("\n");

  return `[Unit]
Description=my-pizza-team daemon
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
${environment}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function getSystemdUserDir(): string {
  const home = process.env["HOME"];
  if (!home) throw new Error("HOME environment variable not set");
  return path.join(home, ".config", "systemd", "user");
}

function getUnitPath(): string {
  return path.join(getSystemdUserDir(), SYSTEMD_UNIT_NAME);
}

async function installSystemd(teamDir: string, port: number): Promise<void> {
  const unitDir = getSystemdUserDir();

  // Ensure unit directory exists
  if (!existsSync(unitDir)) {
    fs.mkdirSync(unitDir, { recursive: true });
  }

  const unitContent = generateSystemdUnit({ teamDir, port });
  const unitPath = getUnitPath();

  // Write unit file
  fs.writeFileSync(unitPath, unitContent);
  console.log(`✅ Wrote systemd unit: ${unitPath}`);

  // Reload systemd daemon
  await run("systemctl", ["--user", "daemon-reload"]);

  // Enable and start the service
  const result = await run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME]);

  if (result.code === 0) {
    console.log(`✅ Service enabled and started (auto-start on login)`);
    console.log(`   Unit: ${SYSTEMD_UNIT_NAME}`);
    console.log(`\n   Manage with:`);
    console.log(`     systemctl --user stop ${SYSTEMD_UNIT_NAME}`);
    console.log(`     systemctl --user start ${SYSTEMD_UNIT_NAME}`);
    console.log(`     systemctl --user status ${SYSTEMD_UNIT_NAME}`);
    console.log(`     journalctl --user -u ${SYSTEMD_UNIT_NAME}`);
    console.log(`     mpt uninstall    # remove completely`);
  } else {
    const stderr = result.stderr;
    console.error(`⚠️  Unit written but enable failed: ${stderr.trim()}`);
    console.log(`   You can manually enable with: systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`);
  }

  // Enable lingering so user services start without login session
  const lingerResult = await run("loginctl", ["enable-linger"]);
  if (lingerResult.code === 0) {
    console.log(`   Lingering enabled (service starts even without active login session)`);
  }
}

async function uninstallSystemd(): Promise<void> {
  const unitPath = getUnitPath();

  if (!existsSync(unitPath)) {
    console.log("No systemd service installed (unit file not found).");
    return;
  }

  // Stop and disable the service
  const result = await run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME]);

  if (result.code !== 0) {
    const stderr = result.stderr;
    console.warn(`⚠️  systemctl disable warning: ${stderr.trim()}`);
  }

  // Remove unit file
  try {
    fs.rmSync(unitPath);
    console.log(`✅ Removed unit file: ${unitPath}`);
  } catch (e) {
    console.error(`❌ Failed to remove unit file: ${(e as Error).message}`);
  }

  // Reload daemon
  await run("systemctl", ["--user", "daemon-reload"]);

  console.log(`✅ Service uninstalled. Auto-start disabled.`);
}

// --- Public API ---

/**
 * Install the mpt daemon as a system service (auto-start on login).
 * Detects platform and generates appropriate service configuration.
 */
export async function install(teamDir: string, port: number): Promise<void> {
  const platform = getPlatform();
  console.log(`Installing mpt daemon as ${platform === "darwin" ? "launchd" : "systemd"} service...`);
  console.log(`   Team dir: ${teamDir}`);
  console.log(`   Port: ${port}`);
  console.log();

  if (platform === "darwin") {
    await installLaunchd(teamDir, port);
  } else {
    await installSystemd(teamDir, port);
  }
}

/**
 * Uninstall the mpt daemon service and disable auto-start.
 */
export async function uninstall(): Promise<void> {
  const platform = getPlatform();
  console.log(`Uninstalling mpt daemon ${platform === "darwin" ? "launchd" : "systemd"} service...`);
  console.log();

  if (platform === "darwin") {
    await uninstallLaunchd();
  } else {
    await uninstallSystemd();
  }
}

/** What an installed service launches: `<node> <entry script> start`. */
export interface ServiceProgram {
  /** The Node binary (first argument). */
  node: string;
  /** The mpt CLI entry script (second argument), or null if the service has none. */
  entry: string | null;
}

/** Info about an installed daemon service, used by `mpt upgrade` to restart the
 *  right thing after upgrading. */
export interface InstalledService {
  manager: "launchd" | "systemd";
  /** What the service launches (best-effort parse), or null if unreadable. */
  programPath: ServiceProgram | null;
  /** Restart the service; resolves true on success. */
  restart: () => Promise<boolean>;
  /** Human-readable restart command (printed when auto-restart fails). */
  restartHint: string;
}

/** `[node, entry, ...]` → ServiceProgram. An older install launched the compiled
 *  binary directly (`[mpt, "start"]`), which has no entry script. */
function toProgram(argv: string[]): ServiceProgram | null {
  const [node, second] = argv;
  if (!node) return null;
  const entry = second && /\.(ts|js|mjs)$/.test(second) ? second : null;
  return { node, entry };
}

/**
 * Detect an installed mpt service (launchd plist / systemd unit) on this host.
 * Returns null when none is installed (or the platform is unsupported).
 */
export function detectInstalledService(): InstalledService | null {
  const os = process.platform;
  if (os === "darwin") {
    const plistPath = getPlistPath();
    if (!existsSync(plistPath)) return null;
    let programPath: ServiceProgram | null = null;
    try {
      const xml = fs.readFileSync(plistPath, "utf8");
      // The <string>s inside ProgramArguments: the executable, then its arguments.
      const array = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
      programPath = toProgram([...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!));
    } catch { /* ignore */ }
    const uid = process.getuid?.() ?? null;
    const target = uid != null ? `gui/${uid}/${SERVICE_LABEL}` : SERVICE_LABEL;
    return {
      manager: "launchd",
      programPath,
      restart: async () => {
        // kickstart -k restarts the (possibly running) service in place.
        const r = await run("launchctl", ["kickstart", "-k", target]);
        return r.code === 0;
      },
      restartHint: `launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}`,
    };
  }
  if (os === "linux") {
    const unitPath = getUnitPath();
    if (!existsSync(unitPath)) return null;
    let programPath: ServiceProgram | null = null;
    try {
      const unit = fs.readFileSync(unitPath, "utf8");
      const line = unit.match(/^ExecStart=(.*)$/m)?.[1] ?? "";
      // Arguments are space-separated, double-quoted when they contain spaces.
      programPath = toProgram([...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!));
    } catch { /* ignore */ }
    return {
      manager: "systemd",
      programPath,
      restart: async () => {
        const r = await run("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]);
        return r.code === 0;
      },
      restartHint: `systemctl --user restart ${SYSTEMD_UNIT_NAME}`,
    };
  }
  return null;
}
