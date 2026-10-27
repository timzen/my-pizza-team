/**
 * daemon/plugins/loader.ts — Load plugin packages' Work Sources at daemon startup.
 * See docs/DESIGN.md "Plugin packages" and docs/ARCHITECTURE.md "Plugin packages".
 *
 * For each `TeamConfig.packages` entry (parsed by daemon/plugins/spec.ts):
 *
 *   1. **Resolve** it to a directory: a local path is used in place; an npm or
 *      git package is the copy `mpt plugins` installed under `<teamDir>/packages/`
 *      (`packageInstallDir` defines that layout for both sides). A configured
 *      package that wasn't installed has just been installed by the daemon
 *      (daemon/plugins/install.ts `installMissingPackages`, run first); one
 *      whose install failed is reported with that failure (`installErrors`).
 *   2. **Read the manifest**: the package.json `"mpt": { "sources": [...] }`.
 *      Other keys under `"mpt"` are ignored, leaving room for future plugin kinds.
 *   3. **Import** each source entry and take its default export: a `WorkSource`
 *      object, or a factory `(options, { teamDir }) => WorkSource | Promise<WorkSource>`.
 *   4. **Register** it with the package entry's `config` as `ctx.options()`. The
 *      registry's own checks apply (apiVersion, duplicate id, an external
 *      source's id pattern), so a plugin can't shadow a built-in.
 *   5. **Check its settings** against its `configSchema`, if it declares one
 *      (daemon/sources/config-schema.ts): a mismatch is logged and recorded in
 *      the package's `warnings`, never refused — the source may cope, and a
 *      person fixes it from the Config page.
 *
 * Before the first import it installs the host resolve hook
 * (daemon/plugins/host-resolve.ts), so a plugin's `import … from
 * "my-pizza-team/plugin"` gets this daemon's copy of the public surface
 * (plugin/index.ts) without installing it.
 *
 * Isolation is by error handling, not by process: every failure — a bad spec,
 * a missing install, a missing manifest, a throwing import or factory, a
 * rejected registration — is logged with the `[plugins]` prefix and recorded
 * in that package's status, and the daemon and the other plugins carry on.
 * Loading runs once at startup; a change needs a restart (no hot reload).
 *
 * Steps 1–3 are exported one by one (`resolvePackageDir`, `readPluginManifest`,
 * `resolveSourceEntry`, `importSourceEntry`, `instantiateSource`) so `mpt
 * plugins doctor` (cli/plugins-doctor.ts) checks a package along exactly this path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginLoadStatus } from "../../shared/protocol.ts";
import type { TeamConfig } from "../../shared/types.ts";
import type { RegisterSourceOptions } from "../sources/registry.ts";
import type { WorkSource } from "../sources/types.ts";
import { sourceConfigWarnings } from "../sources/config-schema.ts";
import { type PackageSpec, type ParsedPackageEntry, parsePackageEntries } from "./spec.ts";
import { registerHostResolution } from "./host-resolve.ts";

/** The team-dir folder `mpt plugins` installs npm and git packages into. */
export const PLUGIN_PACKAGES_DIR = "packages";

/** How long one entry's import, or its factory, may take before it counts as failed. */
export const DEFAULT_PLUGIN_LOAD_TIMEOUT_MS = 10_000;

/** `<teamDir>/packages`: where installed plugin packages live. */
export function pluginPackagesDir(teamDir: string): string {
  return path.join(teamDir, PLUGIN_PACKAGES_DIR);
}

/**
 * `<teamDir>/packages/npm`: the one npm prefix every npm plugin is installed
 * into (`npm install --prefix <this> <name>@<version>`), so each package lands
 * at `node_modules/<name>` with its dependencies beside it.
 */
export function npmPluginPrefix(teamDir: string): string {
  return path.join(pluginPackagesDir(teamDir), "npm");
}

/**
 * Where a package is (or should be) on disk — the one place the install layout
 * is defined, shared by this loader and the `mpt plugins` CLI:
 *
 *   - local: the path itself, loaded in place (never copied)
 *   - npm:   `<teamDir>/packages/npm/node_modules/<name>` (scoped: `…/@scope/<name>`)
 *   - git:   `<teamDir>/packages/git/<host>/<path>` (a clone; a trailing `.git` dropped)
 *
 * The ref / version isn't part of the path: one copy per identity, which is
 * also how specs are deduped, so `update` replaces it in place.
 */
export function packageInstallDir(spec: PackageSpec, teamDir: string): string {
  switch (spec.kind) {
    case "local":
      return spec.path;
    case "npm":
      return path.join(npmPluginPrefix(teamDir), "node_modules", ...spec.name.split("/"));
    case "git":
      return path.join(pluginPackagesDir(teamDir), "git", ...gitPathSegments(spec.url));
  }
}

