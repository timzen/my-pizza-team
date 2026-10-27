/**
 * cli/plugins.ts — `mpt plugins add|list|remove|update`: manage the team's plugin
 * packages (`TeamConfig.packages`). See docs/DESIGN.md "Plugin packages" and
 * docs/ARCHITECTURE.md "Plugin packages".
 *
 * The daemon only *loads* plugins (daemon/plugins/loader.ts); this is the half
 * that fetches them and edits config.json. Both sides share the spec parser
 * (daemon/plugins/spec.ts) and the install layout (`packageInstallDir`), so an
 * installed package is exactly where the loader looks:
 *
 *   - npm:   `npm install --prefix <teamDir>/packages/npm --omit=peer <name>[@version]`
 *   - git:   `git clone` into `<teamDir>/packages/git/<host>/<path>`, check out the
 *            `@ref`, then prepare it: nothing for a prebuilt package (entries
 *            committed, no runtime deps), else `npm install` and `npm run build`
 *   - local: loaded in place; only validated, never copied or deleted
 *
 * The fetch/prepare steps themselves live in daemon/plugins/install.ts, shared
 * with the daemon's install-on-start and `mpt plugins doctor <uninstalled spec>`.
 *
 * `--omit=peer` keeps the host package (`my-pizza-team`, a plugin's peer
 * dependency) out of the plugin's tree, so a plugin resolves the host's copy.
 *
 * **Pinned vs unpinned** (what `update` re-fetches): an npm entry with a
 * version, and a git entry whose ref is a tag or a commit, are pinned; an npm
 * entry without a version, and a git entry with no ref or a branch ref, are
 * not. Local entries are never updated.
 *
 * Every command validates before it writes config.json (`add` refuses a package
 * without an `"mpt"` manifest, or a duplicate identity), and every mutating
 * command ends by saying the daemon must be restarted — loading happens once,
 * at startup (no hot reload).
 *
 * Side effects go through `PluginsDeps` so tests can stub the network-bound
 * commands (npm) while running real git against a local repository.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginLoadStatus, WorkSourcesResponse } from "../shared/protocol.ts";
import type { PackageEntry } from "../shared/types.ts";
import { packageInstallDir } from "../daemon/plugins/loader.ts";
import {
  cloneGit, gitStep, type InstallDeps, installNpm, PluginInstallError, type PluginRunner,
  prepareGit, uninstallPackage, validatePackage,
} from "../daemon/plugins/install.ts";
import { type GitPackageSpec, type PackageSpec, parsePackageEntries } from "../daemon/plugins/spec.ts";
import { DoctorUsageError, runPluginsDoctor } from "./plugins-doctor.ts";

export { npmInstallArgs, type PluginRunResult, runPluginCommand } from "../daemon/plugins/install.ts";

/** Side effects of `mpt plugins` (stubbed in tests). */
export interface PluginsDeps {
  teamDir: string;
  /** Where relative local paths given on the command line resolve from. */
  cwd: string;
  /**
   * Run a command. Output streams to the terminal unless `capture` is set, in
   * which case stdout is returned (used for git queries); stderr is returned
   * too when the runner keeps it (quoted when an install step fails). Never throws.
   */
  run: PluginRunner;
  /** Each plugin package's load status from the running daemon, or null when it can't be reached. */
  fetchStatuses: () => Promise<PluginLoadStatus[] | null>;
  /** How to restart the daemon, for the closing hint. */
  restartHint: string;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Thrown for a user-facing failure; `runPlugins` prints the message and exits 1. */
class PluginsError extends Error {}

const USAGE = `Usage:
  mpt plugins add <spec> [--config '<json>']   Install a plugin package and add it to config.json
  mpt plugins list                             Configured packages, install state, and load status
  mpt plugins remove <spec|identity>           Remove it from config.json and delete its install
  mpt plugins update [<spec|identity>]         Re-fetch unpinned npm/git packages (all, or one)
  mpt plugins doctor [<path|spec|identity>]    Check packages load (all configured, or one, configured or not):
                                               manifest, import, export, apiVersion, ids. No init/sync; an uninstalled
                                               npm/git spec is installed into a temp cache first (removed after).
      [--config '<json>' | --config team]      …and run one package live on a throwaway context: the factory,
                                               init, sync (twice), item checks. "team" = its config.json config
      [--source <id>] [--hooks] [--json]       one source only; also call onComment/onItemTerminal; JSON output

Specs: npm:<name>[@version], git:<host>/<path>[@ref], https://… or ssh://… git URLs [@ref],
or a local path (absolute, ./, ../, ~/; relative paths resolve from the current directory).`;

/** `mpt plugins <subcommand> …`. Returns the exit code. */
export async function runPlugins(args: string[], d: PluginsDeps): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "add":
        return cmdAdd(rest, d);
      case "list":
      case "ls":
        return await cmdList(d);
      case "remove":
      case "rm":
        return cmdRemove(rest, d);
      case "update":
        return cmdUpdate(rest, d);
      case "doctor":
        return await runPluginsDoctor(rest, d);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        d.log(USAGE);
        return sub === undefined ? 1 : 0;
      default:
        d.error(`❌ Unknown plugins command: ${sub}`);
        d.log(USAGE);
        return 1;
    }
  } catch (e) {
    if (e instanceof PluginsError || e instanceof DoctorUsageError || e instanceof PluginInstallError) {
      d.error(`❌ ${e.message}`);
      return 1;
    }
    throw e;
  }
}

