/**
 * daemon/plugins/install.ts — Fetch and prepare npm / git plugin packages into
 * the team's install layout (`packageInstallDir`). See docs/DESIGN.md "Plugin
 * packages" and GUIDE.md "Distributing a plugin".
 *
 * One code path for every installer: `mpt plugins add|update` (cli/plugins.ts),
 * the daemon's install-on-start of configured-but-missing packages
 * (`installMissingPackages`, called from daemon/app.ts before the loader), and
 * `mpt plugins doctor` on an unconfigured spec (into a scratch team dir). None of
 * them touches config.json here — that's the CLI's job.
 *
 *   - npm:   `npm install --prefix <teamDir>/packages/npm --omit=peer <name>[@version]`
 *   - git:   `git clone` into `<teamDir>/packages/git/<host>/<path>`, check out the
 *            `@ref`, then `prepareGit`:
 *              · every `mpt.sources` entry committed and no runtime `dependencies`
 *                → no npm at all (a prebuilt package);
 *              · entries committed, runtime deps declared
 *                → `npm install --omit=peer --omit=dev` only;
 *              · otherwise `npm install --omit=peer` (dev deps too) and `npm run
 *                build`, then the entries must exist.
 *
 * MPT stays build-system agnostic: the contract is "installs and builds with
 * plain npm against the user's registry, or ships prebuilt entries". A failing
 * npm step says so, with npm's exit code and the tail of its stderr.
 *
 * Side effects go through `PluginRunner` so tests can stub npm.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamConfig } from "../../shared/types.ts";
import { npmPluginPrefix, packageInstallDir, readPluginManifest } from "./loader.ts";
import { type GitPackageSpec, type NpmPackageSpec, type PackageSpec, parsePackageEntries } from "./spec.ts";

/** A child process's outcome. */
export interface PluginRunResult {
  code: number;
  /** Captured stdout (only when `capture` was asked for). */
  stdout: string;
  /** Captured stderr, when the runner keeps it (used for the tail in a failure message). */
  stderr?: string;
}

/** Options for one command. */
export interface PluginRunOptions {
  cwd?: string;
  /** Return stdout instead of streaming it (used for git queries). */
  capture?: boolean;
  /** Kill the command after this long (reported as a failure). */
  timeoutMs?: number;
}

/** Run a command; never throws. */
export type PluginRunner = (cmd: string, args: string[], opts: PluginRunOptions) => PluginRunResult;

/** What an install needs: where, how to run commands, and where progress goes. */
export interface InstallDeps {
  teamDir: string;
  run: PluginRunner;
  log: (line: string) => void;
  /** Per-command limit (default: none). The daemon's install-on-start bounds it. */
  timeoutMs?: number;
}

/** Thrown for a user-facing install failure (the message is the whole story). */
export class PluginInstallError extends Error {}

/** The exit code a runner reports for a command it killed on timeout (as `timeout(1)` does). */
export const TIMEOUT_EXIT_CODE = 124;

/** Default per-command limit of the daemon's install-on-start (`MPT_PLUGIN_INSTALL_TIMEOUT_MS` overrides). */
export const DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** How many lines of a failed command's stderr a failure message quotes. */
const STDERR_TAIL_LINES = 12;

/** The contract a git plugin must meet, quoted when its npm step fails. */
export const GIT_PLUGIN_CONTRACT = "Git plugins must install and build with plain npm against your npm registry (`npm config get registry`), "
  + "or ship prebuilt mpt.sources entries. See GUIDE.md \"Distributing a plugin\".";

/** What a failed npm install of an npm package says next. */
const NPM_PLUGIN_HINT = "Check the package name and version, and that your npm registry (`npm config get registry`) serves it.";

/** The last non-empty lines of a command's stderr, indented, or "" when there are none. */
export function stderrTail(stderr: string | undefined, lines = STDERR_TAIL_LINES): string {
  const kept = (stderr ?? "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  return kept.slice(-lines).map((l) => `      ${l}`).join("\n");
}

/**
 * Run one install step, throwing a readable error when it fails: the command,
 * its exit code (or the timeout), the tail of its stderr, and `hint`.
 */
function step(d: InstallDeps, cmd: string, args: string[], cwd?: string, hint?: string): void {
  d.log(`   $ ${[cmd, ...args].join(" ")}${cwd ? `   (in ${cwd})` : ""}`);
  const r = d.run(cmd, args, { cwd, ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}) });
  if (r.code === 0) return;
  const why = r.code === TIMEOUT_EXIT_CODE && d.timeoutMs ? `timed out after ${Math.round(d.timeoutMs / 1000)}s` : `exit ${r.code}`;
  const tail = stderrTail(r.stderr);
  throw new PluginInstallError(`\`${cmd} ${args.join(" ")}\` failed (${why})${tail ? `\n${tail}` : ""}${hint ? `\n   ${hint}` : ""}`);
}