/**
 * `<host>/<path…>` of a git URL as directory segments. Empty, `.` and `..`
 * segments are dropped so a crafted URL can't place a clone outside
 * `packages/git/` (the URL parser already collapses dot segments; this is
 * belt and braces).
 */
function gitPathSegments(url: string): string[] {
  const u = new URL(url);
  const segments = u.pathname.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }).filter((s) => s && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\"));
  const last = segments.length - 1;
  if (last >= 0) segments[last] = segments[last]!.replace(/\.git$/, "");
  return [u.hostname, ...segments.filter(Boolean)];
}

/** What the loader needs from the daemon: the Store's registration seam. */
export interface PluginHost {
  registerWorkSource(source: WorkSource, opts?: RegisterSourceOptions): void;
}

/** The second argument of a factory default export. */
export interface PluginFactoryContext {
  /** The team directory, e.g. for state that outlives `ctx.kv`. */
  teamDir: string;
}

/**
 * The factory form of a source entry's default export: called once at load
 * with the package entry's `config` (frozen) and returns the WorkSource.
 */
export type PluginFactory = (options: Readonly<Record<string, unknown>>, context: PluginFactoryContext) => WorkSource | Promise<WorkSource>;

export interface LoadPluginsOptions {
  /** Per-entry limit on import and factory (default `DEFAULT_PLUGIN_LOAD_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Where messages go (default: console, `[plugins]`-prefixed). */
  log?: (message: string) => void;
  /**
   * Packages whose install-on-start failed (identity → why;
   * daemon/plugins/install.ts `installMissingPackages`): recorded as that
   * package's error instead of a bare "not installed".
   */
  installErrors?: ReadonlyMap<string, string>;
}

/**
 * Load every `packages` entry of `config` and register its Work Sources with
 * `host`, one package after another (so registration order follows config
 * order). Never rejects: returns one status per entry — the valid ones in
 * config order, then the rejected ones (bad spec, duplicate identity).
 * Call after the built-ins are registered and before `startTimers`, so a
 * plugin's sync timer starts with the rest.
 */
export async function loadPlugins(
  host: PluginHost,
  config: Pick<TeamConfig, "packages">,
  teamDir: string,
  opts: LoadPluginsOptions = {},
): Promise<PluginLoadStatus[]> {
  const log = opts.log ?? ((m: string) => console.warn(`[plugins] ${m}`));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PLUGIN_LOAD_TIMEOUT_MS;
  // Before any plugin import: `my-pizza-team/plugin` must resolve to this daemon's copy.
  registerHostResolution();
  const parsed = parsePackageEntries(config.packages, teamDir);
  const statuses: PluginLoadStatus[] = [];

  for (const entry of parsed.packages) {
    const installError = opts.installErrors?.get(entry.spec.identity);
    const status: PluginLoadStatus = installError !== undefined
      ? { identity: entry.spec.identity, spec: entry.spec.raw, state: "error", error: `install failed: ${installError}`, sources: [] }
      : await loadPackage(host, entry, teamDir, timeoutMs);
    for (const w of status.warnings ?? []) log(`${status.spec}: warning: ${w}`);
    if (status.state === "loaded") log(`${status.spec}: loaded (${status.sources.length ? `sources: ${status.sources.join(", ")}` : "no sources"})`);
    else log(`${status.spec}: ${status.error}${status.sources.length ? ` (still registered: ${status.sources.join(", ")})` : ""}`);
    statuses.push(status);
  }
  for (const r of parsed.rejected) {
    log(r.error);
    statuses.push({ identity: r.identity ?? null, spec: r.raw, state: "error", error: r.error, sources: [] });
  }
  return statuses;
}