// --- config.json ---

function configPath(teamDir: string): string {
  return path.join(teamDir, "config.json");
}

/**
 * The team's config.json as written (not merged with defaults, so writing it
 * back adds nothing the user didn't have). A missing file is `{}` when the team
 * dir exists; a missing team dir is an error (run `mpt setup` first).
 */
export function readRawConfig(teamDir: string): Record<string, unknown> {
  const file = configPath(teamDir);
  if (!fs.existsSync(file)) {
    if (!fs.existsSync(teamDir)) throw new PluginsError(`No team directory at ${teamDir} — run \`mpt setup\` first (or set TEAM_DIR).`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new PluginsError(`Cannot parse ${file}: ${(e as Error).message}`);
  }
}

/** Write config.json back (temp file + rename, so a crash can't leave it half-written). */
function writeRawConfig(teamDir: string, config: Record<string, unknown>): void {
  const file = configPath(teamDir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** The raw `packages` array (empty when unset); anything else is an error rather than silently replaced. */
function rawPackages(config: Record<string, unknown>): unknown[] {
  const p = config.packages;
  if (p === undefined || p === null) return [];
  if (!Array.isArray(p)) throw new PluginsError(`config.json "packages" must be an array (it is ${JSON.stringify(p)}); fix it by hand first.`);
  return p;
}

/** One configured entry: its index in the raw array and its parsed spec (null when it doesn't parse). */
interface ConfiguredEntry {
  index: number;
  raw: unknown;
  spec: PackageSpec | null;
  error?: string;
}

/** Parse each raw entry on its own, keeping its index so it can be removed from the raw array. */
function configuredEntries(raw: unknown[], teamDir: string): ConfiguredEntry[] {
  return raw.map((entry, index) => {
    const parsed = parsePackageEntries([entry], teamDir);
    const ok = parsed.packages[0];
    return ok ? { index, raw: entry, spec: ok.spec } : { index, raw: entry, spec: null, error: parsed.errors[0] };
  });
}

// --- spec handling ---

/**
 * A spec typed on the command line: relative local paths resolve from the
 * current directory (where the user is), not the team dir (where config.json
 * specs resolve from), so the absolute path is what gets written.
 */
export function normalizeCliSpec(raw: string, cwd: string): string {
  const s = raw.trim();
  const relative = s === "." || s === ".." || s.startsWith("./") || s.startsWith("../");
  return relative ? path.resolve(cwd, s) : s;
}

/** Parse a spec typed on the command line (see `normalizeCliSpec`), or throw its parse error. */
function parseCliSpec(raw: string, d: PluginsDeps): PackageSpec {
  const parsed = parsePackageEntries([normalizeCliSpec(raw, d.cwd)], d.teamDir);
  const spec = parsed.packages[0]?.spec;
  if (!spec) throw new PluginsError(parsed.errors[0] ?? `Invalid package spec ${JSON.stringify(raw)}`);
  return spec;
}

/**
 * The configured entries a `remove`/`update` argument names: the spec as
 * written, the identity (e.g. a bare npm name), or any spec with the same
 * identity (`git:host/x` names `https://host/x.git@v1`).
 */
function findEntries(entries: ConfiguredEntry[], arg: string, d: PluginsDeps): ConfiguredEntry[] {
  let identity: string | null = null;
  const parsed = parsePackageEntries([normalizeCliSpec(arg, d.cwd)], d.teamDir);
  if (parsed.packages[0]) identity = parsed.packages[0].spec.identity;
  return entries.filter((e) => {
    const raw = typeof e.raw === "string" ? e.raw : (e.raw as { source?: unknown } | null)?.source;
    return raw === arg || e.spec?.identity === arg || (identity !== null && e.spec?.identity === identity);
  });
}

/** The version (npm) or ref (git) a spec asks for, if any. */
function refOf(spec: PackageSpec): string | undefined {
  return spec.kind === "npm" ? spec.version : spec.kind === "git" ? spec.ref : undefined;
}

/** A plain `{ … }` JSON object from `--config`, or an error. */
export function parseConfigFlag(json: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch (e) {
    throw new PluginsError(`--config is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new PluginsError("--config must be a JSON object, e.g. '{\"tokenEnv\":\"JIRA_TOKEN\"}'");
  return v as Record<string, unknown>;
}

/** Split `add`'s arguments into the spec and the `--config` JSON (`--config <json>` or `--config=<json>`). */
function parseAddArgs(args: string[]): { spec: string; config?: Record<string, unknown> } {
  let spec: string | undefined;
  let config: Record<string, unknown> | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--config") {
      const v = args[++i];
      if (v === undefined) throw new PluginsError("--config needs a JSON object");
      config = parseConfigFlag(v);
    } else if (a.startsWith("--config=")) {
      config = parseConfigFlag(a.slice("--config=".length));
    } else if (a.startsWith("--")) {
      throw new PluginsError(`Unknown option ${a}`);
    } else if (spec === undefined) {
      spec = a;
    } else {
      throw new PluginsError(`Unexpected argument ${a} (one spec at a time)`);
    }
  }
  if (!spec) throw new PluginsError("Usage: mpt plugins add <spec> [--config '<json>']");
  return { spec, config };
}

// --- install / fetch (daemon/plugins/install.ts; this adds update's git queries) ---

/** The install deps of a `mpt plugins` run (no timeout: the user is watching and can Ctrl-C). */
function installDeps(d: PluginsDeps): InstallDeps {
  return { teamDir: d.teamDir, run: d.run, log: d.log };
}

/**
 * Is a git entry's ref a branch (so `update` follows it)? No ref follows the
 * default branch; a tag or a commit is pinned. Asked of the clone, after
 * fetching, since only the remote knows which a name is.
 */
function gitRefIsBranch(spec: GitPackageSpec, dir: string, d: PluginsDeps): boolean {
  if (!spec.ref) return true;
  return d.run("git", ["-C", dir, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${spec.ref}`], { capture: true }).code === 0;
}

/** Bring a clone up to its remote branch (`origin/<ref>`, or the default branch `origin/HEAD`). */
function pullGit(spec: GitPackageSpec, dir: string, d: PluginsDeps): void {
  gitStep(installDeps(d), ["-C", dir, "reset", "--hard", "--quiet", spec.ref ? `origin/${spec.ref}` : "origin/HEAD"]);
}

function restartNote(d: PluginsDeps): void {
  d.log(`\n   ⚠️  Restart the daemon to apply: ${d.restartHint}`);
}

// --- commands ---

/** `add <spec> [--config <json>]`: install, validate, then append to config.json. */
function cmdAdd(args: string[], d: PluginsDeps): number {
  const { spec: rawSpec, config: pluginConfig } = parseAddArgs(args);
  const config = readRawConfig(d.teamDir);
  const raw = rawPackages(config);
  const spec = parseCliSpec(rawSpec, d);
  const written = normalizeCliSpec(rawSpec, d.cwd);

  const dup = configuredEntries(raw, d.teamDir).find((e) => e.spec?.identity === spec.identity);
  if (dup) throw new PluginsError(`${spec.identity} is already configured (as ${JSON.stringify(dup.raw)}); \`mpt plugins remove\` it first, or \`mpt plugins update\` it.`);

  const dir = packageInstallDir(spec, d.teamDir);
  d.log(`Adding ${written} (${spec.kind})…`);
  let sources: string[];
  try {
    if (spec.kind === "npm") installNpm(spec, installDeps(d));
    else if (spec.kind === "git") {
      cloneGit(spec, installDeps(d));
      prepareGit(dir, installDeps(d));
    } else if (!fs.existsSync(dir)) {
      throw new PluginsError(`${dir} does not exist`);
    }
    sources = validatePackage(dir);
  } catch (e) {
    // Don't leave a half-installed package behind that config.json doesn't mention.
    if (spec.kind !== "local") uninstallPackage(spec, installDeps(d));
    throw e;
  }

  const entry: PackageEntry = pluginConfig ? { source: written, config: pluginConfig } : written;
  config.packages = [...raw, entry];
  writeRawConfig(d.teamDir, config);
  d.log(`✅ Added ${written}${spec.kind === "local" ? ` (loads in place from ${dir})` : ` (installed at ${dir})`}`);
  d.log(`   Source entries: ${sources.length ? sources.join(", ") : "none"}`);
  restartNote(d);
  return 0;
}

/** `list`: each configured entry with kind, identity, ref, installed?, and the daemon's load status. */
async function cmdList(d: PluginsDeps): Promise<number> {
  const raw = rawPackages(readRawConfig(d.teamDir));
  if (raw.length === 0) {
    d.log("No plugin packages configured. Add one with `mpt plugins add <spec>`.");
    return 0;
  }
  const statuses = await d.fetchStatuses();
  for (const e of configuredEntries(raw, d.teamDir)) {
    const shown = typeof e.raw === "string" ? e.raw : JSON.stringify(e.raw);
    if (!e.spec) {
      d.log(`✗ ${shown}\n    ${e.error}`);
      continue;
    }
    const dir = packageInstallDir(e.spec, d.teamDir);
    const installed = fs.existsSync(dir);
    d.log(`${installed ? "•" : "✗"} ${e.spec.raw}`);
    d.log(`    kind: ${e.spec.kind}   identity: ${e.spec.identity}   ref: ${refOf(e.spec) ?? "-"}`);
    d.log(`    installed: ${installed ? `yes (${dir})` : `no (expected at ${dir})`}`);
    if (statuses === null) {
      d.log("    status: unknown (daemon not running)");
    } else {
      const s = statuses.find((st) => st.identity === e.spec!.identity);
      if (!s) d.log("    status: not loaded (added since the daemon started? restart it)");
      else if (s.state === "loaded") d.log(`    status: loaded${s.sources.length ? ` (sources: ${s.sources.join(", ")})` : ""}`);
      else d.log(`    status: error — ${s.error ?? "unknown error"}`);
    }
  }
  return 0;
}

/** `remove <spec|identity>`: drop it from config.json and delete its install (never a local path). */
function cmdRemove(args: string[], d: PluginsDeps): number {
  const [arg, ...extra] = args;
  if (!arg || extra.length) throw new PluginsError("Usage: mpt plugins remove <spec|identity>");
  const config = readRawConfig(d.teamDir);
  const raw = rawPackages(config);
  const matches = findEntries(configuredEntries(raw, d.teamDir), arg, d);
  if (matches.length === 0) throw new PluginsError(`No configured package matches ${arg} (see \`mpt plugins list\`).`);

  const drop = new Set(matches.map((m) => m.index));
  config.packages = raw.filter((_, i) => !drop.has(i));
  writeRawConfig(d.teamDir, config);
  for (const m of matches) {
    const shown = typeof m.raw === "string" ? m.raw : JSON.stringify(m.raw);
    if (m.spec && m.spec.kind !== "local") {
      uninstallPackage(m.spec, installDeps(d));
      d.log(`✅ Removed ${shown} (deleted ${packageInstallDir(m.spec, d.teamDir)})`);
    } else {
      d.log(`✅ Removed ${shown}${m.spec ? " (a local path: left on disk)" : ""}`);
    }
  }
  restartNote(d);
  return 0;
}

/**
 * `update [<spec|identity>]`: re-fetch unpinned npm/git entries and rebuild;
 * pinned and local entries are skipped. A configured package that isn't
 * installed (a fresh clone of the team's config, say) is installed, pinned or not.
 */
function cmdUpdate(args: string[], d: PluginsDeps): number {
  const [arg, ...extra] = args;
  if (extra.length) throw new PluginsError("Usage: mpt plugins update [<spec|identity>]");
  const raw = rawPackages(readRawConfig(d.teamDir));
  const entries = configuredEntries(raw, d.teamDir);
  const targets = arg ? findEntries(entries, arg, d) : entries;
  if (arg && targets.length === 0) throw new PluginsError(`No configured package matches ${arg} (see \`mpt plugins list\`).`);
  if (targets.length === 0) {
    d.log("No plugin packages configured.");
    return 0;
  }

  let changed = 0;
  let failed = 0;
  for (const e of targets) {
    if (!e.spec) {
      d.log(`· skipping an invalid entry: ${e.error}`);
      continue;
    }
    const spec = e.spec;
    if (spec.kind === "local") {
      d.log(`· ${spec.raw}: local path, loads in place — skipped`);
      continue;
    }
    const dir = packageInstallDir(spec, d.teamDir);
    const installed = fs.existsSync(dir);
    try {
      if (spec.kind === "npm") {
        if (installed && spec.version) {
          d.log(`· ${spec.raw}: pinned to ${spec.version} — skipped`);
          continue;
        }
        d.log(`${installed ? "Updating" : "Installing"} ${spec.raw}…`);
        installNpm(spec, installDeps(d), installed);
      } else if (!installed) {
        d.log(`Installing ${spec.raw}…`);
        cloneGit(spec, installDeps(d));
        prepareGit(dir, installDeps(d));
      } else {
        gitStep(installDeps(d), ["-C", dir, "fetch", "--quiet", "--prune", "--tags", "origin"]);
        if (!gitRefIsBranch(spec, dir, d)) {
          d.log(`· ${spec.raw}: pinned to ${spec.ref} — skipped`);
          continue;
        }
        d.log(`Updating ${spec.raw}…`);
        pullGit(spec, dir, d);
        prepareGit(dir, installDeps(d));
      }
      validatePackage(dir);
      changed++;
      d.log(`✅ ${spec.raw} is up to date`);
    } catch (err) {
      failed++;
      d.error(`❌ ${spec.raw}: ${(err as Error).message}`);
    }
  }
  if (changed > 0) restartNote(d);
  return failed > 0 ? 1 : 0;
}

// --- the real side effects ---

/** `GET /api/work-sources` `plugins` from the daemon at `daemonUrl`, or null when it can't be reached. */
export async function fetchPluginStatuses(daemonUrl: string, token: string | null): Promise<PluginLoadStatus[] | null> {
  try {
    const res = await fetch(`${daemonUrl}/api/work-sources`, {
      signal: AbortSignal.timeout(1500),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return (await res.json() as Partial<WorkSourcesResponse>).plugins ?? null;
  } catch {
    return null;
  }
}