/** Run `git` as an install step (no contract hint: a git failure is access or the ref). */
export function gitStep(d: InstallDeps, args: string[]): void {
  step(d, "git", args);
}

/**
 * The commands that install an npm package into the shared prefix. `latest`
 * asks for the newest version (update of an unpinned entry); otherwise the
 * spec's version, if any.
 */
export function npmInstallArgs(spec: NpmPackageSpec, teamDir: string, latest = false): string[] {
  const target = latest ? `${spec.name}@latest` : spec.version ? `${spec.name}@${spec.version}` : spec.name;
  return ["install", "--prefix", npmPluginPrefix(teamDir), "--omit=peer", "--no-audit", "--no-fund", target];
}

/** Install an npm package (the prefix gets a private package.json so npm treats it as a project). */
export function installNpm(spec: NpmPackageSpec, d: InstallDeps, latest = false): void {
  const prefix = npmPluginPrefix(d.teamDir);
  fs.mkdirSync(prefix, { recursive: true });
  const pkgJson = path.join(prefix, "package.json");
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: "mpt-plugins", private: true, description: "Plugin packages installed by `mpt plugins` — don't edit by hand" }, null, 2) + "\n");
  }
  step(d, "npm", npmInstallArgs(spec, d.teamDir, latest), undefined, NPM_PLUGIN_HINT);
}

/** Clone a git package fresh into its install dir and check out its ref. */
export function cloneGit(spec: GitPackageSpec, d: InstallDeps): void {
  const dir = packageInstallDir(spec, d.teamDir);
  // The install dir is ours (under packages/git/): a leftover from a failed add is replaced.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  step(d, "git", ["clone", "--", spec.url, dir]);
  if (spec.ref) step(d, "git", ["-C", dir, "checkout", "--quiet", spec.ref, "--"]);
}

/**
 * Make a fetched git package loadable (see the file comment for the three
 * cases). Throws `PluginInstallError` when npm fails or a built entry is still
 * missing; a package without a usable manifest is left for `validatePackage`.
 */
export function prepareGit(dir: string, d: InstallDeps): void {
  const pkg = readPackageJson(dir);
  if (!pkg) return;
  const manifest = readPluginManifest(dir);
  const entries = "error" in manifest ? [] : manifest.sources;
  const runtimeDeps = hasKeys(pkg.dependencies);

  if (!("error" in manifest) && entriesCommitted(dir, entries, d)) {
    if (!runtimeDeps) {
      d.log("   prebuilt: every mpt.sources entry is in the repository and there are no runtime dependencies — skipping npm");
      return;
    }
    d.log("   prebuilt: every mpt.sources entry is in the repository — installing runtime dependencies only");
    step(d, "npm", ["install", "--omit=peer", "--omit=dev", "--no-audit", "--no-fund"], dir, GIT_PLUGIN_CONTRACT);
    return;
  }

  const anyDeps = ["dependencies", "devDependencies", "optionalDependencies"].some((k) => hasKeys(pkg[k]));
  if (anyDeps) step(d, "npm", ["install", "--omit=peer", "--no-audit", "--no-fund"], dir, GIT_PLUGIN_CONTRACT);
  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  const hasBuild = typeof scripts?.build === "string";
  if (hasBuild) step(d, "npm", ["run", "build"], dir, GIT_PLUGIN_CONTRACT);
  for (const entry of entries) {
    if (fs.existsSync(path.resolve(dir, entry))) continue;
    throw new PluginInstallError(hasBuild
      ? `built, but ${entry} is still missing — check the package's build output / mpt.sources`
      : `${entry} is missing and the package has no build script — commit the built entry or add a "build" script. ${GIT_PLUGIN_CONTRACT}`);
  }
}

/**
 * Are all `entries` part of the checkout (so the package ships them prebuilt)?
 * Asked of git rather than the file system: after an `update`'s reset, an
 * ignored `dist/` from the previous build is still on disk and must not pass
 * for prebuilt, or the new sources would never be rebuilt. When git can't
 * answer (not a work tree), whether the files exist is the next best thing.
 */
function entriesCommitted(dir: string, entries: string[], d: InstallDeps): boolean {
  const rels = entries.map((e) => path.relative(dir, path.resolve(dir, e)).split(path.sep).join("/"));
  if (rels.some((r) => !r || r.startsWith("..") || path.isAbsolute(r))) return false;
  if (rels.length === 0) return true;
  const r = d.run("git", ["-C", dir, "ls-files", "-z", "--", ...rels], { capture: true });
  if (r.code !== 0) return rels.every((rel) => fs.existsSync(path.join(dir, rel)));
  const tracked = new Set(r.stdout.split("\0").filter(Boolean));
  return rels.every((rel) => tracked.has(rel) && fs.existsSync(path.join(dir, rel)));
}

