/**
 * cli/upgrade.ts — `mpt upgrade [--check]`: update mpt through npm, then move the
 * Pi extension and the service along with it.
 *
 * mpt is an npm package, so upgrading is `npm install -g my-pizza-team@<latest>`.
 * The subtlety is *which* npm: the service runs `<configured node> <package entry>`
 * (shared/runtime-config.ts), and a global install only lands where that Node's
 * own npm puts it. So the install uses the configured Node's npm, with that Node
 * first on PATH (npm's `#!/usr/bin/env node` shebang would otherwise pick whichever
 * Node the shell has, and npm derives its global prefix from the Node running it).
 *
 * After installing: the *new* copy rewrites the managed Pi extension (the running
 * process still holds the old one — DESIGN.md "One Protocol, One Version"), and the
 * installed service is restarted. npm verifies package integrity itself, so there is
 * no checksum step here.
 *
 * Every side effect goes through `UpgradeDeps`, so tests drive the whole flow with
 * the registry fetch and the child processes stubbed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { detectInstalledService } from "./service.ts";
import { managedExtensionDir } from "./extension.ts";
import { sameFile } from "../shared/runtime-config.ts";

/** The npm package name. */
export const PACKAGE_NAME = "my-pizza-team";

/** Used when `npm config get registry` yields nothing usable. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** True if `latest` (X.Y.Z) is strictly newer than `current` (X.Y.Z). */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** The registry URL for the package's `latest` dist-tag manifest. */
export function latestManifestUrl(registry: string): string {
  return `${registry.trim().replace(/\/+$/, "")}/${PACKAGE_NAME}/latest`;
}

/** How to run the configured Node's npm: a command, its leading args, and the env to run it in. */
export interface NpmCommand {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The command as a shell string (for hints). */
  display: string;
}

/**
 * Find the npm that belongs to `node`: `<dirname(node)>/npm`, else
 * `<node> <dirname(node)>/../lib/node_modules/npm/bin/npm-cli.js`, else null.
 * Its env puts `dirname(node)` first on PATH (see the module comment).
 */
export function resolveNpm(
  node: string,
  exists: (p: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): NpmCommand | null {
  const binDir = path.dirname(node);
  const runEnv = { ...env, PATH: [binDir, env["PATH"]].filter(Boolean).join(path.delimiter) };
  const npmBin = path.join(binDir, "npm");
  if (exists(npmBin)) return { cmd: npmBin, args: [], env: runEnv, display: npmBin };
  const npmCli = path.resolve(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(npmCli)) return { cmd: node, args: [npmCli], env: runEnv, display: `${node} ${npmCli}` };
  return null;
}

/** Did npm fail for lack of permission on its global prefix? */
export function isPermissionError(output: string): boolean {
  return /\bEACCES\b|\bEPERM\b|permission denied/i.test(output);
}

/** A child process's result. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Side effects of the upgrade flow (stubbed in tests). */
export interface UpgradeDeps {
  /** The running mpt's version. */
  currentVersion: string;
  /** Running the `.ts` sources from a checkout (shared/paths.ts `isRunningFromSource`). */
  fromSource: boolean;
  /** The running mpt's package root. */
  packageRoot: string;
  /** Settle the configured Node (prompting if needed) — cli/node-choice.ts. */
  ensureNode: () => Promise<{ path: string }>;
  /** The Node to use for a read-only `--check` (configured, else the running one). No prompt. */
  checkNode: () => string;
  fetch: (url: string) => Promise<Response>;
  /** Run a command; `echo` streams its output to this terminal as well as capturing it. */
  run: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; echo?: boolean }) => Promise<RunResult>;
  exists: (p: string) => boolean;
  /** Same file, following symlinks. */
  sameFile: (a: string, b: string) => boolean;
  refreshExtension: (invocation: string[]) => void;
  restartService: (version: string, upgradedEntry: string, node: string) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Run a command, capturing output, optionally echoing it live. Never rejects. */
function runCommand(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; echo?: boolean }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (opts.echo) process.stdout.write(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      if (opts.echo) process.stderr.write(b);
    });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr || e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** The real side effects, minus the ones that need cli/main.ts's context. */
