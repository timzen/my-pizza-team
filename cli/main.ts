/**
 * cli/main.ts — The mpt CLI: argument parsing + subcommand routing.
 *
 * Exposes a callable `main()` used by the root main.ts entry point, and runs
 * directly as `node cli/main.ts`.
 */

import { DEFAULT_CONFIG, DEFAULT_HARNESS, DEFAULT_HARNESS_TEMPLATES, LEADER_WINDOW, TEAM_DIR } from "../shared/types.ts";
import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { install, uninstall, detectInstalledService } from "./service.ts";
import { defaultUpgradeDeps, runUpgrade } from "./upgrade.ts";
import { ensureNodeForCommand } from "./node-choice.ts";
import { configuredNode, extractNodeFlag, setNodeFlagOverride } from "../shared/runtime-config.ts";
import { isRunningFromSource, packageRoot } from "../shared/paths.ts";
import { evaluate, gather, report } from "./doctor.ts";
import {
  listWindows,
  realTmux,
  renderTemplate,
  selectWindow,
  spawnWindow,
  tmuxAvailable,
  unresolvedPlaceholders,
} from "../daemon/tmux.ts";
import { managedExtensionDir, resolveExtensionSourceDir, writeExtension } from "./extension.ts";
import { piAgentDir, readPiSettings } from "./pi-config.ts";
import {
  applyPackageChanges,
  initTeamConfig,
  isNoOp,
  manifestPath,
  planSetup,
  readManifest,
  trustProject,
  writeManifest,
  writePiSettingsFile,
  type SetupPlan,
} from "./setup.ts";
import { generateToken } from "../daemon/auth.ts";
import { resolveTeamDir, startDaemonInProcess } from "../daemon/start.ts";
import { mptInvocation } from "../daemon/self.ts";
import { isMainModule } from "../shared/main-module.ts";
import { cmdAgent, cmdSetupHarness } from "./agent.ts";
import { LOG_FILENAME, redirectOutputToLog } from "../daemon/lifecycle.ts";
import { daemonErrorMessage, type StatusSummaryInput, statusSummaryLines } from "./features.ts";
// Single source of truth for the version: the package manifest (scripts/sync-version.ts
// copies it into the npm manifests).
import denoConfig from "../deno.json" with { type: "json" };

const VERSION = denoConfig.version;
const PID_FILENAME = "daemon.pid";

function getTeamDir(): string {
  return resolveTeamDir();
}

function getPort(): number {
  return Number(process.env["PORT"] ?? 7437);
}

function getPidFile(teamDir: string): string {
  return path.join(teamDir, PID_FILENAME);
}

