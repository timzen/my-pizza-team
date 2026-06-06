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

import * as path from "jsr:@std/path@^1";
import { existsSync } from "jsr:@std/fs@^1/exists";

const SERVICE_LABEL = "com.my-pizza-team.daemon";
const SYSTEMD_UNIT_NAME = "my-pizza-team.service";

/** Detect the current platform */
function getPlatform(): "darwin" | "linux" {
  const os = Deno.build.os;
  if (os === "darwin") return "darwin";
  if (os === "linux") return "linux";
  throw new Error(`Unsupported platform: ${os}. Only macOS and Linux are supported.`);
}

/** Resolve the path to the mpt executable (compiled binary or deno task) */
function getMptExecutablePath(): string {
  // If running as compiled binary, use the binary path
  if (Deno.execPath().endsWith("mpt")) {
    return Deno.execPath();
  }
  // Otherwise, find the project root (parent of cli/)
  const projectRoot = path.dirname(path.dirname(path.fromFileUrl(import.meta.url)));
  return projectRoot;
}

/** Get the deno executable path */
function getDenoPath(): string {
  // When running via deno, Deno.execPath() gives us the deno binary
  if (!Deno.execPath().endsWith("mpt")) {
    return Deno.execPath();
  }
  // Fallback: try to find deno in PATH
  return "deno";
}

// --- macOS launchd ---

/** Generate a launchd plist XML for the daemon */
function generateLaunchdPlist(opts: {
  teamDir: string;
  port: number;
  logDir: string;
}): string {
  const isCompiled = Deno.execPath().endsWith("mpt");
  const projectRoot = path.dirname(path.dirname(path.fromFileUrl(import.meta.url)));

  let programArgs: string;
  if (isCompiled) {
    programArgs = `    <array>
      <string>${Deno.execPath()}</string>
      <string>start</string>
    </array>`;
  } else {
    const denoPath = getDenoPath();
    const daemonMain = path.join(projectRoot, "daemon", "main.ts");
    programArgs = `    <array>
      <string>${denoPath}</string>
      <string>run</string>
      <string>--allow-net</string>
      <string>--allow-read</string>
      <string>--allow-write</string>
      <string>--allow-env</string>
      <string>--allow-ffi</string>
      <string>--allow-run</string>
      <string>${daemonMain}</string>
    </array>`;
  }

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
    <key>TEAM_DIR</key>
    <string>${opts.teamDir}</string>
    <key>PORT</key>
    <string>${opts.port}</string>
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
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME environment variable not set");
  return path.join(home, "Library", "LaunchAgents");
}

function getPlistPath(): string {
  return path.join(getLaunchAgentsDir(), `${SERVICE_LABEL}.plist`);
}

async function installLaunchd(teamDir: string, port: number): Promise<void> {
  const home = Deno.env.get("HOME")!;
  const logDir = path.join(home, ".local", "share", "my-pizza-team", "logs");

  // Ensure log directory exists
  if (!existsSync(logDir)) {
    Deno.mkdirSync(logDir, { recursive: true });
  }

  // Ensure LaunchAgents directory exists
  const launchAgentsDir = getLaunchAgentsDir();
  if (!existsSync(launchAgentsDir)) {
    Deno.mkdirSync(launchAgentsDir, { recursive: true });
  }

  const plistContent = generateLaunchdPlist({ teamDir, port, logDir });
  const plistPath = getPlistPath();

  // Write plist file
  Deno.writeTextFileSync(plistPath, plistContent);
  console.log(`✅ Wrote launchd plist: ${plistPath}`);

  // Load the service
  const cmd = new Deno.Command("launchctl", {
    args: ["load", "-w", plistPath],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();

  if (result.code === 0) {
    console.log(`✅ Service loaded and enabled (auto-start on login)`);
    console.log(`   Label: ${SERVICE_LABEL}`);
    console.log(`   Logs:  ${logDir}/`);
    console.log(`\n   Manage with:`);
    console.log(`     launchctl stop ${SERVICE_LABEL}    # stop`);
    console.log(`     launchctl start ${SERVICE_LABEL}   # start`);
    console.log(`     mpt uninstall                      # remove completely`);
  } else {
    const stderr = new TextDecoder().decode(result.stderr);
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
  const cmd = new Deno.Command("launchctl", {
    args: ["unload", "-w", plistPath],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();

  if (result.code !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    console.warn(`⚠️  launchctl unload warning: ${stderr.trim()}`);
  }

  // Remove plist file
  try {
    Deno.removeSync(plistPath);
    console.log(`✅ Removed plist: ${plistPath}`);
  } catch (e) {
    console.error(`❌ Failed to remove plist: ${(e as Error).message}`);
  }

  console.log(`✅ Service uninstalled. Auto-start disabled.`);
}

// --- Linux systemd ---

/** Generate a systemd user unit file */
function generateSystemdUnit(opts: {
  teamDir: string;
  port: number;
}): string {
  const isCompiled = Deno.execPath().endsWith("mpt");
  const projectRoot = path.dirname(path.dirname(path.fromFileUrl(import.meta.url)));

  let execStart: string;
  if (isCompiled) {
    execStart = `${Deno.execPath()} start`;
  } else {
    const denoPath = getDenoPath();
    const daemonMain = path.join(projectRoot, "daemon", "main.ts");
    execStart = `${denoPath} run --allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-run ${daemonMain}`;
  }

  return `[Unit]
Description=my-pizza-team daemon
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Environment=TEAM_DIR=${opts.teamDir}
Environment=PORT=${opts.port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function getSystemdUserDir(): string {
  const home = Deno.env.get("HOME");
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
    Deno.mkdirSync(unitDir, { recursive: true });
  }

  const unitContent = generateSystemdUnit({ teamDir, port });
  const unitPath = getUnitPath();

  // Write unit file
  Deno.writeTextFileSync(unitPath, unitContent);
  console.log(`✅ Wrote systemd unit: ${unitPath}`);

  // Reload systemd daemon
  const reload = new Deno.Command("systemctl", {
    args: ["--user", "daemon-reload"],
    stdout: "piped",
    stderr: "piped",
  });
  await reload.output();

  // Enable and start the service
  const enable = new Deno.Command("systemctl", {
    args: ["--user", "enable", "--now", SYSTEMD_UNIT_NAME],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await enable.output();

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
    const stderr = new TextDecoder().decode(result.stderr);
    console.error(`⚠️  Unit written but enable failed: ${stderr.trim()}`);
    console.log(`   You can manually enable with: systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`);
  }

  // Enable lingering so user services start without login session
  const linger = new Deno.Command("loginctl", {
    args: ["enable-linger"],
    stdout: "piped",
    stderr: "piped",
  });
  const lingerResult = await linger.output();
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
  const disable = new Deno.Command("systemctl", {
    args: ["--user", "disable", "--now", SYSTEMD_UNIT_NAME],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await disable.output();

  if (result.code !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    console.warn(`⚠️  systemctl disable warning: ${stderr.trim()}`);
  }

  // Remove unit file
  try {
    Deno.removeSync(unitPath);
    console.log(`✅ Removed unit file: ${unitPath}`);
  } catch (e) {
    console.error(`❌ Failed to remove unit file: ${(e as Error).message}`);
  }

  // Reload daemon
  const reload = new Deno.Command("systemctl", {
    args: ["--user", "daemon-reload"],
    stdout: "piped",
    stderr: "piped",
  });
  await reload.output();

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