export function defaultUpgradeDeps(
  base: Pick<UpgradeDeps, "currentVersion" | "fromSource" | "packageRoot" | "ensureNode" | "checkNode">,
): UpgradeDeps {
  return {
    ...base,
    fetch: (url) => fetch(url, { headers: { "Accept": "application/json", "User-Agent": "mpt-cli" } }),
    run: runCommand,
    exists: existsSync,
    sameFile,
    refreshExtension: refreshManagedExtension,
    restartService: restartServiceAfterUpgrade,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

/** The registry npm is configured for, or the public one. */
async function npmRegistry(npm: NpmCommand | null, d: UpgradeDeps): Promise<string> {
  if (!npm) return DEFAULT_REGISTRY;
  const r = await d.run(npm.cmd, [...npm.args, "config", "get", "registry"], { env: npm.env });
  const value = r.stdout.trim();
  return r.code === 0 && /^https?:\/\//.test(value) ? value : DEFAULT_REGISTRY;
}

/** Fetch the latest published version. Throws with a readable reason. */
async function fetchLatestVersion(registry: string, d: UpgradeDeps): Promise<string> {
  const url = latestManifestUrl(registry);
  const res = await d.fetch(url);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${url} returned HTTP ${res.status}`);
  }
  const body = await res.json() as { version?: unknown };
  if (typeof body.version !== "string" || !body.version) throw new Error(`${url} has no version`);
  return body.version;
}

/** Shell-quote one argument for a printed hint. */
function quote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * `mpt upgrade [--check]`. Resolves to the process exit code.
 *
 * `--check` only reports whether a newer version is published. Without it: install
 * the latest with the configured Node's npm, refresh the Pi extension from the new
 * copy, and restart the service.
 */
export async function runUpgrade(args: string[], d: UpgradeDeps): Promise<number> {
  const checkOnly = args.includes("--check");

  if (d.fromSource && !checkOnly) {
    d.error("⚠️  This mpt is running from source — `mpt upgrade` updates the npm package, not a checkout.");
    d.error("    Update the checkout instead:  git pull && npm install");
    d.error("    Then run `mpt setup` to refresh the Pi extension, and restart the daemon.");
    return 1;
  }

  const node = checkOnly ? d.checkNode() : (await d.ensureNode()).path;
  const npm = resolveNpm(node, d.exists);
  if (!npm && !checkOnly) {
    d.error(`❌ Could not find the npm that belongs to ${node}.`);
    d.error(`   Looked for ${path.join(path.dirname(node), "npm")} and ` +
      `${path.resolve(path.dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")}.`);
    d.error("   Install npm alongside that Node, or choose another Node:  mpt upgrade --node <path>");
    return 1;
  }

  d.log("Checking for the latest version…");
  let latest: string;
  try {
    latest = await fetchLatestVersion(await npmRegistry(npm, d), d);
  } catch (e) {
    d.error(`❌ Could not check for updates: ${(e as Error).message}`);
    return 1;
  }

  const current = d.currentVersion;
  if (!isNewerVersion(latest, current)) {
    d.log(`✅ Already up to date (v${current}${latest !== current ? `; latest published is v${latest}` : ""}).`);
    return 0;
  }
  d.log(`⬆️  Update available: v${current} → v${latest}`);
  if (checkOnly) {
    d.log(d.fromSource ? "   (running from source: update with  git pull)" : "   Run  mpt upgrade  to install it.");
    return 0;
  }
  const npmCmd = npm!;

  // Where that npm installs globals. If this mpt isn't there, say which copy moves.
  const rootResult = await d.run(npmCmd.cmd, [...npmCmd.args, "root", "-g"], { env: npmCmd.env });
  const globalRoot = rootResult.stdout.trim();
  if (rootResult.code !== 0 || !globalRoot) {
    d.error(`❌ \`${npmCmd.display} root -g\` failed: ${rootResult.stderr.trim() || `exit ${rootResult.code}`}`);
    return 1;
  }
  const installedRoot = path.join(globalRoot, PACKAGE_NAME);
  if (!d.sameFile(d.packageRoot, installedRoot)) {
    d.log(`   ℹ️  This mpt (${d.packageRoot}) isn't the one ${node}'s npm manages.`);
    d.log(`      Upgrading the copy the service uses instead: ${installedRoot}`);
  }

  const spec = `${PACKAGE_NAME}@${latest}`;
  d.log(`   Installing ${spec} with ${npmCmd.display}…`);
  const install = await d.run(npmCmd.cmd, [...npmCmd.args, "install", "-g", spec], { env: npmCmd.env, echo: true });
  if (install.code !== 0) {
    if (isPermissionError(install.stderr + install.stdout)) {
      const binDir = path.dirname(node);
      const rerun = [npmCmd.cmd, ...npmCmd.args, "install", "-g", spec].map(quote).join(" ");
      d.error(`❌ npm has no permission to write to its global prefix (${path.dirname(globalRoot)}).`);
      d.error(`   Rerun it with sudo:`);
      d.error(`     sudo env "PATH=${binDir}:$PATH" ${rerun}`);
      d.error(`   or give npm a prefix you own (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally),`);
      d.error(`   then run  mpt upgrade  again.`);
    } else {
      d.error(`❌ npm install failed (exit ${install.code}).`);
    }
    return 1;
  }

  const newEntry = path.join(installedRoot, "dist", "main.js");
  if (!d.exists(newEntry)) {
    d.error(`❌ Installed ${spec}, but ${newEntry} is missing.`);
    return 1;
  }
  d.log(`✅ Installed mpt v${latest} (${installedRoot}).`);
  d.refreshExtension([node, newEntry]);
  await d.restartService(latest, newEntry, node);
  return 0;
}

/**
 * After an upgrade, move the *other half* with mpt: rewrite the managed Pi
 * extension. The daemon and the extension are one protocol (DESIGN.md "One
 * Protocol, One Version"); upgrading only mpt is exactly the skew to avoid.
 *
 * `invocation` must run the *new* mpt (e.g. `[node, <new entry>]`), because this
 * process still holds the old code and would write the old extension.
 *
 * Pi loads a local package from its path without copying, so rewriting the
 * directory is the whole job — no re-registration. Running agents keep the old
 * code until their Pi restarts, which the version handshake makes visible.
 */
export function refreshManagedExtension(invocation: string[]): void {
  if (!existsSync(managedExtensionDir())) return;
  const [exe, ...exeArgs] = invocation;
  const out = spawnSync(exe!, [...exeArgs, "write-extension-internal"], { stdio: ["ignore", "inherit", "inherit"] });
  if (out.error) {
    console.warn(`   ⚠️  Could not refresh the Pi extension (${out.error.message}) — run \`mpt setup\` to finish.`);
  } else if (out.status !== 0) {
    console.warn("   ⚠️  Could not refresh the Pi extension — run `mpt setup` to finish.");
  } else {
    console.log("   Restart running agents to pick it up (`mpt doctor` shows which are behind).");
  }
}

/** Resolve symlinks when the path exists, so two spellings of one file compare equal. */
function realOrResolved(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * After an upgrade, restart the installed service (if any) so it runs `version`.
 *
 * The service launches a specific entry script, so when that isn't the copy
 * `upgradedEntry` names, say so instead of restarting the wrong one. A service
 * launched by a Node other than `node` (the configured one) still restarts, with a
 * note to re-point it.
 */
export async function restartServiceAfterUpgrade(version: string, upgradedEntry: string, node?: string): Promise<void> {
  const svc = detectInstalledService();
  if (!svc) {
    console.log(`   Restart the daemon to run the new version:  mpt stop && mpt start --daemon`);
    return;
  }
  const serviceEntry = svc.programPath?.entry;
  if (serviceEntry && realOrResolved(serviceEntry) !== realOrResolved(upgradedEntry)) {
    console.log(`\n⚠️  Your ${svc.manager} service runs a different copy of mpt:`);
    console.log(`     service:  ${svc.programPath!.node} ${serviceEntry}`);
    console.log(`     upgraded: ${node ? `${node} ` : ""}${upgradedEntry}`);
    console.log(`   Re-run upgrade from that copy, or re-point the service:  mpt install`);
    return;
  }
  if (node && svc.programPath && svc.programPath.node !== node) {
    console.log(`   ⚠️  The service runs ${svc.programPath.node}, not the configured ${node} — re-point it with  mpt install`);
  }
  console.log(`   Restarting the ${svc.manager} service…`);
  const ok = await svc.restart();
  console.log(ok ? `   ✅ Service restarted on v${version}.` : `   ⚠️  Couldn't restart automatically. Run:  ${svc.restartHint}`);
}