function hasKeys(v: unknown): boolean {
  return typeof v === "object" && v !== null && Object.keys(v).length > 0;
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Check what the loader will check: the package has a valid `"mpt"` manifest
 * and every source entry exists inside it. Returns the entries.
 */
export function validatePackage(dir: string): string[] {
  const manifest = readPluginManifest(dir);
  if ("error" in manifest) throw new PluginInstallError(manifest.error);
  for (const entry of manifest.sources) {
    const file = path.resolve(dir, entry);
    const rel = path.relative(dir, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new PluginInstallError(`${dir}: source entry ${entry} is outside the package`);
    if (!fs.existsSync(file)) throw new PluginInstallError(`${dir}: source entry ${entry} does not exist (is the package built?)`);
  }
  return manifest.sources;
}

/**
 * Install one npm or git package fresh (a clone replaces any leftover) and
 * validate it. Returns its source entries. Local specs are refused — they load
 * in place and are never installed or modified.
 */
export function installPackage(spec: PackageSpec, d: InstallDeps): string[] {
  if (spec.kind === "local") throw new PluginInstallError(`${spec.raw} is a local path: it loads in place and is never installed`);
  const dir = packageInstallDir(spec, d.teamDir);
  if (spec.kind === "npm") installNpm(spec, d);
  else {
    cloneGit(spec, d);
    prepareGit(dir, d);
  }
  return validatePackage(dir);
}

/** Delete an installed npm or git package (never a local one). Best effort for npm's bookkeeping. */
export function uninstallPackage(spec: PackageSpec, d: Pick<InstallDeps, "teamDir" | "run">): void {
  if (spec.kind === "local") return;
  const dir = packageInstallDir(spec, d.teamDir);
  if (spec.kind === "npm" && fs.existsSync(path.join(npmPluginPrefix(d.teamDir), "package.json"))) {
    // Drops it from the prefix's package.json too; the rmSync below covers a failure.
    d.run("npm", ["uninstall", "--prefix", npmPluginPrefix(d.teamDir), "--no-audit", "--no-fund", spec.name], {});
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * The daemon's install-on-start (pi-style): every configured npm/git package
 * whose install dir is missing is installed — the same `installPackage` as
 * `mpt plugins add`, without touching config.json. Per-package isolation: a
 * failure is logged, its partial install removed, and it's returned (identity →
 * message) for the loader to record as that package's status; the rest go on.
 * Each identity is attempted at most once per call (one call per startup).
 * Local paths are never installed or modified.
 */
export function installMissingPackages(config: Pick<TeamConfig, "packages">, d: InstallDeps): Map<string, string> {
  const failures = new Map<string, string>();
  const attempted = new Set<string>();
  for (const { spec } of parsePackageEntries(config.packages, d.teamDir).packages) {
    if (spec.kind === "local" || attempted.has(spec.identity)) continue;
    attempted.add(spec.identity);
    if (fs.existsSync(packageInstallDir(spec, d.teamDir))) continue;
    d.log(`${spec.raw}: not installed — installing…`);
    try {
      installPackage(spec, d);
      d.log(`${spec.raw}: installed`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      d.log(`${spec.raw}: install failed: ${message}`);
      failures.set(spec.identity, message);
      try {
        uninstallPackage(spec, d);
      } catch {
        // best effort: a leftover dir is replaced by the next attempt
      }
    }
  }
  return failures;
}

/** The install-on-start per-command limit: `MPT_PLUGIN_INSTALL_TIMEOUT_MS` when a positive number, else the default. */
export function pluginInstallTimeoutMs(env: string | undefined = process.env["MPT_PLUGIN_INSTALL_TIMEOUT_MS"]): number {
  const n = env ? Number(env) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS;
}

/**
 * Run a command with spawnSync: stdout streamed to this terminal (or captured),
 * stderr captured (and echoed, unless capturing) — so a failure can quote its tail. A command
 * killed by `timeoutMs` reports `TIMEOUT_EXIT_CODE`; one that can't start, 127.
 */
export function runPluginCommand(cmd: string, args: string[], opts: PluginRunOptions): PluginRunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    // stderr is always kept (for a failure's tail); it's echoed unless captured.
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
  const stderr = r.stderr ?? "";
  if (!opts.capture && stderr) process.stderr.write(stderr);
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return { code: TIMEOUT_EXIT_CODE, stdout: r.stdout ?? "", stderr };
  if (r.error) return { code: 127, stdout: "", stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr };
}