function readPid(teamDir: string): number | null {
  const pidFile = getPidFile(teamDir);
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 delivers nothing; it only checks that the process exists.
    process.kill(pid, 0);
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
  const hostname = process.env["HOST"] || "127.0.0.1";

  // Check if already running
  const pid = readPid(teamDir);
  if (pid && isProcessAlive(pid)) {
    console.error(`❌ Daemon already running (PID ${pid}).`);
    process.exit(1);
  }

  if (daemonize) {
    // Background mode: re-run this CLI (`node cli/main.ts`) with an internal flag.
    console.log(`Starting daemon in background...`);

    // The child writes its own log (redirectOutputToLog, which also rotates
    // daemon.log): this process exits in a moment, so pipes back to it would be
    // read by nobody. Detached, so it outlives this terminal's process group.
    const [exe, ...exeArgs] = mptInvocation();
    const child = spawn(exe!, [...exeArgs, "start", "--foreground-internal"], {
      env: { ...process.env, TEAM_DIR: teamDir, PORT: String(port) },
      stdio: "ignore",
      detached: true,
    });
    let exited = false;
    child.on("exit", () => { exited = true; });
    child.on("error", () => { exited = true; });
    child.unref();

    // Wait for the PID file (written once the server is listening), or for the
    // child to give up — say which, and where its log is.
    const logPath = path.join(teamDir, LOG_FILENAME);
    const deadline = Date.now() + 15_000;
    let newPid: number | null = null;
    while (Date.now() < deadline && !exited) {
      newPid = readPid(teamDir);
      if (newPid && isProcessAlive(newPid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (newPid && !exited) {
      console.log(`✅ Daemon started (PID ${newPid}) on http://localhost:${port}`);
      console.log(`   Log: ${logPath}`);
    } else {
      console.error(`❌ The daemon ${exited ? "exited during startup" : "did not start within 15s"}. See ${logPath}`);
      process.exit(1);
    }
  } else {
    // Foreground mode: start daemon in-process 
    await startDaemonInProcess(teamDir, port, hostname);
  }
}

function cmdStop(): void {
  const teamDir = getTeamDir();
  const pid = readPid(teamDir);

  if (!pid) {
    console.log("No daemon is running (no PID file found).");
    process.exit(0);
  }

  if (!isProcessAlive(pid)) {
    console.log(`Stale PID file (process ${pid} not found). Cleaning up.`);
    try { fs.rmSync(getPidFile(teamDir)); } catch { /* */ }
    process.exit(0);
  }

  console.log(`Sending SIGTERM to daemon (PID ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
    console.log("✅ Stop signal sent. Daemon should shut down gracefully.");
  } catch (e) {
    console.error(`❌ Failed to send signal: ${(e as Error).message}`);
    process.exit(1);
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
    process.exit(1);
  }

  console.log(`🟢 Daemon is running (PID ${pid})`);
  console.log(`   Team dir: ${teamDir}`);

  try {
    const res = await fetch(`http://localhost:${port}/api/status`);
    if (res.ok) {
      const data = (await res.json()) as StatusSummaryInput;
      console.log(`   Port: ${port}`);
      // Respects the feature toggles: a switched-off kind's count is left out.
      for (const line of statusSummaryLines(data)) console.log(`   ${line}`);
    } else {
      const body = await res.json().catch(() => null);
      console.log(`   ⚠️  API responded with HTTP ${res.status}: ${daemonErrorMessage(res.status, body)}`);
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
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      console.error("❌ Failed to parse config.json");
      process.exit(1);
    }
  } else if (!existsSync(teamDir)) {
    fs.mkdirSync(teamDir, { recursive: true });
  }

  const token = generateToken();
  config.apiToken = token;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`✅ New API token generated and saved to config.json`);
  console.log(`\n   Token: ${token}`);
  console.log(`\n   Use in requests:`);
  console.log(`     Authorization: Bearer ${token}`);
  console.log(`\n   Or set environment:`);
  console.log(`     export MPT_API_TOKEN=${token}`);
  console.log(`\n   ⚠️  Restart the daemon for the new token to take effect.`);
}

async function cmdInstall(args: string[]): Promise<void> {
  const teamDir = getTeamDir();
  const port = getPort();
  // The service outlives this shell, so it needs a Node that will still be there.
  const node = await ensureNodeForCommand(args);
  await install(teamDir, port, node.path);
}

async function cmdUninstall(): Promise<void> {
  await uninstall();
}

// --- Self-update (`mpt upgrade`) ---

/** `mpt upgrade [--check]` — see cli/upgrade.ts. */
async function cmdUpgrade(args: string[]): Promise<void> {
  const code = await runUpgrade(args, defaultUpgradeDeps({
    currentVersion: VERSION,
    fromSource: isRunningFromSource(),
    packageRoot: packageRoot(),
    ensureNode: () => ensureNodeForCommand(args),
    checkNode: () => configuredNode()?.path ?? process.execPath,
  }));
  if (code !== 0) process.exit(code);
}

function printHelp(): void {
  console.log(`mpt v${VERSION} — my-pizza-team CLI

Usage:
  mpt <command> [options]

Commands:
  setup [--dry-run]     Install the Pi extension, create the team dir, trust the folder
  setup --uninstall     Undo what setup did (leaves the team directory and its data)
  setup --harness <h>   Prepare an experimental non-Pi harness (kiro, claude)
  doctor                Read-only checklist of prerequisites, with a fix for each problem
  start [--daemon|-d]   Start the daemon (foreground, or in the background with -d;
                        its output then goes to daemon.log in the team directory)
  lead [--no-attach]    Start the leader in tmux and attach to it
  stop                  Stop the running daemon (sends SIGTERM)
  status                Check if the daemon is running and show a summary
  upgrade [--check]     Update mpt (npm) *and* its Pi extension, restart the service
                        (--check only reports)
  install               Install as a user service (launchd/systemd; starts on login)
  uninstall             Remove the service
  rotate-token          Generate a new API token (saved to config.json)
  agent --harness <h>   Run a non-Pi teammate (kiro, claude) — experimental; the daemon starts these
  --version, --help

Options:
  --node <path>         The Node that runs mpt (saved by setup/install/upgrade)
  --yes, -y             setup/install/upgrade: don't ask which Node, use the current one

Environment:
  TEAM_DIR              Team directory, or its parent (default: ./${TEAM_DIR})
  PORT                  Daemon port (default: 7437)
  HOST                  Bind address (default: 127.0.0.1; anything else needs an API token)
  MPT_API_TOKEN         Overrides config.json's apiToken
  MPT_NODE              The Node that runs mpt (overrides ~/.config/mpt/runtime.json)

Getting started (in your project folder):
  mpt setup && mpt start --daemon && mpt lead
`);
}

/** Read the team's config, falling back to defaults for anything unset. */
function readTeamConfig(teamDir: string): typeof DEFAULT_CONFIG & Record<string, unknown> {
  const file = path.join(teamDir, "config.json");
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    console.warn(`⚠️  Could not parse ${file} — using defaults.`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * `mpt lead` — start the leader in tmux and attach to it.
 *
 * The leader is the agent you chat with, and it also realizes the daemon's spawn
 * asks, so a team with no leader has no way to grow and nobody answering
 * (docs/DESIGN.md "One Agent to Talk To"). Starting it was the last step
 * still done by hand.
 *
 * This is also the first consumer of the daemon's tmux module (P3-1), deliberately in
 * the easy case: a foreground command with the user's own environment, so it exercises
 * the code without the service-environment questions that moving *spawn* realization
 * raises.
 */
async function cmdLead(args: string[]): Promise<void> {
  const teamDir = getTeamDir();
  const projectDir = path.dirname(teamDir);
  const port = getPort();
  const daemonUrl = `http://localhost:${port}`;
  const config = readTeamConfig(teamDir);
  const session = (config.tmuxSession as string) || "mpt";
  const harnessName = (config.defaultHarness as string) || DEFAULT_HARNESS;

  if (!tmuxAvailable()) {
    console.error("❌ tmux is not available — the leader runs in a tmux window.");
    console.error("   Install it (e.g. `brew install tmux`), then run `mpt doctor`.");
    process.exit(1);
  }

  const templates = (config.harnesses as Record<string, { leader?: string }> | undefined) ??
    DEFAULT_HARNESS_TEMPLATES;
  const template = templates[harnessName]?.leader;
  if (!template) {
    console.error(`❌ No leader command configured for harness "${harnessName}".`);
    console.error(`   Leading needs an in-process adapter; only some harnesses can do it.`);
    console.error(`   Set harnesses.${harnessName}.leader in ${path.join(teamDir, "config.json")}.`);
    process.exit(1);
  }

  const command = renderTemplate(template, {
    name: LEADER_WINDOW,
    url: daemonUrl,
    cwd: projectDir,
    session,
    window: LEADER_WINDOW,
  });
  const unresolved = unresolvedPlaceholders(command);
  if (unresolved.length > 0) {
    console.error(`❌ The leader template has unknown placeholders: ${unresolved.join(", ")}`);
    console.error(`   Check harnesses.${harnessName}.leader in ${path.join(teamDir, "config.json")}.`);
    process.exit(1);
  }

  // A stopped daemon isn't fatal — the extension retries — but say so, because an
  // agent that can't reach the daemon looks broken rather than early.
  let daemonUp = false;
  try {
    daemonUp = (await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch { /* not running */ }
  if (!daemonUp) console.log(`⚠️  Daemon not reachable at ${daemonUrl} — start it with \`mpt start\` (the leader will retry).`);

  try {
    // Deliberately *not* calling ensureSession first: spawnWindow reuses a freshly
    // created session's initial window instead of leaving it stranded beside ours, and
    // it can only tell the session is fresh if it creates it. listWindows already
    // returns [] for a session that doesn't exist yet.
    if (listWindows(session).includes(LEADER_WINDOW)) {
      // Already running: attach to it rather than starting a second one. Two leaders
      // would both answer the chat.
      console.log(`Leader already running in ${session}:${LEADER_WINDOW} — attaching.`);
    } else {
      spawnWindow({ session, window: LEADER_WINDOW, cwd: projectDir, command });
      console.log(`✅ Leader started in ${session}:${LEADER_WINDOW} (${projectDir})`);
    }
  } catch (e) {
    console.error(`❌ Could not start the leader: ${(e as Error).message}`);
    process.exit(1);
  }

  if (args.includes("--no-attach")) {
    console.log(`   Attach with: tmux attach -t ${session}`);
    return;
  }

  // Inside tmux already, attaching would nest; switch the client instead.
  if (process.env["TMUX"]) {
    selectWindow(session, LEADER_WINDOW);
    console.log(`   Switched to ${session}:${LEADER_WINDOW}.`);
    return;
  }

  // Hand the terminal over. `attach` needs a tty, so it inherits ours.
  const attach = spawnSync("tmux", ["attach", "-t", `${session}:${LEADER_WINDOW}`], { stdio: "inherit" });
  if (attach.status !== 0) {
    console.log(`   Could not attach automatically. Run: tmux attach -t ${session}`);
  }
}

/**
 * Rewrite the managed extension from *this* copy of mpt's bundled extension.
 *
 * Invoked by `mpt upgrade` on the newly-installed copy, not in-process: the
 * running process carries the **old** bundled extension, so writing it here would
 * install the version being replaced. Hidden, because it is an implementation
 * detail of upgrade rather than something to run by hand (`mpt setup` is that).
 *
 * Only refreshes a directory that already exists. Someone who never ran setup, or
 * who works from a registered development checkout, has no managed install — and
 * upgrade must not create one behind their back.
 */
function cmdWriteExtensionInternal(): void {
  const managedDir = managedExtensionDir();
  if (!existsSync(managedDir)) return;

  const sourceDir = resolveExtensionSourceDir();
  if (!sourceDir) {
    console.error("⚠️  Could not locate the bundled extension; run `mpt setup` to reinstall it.");
    process.exit(1);
  }
  const { version } = writeExtension(sourceDir, managedDir);
  console.log(`✅ Pi extension updated to v${version ?? "unknown"} at ${managedDir}`);
}

/** Render a plan so the user sees every change before it happens. */
function describePlan(plan: SetupPlan): void {
  for (const note of plan.respected) console.log(`   ·  ${note}`);
  if (plan.respected.length > 0 && plan.actions.length > 0) console.log();
  for (const action of plan.actions) {
    switch (action.kind) {
      case "write-extension":
        console.log(`   →  write the bundled Pi extension to ${action.targetDir}`);
        break;
      case "register-extension":
        console.log(`   →  register it with Pi (${action.targetDir})`);
        break;
      case "unregister":
        console.log(`   →  unregister ${action.resolvedPath}  (${action.because})`);
        break;
      case "create-team-dir":
        console.log(`   →  create the team directory ${action.teamDir}`);
        break;
      case "trust-project":
        console.log(`   →  mark ${action.projectDir} trusted by Pi`);
        break;
    }
  }
}

/**
 * `mpt setup` — make this machine ready to run a team. Idempotent.
 *
 * Installs the extension by *writing* the copy carried with this mpt, which is what
 * keeps the daemon and the extension from drifting apart (DESIGN.md "One Protocol, One Version"). Every change is
 * printed first, and recorded so `--uninstall` can undo exactly what was done —
 * this edits the user's own Pi configuration, so guessing later is not acceptable.
 */
async function cmdSetup(args: string[]): Promise<void> {
  if (args.some((a) => a === "--harness" || a.startsWith("--harness="))) {
    const teamDir = getTeamDir();
    const config = readTeamConfig(teamDir) as { experimental?: { harnesses?: boolean } };
    return cmdSetupHarness(args, path.join(teamDir, "config.json"), !!config.experimental?.harnesses);
  }
  if (args.includes("--uninstall")) return cmdSetupUninstall(args);

  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const teamDir = getTeamDir();
  const projectDir = path.dirname(teamDir);
  const agentDir = piAgentDir();
  const managedDir = managedExtensionDir();
  const sourceDir = resolveExtensionSourceDir();

  const facts = await gather({
    teamDir,
    projectDir,
    daemonVersion: VERSION,
    daemonUrl: `http://localhost:${getPort()}`,
    serviceInstalled: detectInstalledService() !== null,
  });

  const plan = planSetup({
    registrations: facts.registrations,
    managedDir,
    settingsReadable: facts.settingsReadable,
    bundledExtensionAvailable: sourceDir !== null,
    teamDirConfigured: facts.teamDirExists,
    projectTrusted: facts.projectTrusted,
    teamDir,
    projectDir,
  });

  if (plan.blockers.length > 0) {
    console.error("❌ Cannot set up:");
    for (const b of plan.blockers) console.error(`   ${b}`);
    process.exit(1);
  }

  // Which Node runs mpt (the service, teammates, upgrades): asked once, then saved
  // to ~/.config/mpt/runtime.json. A dry run only says what is saved.
  if (dryRun) {
    const node = configuredNode();
    console.log(node ? `   ·  Node: ${node.path}` : "   →  ask which Node runs mpt, and save it");
  } else {
    await ensureNodeForCommand(args);
    console.log();
  }

  if (isNoOp(plan)) {
    console.log("✅ Already set up — nothing to change.");
    for (const note of plan.respected) console.log(`   ·  ${note}`);
    console.log("\n   Run `mpt doctor` to check the details.");
    return;
  }

  console.log(dryRun ? "Would make these changes:\n" : "Setting up:\n");
  describePlan(plan);
  if (dryRun) {
    console.log("\nNothing was changed (--dry-run).");
    return;
  }
  console.log();

  // Collect package-list edits and apply them in one write.
  const toRemove = plan.actions.filter((a) => a.kind === "unregister").map((a) => a.source);
  const toAdd = plan.actions.some((a) => a.kind === "register-extension") ? managedDir : undefined;

  for (const action of plan.actions) {
    if (action.kind === "write-extension") {
      const { version } = writeExtension(sourceDir!, action.targetDir);
      console.log(`✅ Extension written to ${action.targetDir} (v${version ?? "unknown"})`);
    }
    if (action.kind === "create-team-dir") {
      // A new team starts with Tasks only; never overwrites an existing config.
      initTeamConfig(action.teamDir);
      console.log(`✅ Team directory ready at ${action.teamDir}`);
    }
    if (action.kind === "trust-project") {
      trustProject(agentDir, action.projectDir);
      console.log(`✅ ${action.projectDir} is trusted by Pi`);
    }
  }

  let addedPackages: string[] = [];
  let removedPackages: string[] = [];
  if (toRemove.length > 0 || toAdd) {
    const { raw, removed, added } = applyPackageChanges(readPiSettings(agentDir), {
      remove: toRemove,
      addLocalPath: toAdd,
      agentDir,
    });
    writePiSettingsFile(agentDir, raw);
    addedPackages = added;
    removedPackages = removed;
    for (const r of removed) console.log(`✅ Unregistered ${r}`);
    for (const a of added) console.log(`✅ Registered ${a} with Pi`);
  }

  // Record what changed, merged with any previous run's record.
  const previous = readManifest(manifestPath(path.dirname(managedDir)));
  writeManifest(manifestPath(path.dirname(managedDir)), {
    at: new Date().toISOString(),
    version: VERSION,
    agentDir,
    addedPackages: [...new Set([...(previous?.addedPackages ?? []), ...addedPackages])],
    removedPackages: [...new Set([...(previous?.removedPackages ?? []), ...removedPackages])],
    managedDir: existsSync(managedDir) ? managedDir : null,
    trustedProjects: [...new Set([
      ...(previous?.trustedProjects ?? []),
      ...plan.actions.filter((a) => a.kind === "trust-project").map((a) => a.projectDir),
    ])],
  });

  console.log("\nNext: `mpt start --daemon` to run the daemon, then `mpt lead` to start the leader.");
  console.log("      `mpt doctor` re-checks everything.");
}

/**
 * `mpt setup --uninstall` — undo what setup did, and nothing else.
 *
 * Driven entirely by the recorded manifest. Without it, uninstall would have to
 * guess which registrations were ours, and guessing at someone else's settings file
 * is how you delete an entry they added themselves.
 *
 * Two things are deliberately *not* undone, and both are reported rather than done
 * silently:
 *
 *   - **Project trust.** Revoking it would break other tools using the same folder.
 *   - **Registrations setup removed.** Restoring them would re-create the broken
 *     state setup was fixing — a path that no longer exists, or the archived
 *     standalone repo. So they are named, and re-adding is left to the user, who is
 *     the only one who knows whether they still want them.
 */
function cmdSetupUninstall(args: string[]): void {
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const managedDir = managedExtensionDir();
  const file = manifestPath(path.dirname(managedDir));
  const manifest = readManifest(file);

  if (!manifest) {
    console.log("Nothing to undo: no setup manifest found.");
    console.log(`   (looked in ${file})`);
    return;
  }

  console.log(dryRun ? "Would undo:\n" : "Undoing setup:\n");
  for (const entry of manifest.addedPackages) console.log(`   →  unregister ${entry} from Pi`);
  if (manifest.managedDir && existsSync(manifest.managedDir)) {
    console.log(`   →  remove ${manifest.managedDir}`);
  }
  if (manifest.trustedProjects.length > 0) {
    console.log(`   ·  leaving project trust in place (${manifest.trustedProjects.join(", ")}) — other tools may rely on it`);
  }
  if (manifest.removedPackages.length > 0) {
    // Named rather than restored: putting these back would re-create the state setup
    // was fixing. Said out loud so the choice is the user's.
    console.log("   ·  not restoring these registrations that setup removed:");
    for (const entry of manifest.removedPackages) console.log(`        ${entry}`);
    console.log("      (re-add with `pi install <path>` if you still want one)");
  }
  if (dryRun) {
    console.log("\nNothing was changed (--dry-run).");
    return;
  }
  console.log();

  if (manifest.addedPackages.length > 0) {
    const { raw, removed } = applyPackageChanges(readPiSettings(manifest.agentDir), {
      remove: manifest.addedPackages,
      agentDir: manifest.agentDir,
    });
    writePiSettingsFile(manifest.agentDir, raw);
    for (const r of removed) console.log(`✅ Unregistered ${r}`);
  }
  if (manifest.managedDir && existsSync(manifest.managedDir)) {
    fs.rmSync(manifest.managedDir, { recursive: true });
    console.log(`✅ Removed ${manifest.managedDir}`);
  }
  fs.rmSync(file);
  console.log("\nDone. The team directory and its data were left alone.");
}

/**
 * `mpt doctor` — check the prerequisites and print one fix per problem.
 *
 * Read-only: it changes nothing, which also makes it the honest dry-run for
 * `mpt setup`. Exits non-zero when something is actually broken (warnings don't
 * fail, or the exit code would be useless).
 */
async function cmdDoctor(): Promise<void> {
  const teamDir = getTeamDir();
  const port = getPort();
  const service = detectInstalledService();
  const facts = await gather({
    teamDir,
    // Trust is asked about the *project* folder, which is the team dir's parent.
    projectDir: path.dirname(teamDir),
    daemonVersion: VERSION,
    daemonUrl: `http://localhost:${port}`,
    serviceInstalled: service !== null,
    service: service?.programPath ?? null,
  });
  process.exit(report(evaluate(facts)));
}

// --- Exported main ---

export async function main(): Promise<void> {
  // `--node <path>` works with any command; it overrides the saved Node
  // (shared/runtime-config.ts). Exported as MPT_NODE too, so children this process
  // starts (the --daemon child, teammates) agree with it.
  let args: string[];
  try {
    const parsed = extractNodeFlag(process.argv.slice(2));
    args = parsed.args;
    if (parsed.node) {
      setNodeFlagOverride(parsed.node);
      process.env["MPT_NODE"] = path.resolve(parsed.node);
    }
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
  const command = args[0];

  switch (command) {
    case "start":
      // Handle internal flag for daemonized background process
      if (args.includes("--foreground-internal")) {
        // The background child `start --daemon` launches: no terminal, so log to a file.
        const teamDir = getTeamDir();
        fs.mkdirSync(teamDir, { recursive: true });
        redirectOutputToLog(teamDir);
        const port = getPort();
        const hostname = process.env["HOST"] || "127.0.0.1";
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
      await cmdInstall(args.slice(1));
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    case "upgrade":
      await cmdUpgrade(args.slice(1));
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "setup":
      await cmdSetup(args.slice(1));
      break;
    case "lead":
      await cmdLead(args.slice(1));
      break;
    // Hidden: `mpt upgrade` invokes this on the freshly-installed copy so the
    // extension written out is the new one, not the one being replaced.
    case "agent":
      await cmdAgent(args.slice(1));
      break;
    case "write-extension-internal":
      cmdWriteExtensionInternal();
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
      process.exit(command ? 1 : 0);
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