/** One package: resolve, read its manifest, then load each source entry; failures are collected, not thrown. */
async function loadPackage(host: PluginHost, { spec, config }: ParsedPackageEntry, teamDir: string, timeoutMs: number): Promise<PluginLoadStatus> {
  const status: PluginLoadStatus = { identity: spec.identity, spec: spec.raw, state: "loaded", sources: [] };
  const failed = (error: string): PluginLoadStatus => ({ ...status, state: "error", error });

  const resolved = resolvePackageDir(spec, teamDir);
  if ("error" in resolved) return failed(resolved.error);
  const { dir } = resolved;
  const manifest = readPluginManifest(dir);
  if ("error" in manifest) return failed(manifest.error);

  const errors: string[] = [];
  for (const entry of manifest.sources) {
    try {
      const source = await loadEntry(dir, entry, config, teamDir, timeoutMs);
      host.registerWorkSource(source, { options: config });
      status.sources.push(source.id);
      const warnings = sourceConfigWarnings(source, config).map((w) => `source "${source.id}": ${w}`);
      if (warnings.length) status.warnings = [...(status.warnings ?? []), ...warnings];
    } catch (e) {
      errors.push(`${entry}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return errors.length ? { ...status, state: "error", error: errors.join("; ") } : status;
}

/**
 * Step 1 — where a package is, if it's there: its install dir (or local path),
 * or why it can't be loaded (missing; not installed). Shared with `mpt plugins
 * doctor` (cli/plugins-doctor.ts), which runs the same steps one by one.
 */
export function resolvePackageDir(spec: PackageSpec, teamDir: string): { dir: string } | { error: string } {
  const dir = packageInstallDir(spec, teamDir);
  if (fs.existsSync(dir)) return { dir };
  return {
    error: spec.kind === "local"
      ? `${dir} does not exist`
      : `not installed (expected at ${dir}); run \`mpt plugins add ${spec.raw}\` or \`mpt plugins update\``,
  };
}

/**
 * The package.json `"mpt"` manifest's source entries, or why there are none to
 * load. Shared with `mpt plugins add` (cli/plugins.ts), which validates a
 * package with it before writing config.json.
 */
export function readPluginManifest(dir: string): { sources: string[] } | { error: string } {
  const file = path.join(dir, "package.json");
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const mpt = isObject(pkg) ? pkg.mpt : undefined;
  if (!isObject(mpt)) return { error: `${file} has no "mpt" manifest (expected "mpt": { "sources": ["./dist/index.js"] })` };
  // No `sources` is a package for some other (future) plugin kind: nothing to load here, not an error.
  if (mpt.sources === undefined) return { sources: [] };
  if (!Array.isArray(mpt.sources) || !mpt.sources.every((s) => typeof s === "string" && s.trim())) {
    return { error: `${file}: "mpt.sources" must be an array of entry paths` };
  }
  return { sources: mpt.sources as string[] };
}

/**
 * Import one entry and turn its default export into a WorkSource: the steps
 * below, in order. Throws with a readable message; the caller records it.
 */
async function loadEntry(dir: string, entry: string, options: Record<string, unknown>, teamDir: string, timeoutMs: number): Promise<WorkSource> {
  const file = resolveSourceEntry(dir, entry);
  const exported = await importSourceEntry(file, timeoutMs);
  return await instantiateSource(exported, options, { teamDir }, timeoutMs);
}

/**
 * Step 3a — the absolute file of one `mpt.sources` entry. The entry must stay
 * inside the package (a manifest can't point the daemon at arbitrary files)
 * and exist. Throws why not.
 */
export function resolveSourceEntry(dir: string, entry: string): string {
  const file = path.resolve(dir, entry);
  const rel = path.relative(dir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("the entry is outside the package");
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist (is the package built?)`);
  return file;
}

/**
 * Step 3b — import an entry file (bounded by `timeoutMs`) and return its
 * default export. Registers the host resolve hook first (idempotent), so
 * `my-pizza-team/plugin` resolves to this host whoever calls it. Throws when
 * the import fails or there is no default export.
 */
export async function importSourceEntry(file: string, timeoutMs: number = DEFAULT_PLUGIN_LOAD_TIMEOUT_MS): Promise<unknown> {
  registerHostResolution();
  const mod = await withTimeout(import(pathToFileURL(file).href) as Promise<Record<string, unknown>>, timeoutMs, "import");
  const exported = mod.default;
  if (exported === undefined) throw new Error("no default export (expected a WorkSource or a factory returning one)");
  return exported;
}

/** Is a default export the factory form (`(options, { teamDir }) => WorkSource`) rather than a WorkSource? */
export function isPluginFactory(exported: unknown): exported is PluginFactory {
  return typeof exported === "function";
}

/**
 * Step 3c — a default export as a WorkSource: a factory is called (bounded by
 * `timeoutMs`) with a frozen copy of `options` and `context`; an object is
 * used as is. Either way the result must look like a WorkSource (a string
 * id). The registry checks the rest (apiVersion, duplicate id, id pattern).
 */
export async function instantiateSource(
  exported: unknown, options: Record<string, unknown>, context: PluginFactoryContext, timeoutMs: number = DEFAULT_PLUGIN_LOAD_TIMEOUT_MS,
): Promise<WorkSource> {
  const source = isPluginFactory(exported)
    ? await withTimeout(Promise.resolve(exported(Object.freeze({ ...options }), context)), timeoutMs, "factory")
    : exported;
  if (!isObject(source) || typeof source.id !== "string" || !source.id) {
    throw new Error("the default export is not a WorkSource (an object with a string id and apiVersion)");
  }
  return source as unknown as WorkSource;
}

/** Reject if `p` hasn't settled in `ms` (the work itself can't be cancelled; it's abandoned). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
