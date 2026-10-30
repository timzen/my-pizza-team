/**
 * cli/plugins-doctor.ts — `mpt plugins doctor`: check a plugin package before
 * (or after) it goes into a real team. See GUIDE.md "Testing your plugin" and
 * docs/ARCHITECTURE.md "Plugin packages".
 *
 * Two levels, the second opt-in:
 *
 *   1. **Install check** (always; all it does without `--config`). No network,
 *      no `init`, no `sync`, and a factory export is *not* called. For each
 *      package it runs the daemon loader's own steps one by one
 *      (daemon/plugins/loader.ts `resolvePackageDir`, `readPluginManifest`,
 *      `resolveSourceEntry`, `importSourceEntry` — the real import, with the
 *      host resolve hook registered), then the registry's checks for an
 *      object export (apiVersion, the external id pattern, duplicate ids) and
 *      its personas (docs/DESIGN.md "Work Source personas"): a declared
 *      `defaultPersona` / `triagePersona` that doesn't resolve is ⚠, and a
 *      triage-mode source with no triage persona — declared, or the team's
 *      `sourcePersonas.<id>.triagePersona` — is ✗ (the daemon won't sync it).
 *   2. **Live check** (`--config '<json>'` or `--config team`; exactly one
 *      package). The factory is called as the daemon would, and each source
 *      runs `init` and `sync` (twice, to check revision stability) against a
 *      **throwaway** `SourceContext`: a temp dir as `teamDir`, an in-memory kv,
 *      no-op enqueues that only record. The real team dir is never written.
 *      `--hooks` also calls `onComment` / `onItemTerminal` on the first item.
 *
 * An unconfigured npm/git spec that isn't installed is first installed into a
 * scratch cache (a temp team dir, removed afterwards) through the same
 * installer as `mpt plugins add` (daemon/plugins/install.ts), so a package can
 * be checked straight from its registry or repository.
 *
 * Output is a ✓/⚠/✗ line per check, grouped by package then source, and a
 * summary (`--json`: the same report as JSON). Exit 0 only with no ✗.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_PLUGIN_LOAD_TIMEOUT_MS,
  importSourceEntry,
  instantiateSource,
  isPluginFactory,
  readPluginManifest,
  resolvePackageDir,
  resolveSourceEntry,
  withTimeout,
} from "../daemon/plugins/loader.ts";
import { HOST_PLUGIN_SPECIFIER } from "../daemon/plugins/host-resolve.ts";
import { installPackage, type PluginRunner } from "../daemon/plugins/install.ts";
import { type PackageSpec, parsePackageEntries } from "../daemon/plugins/spec.ts";
import { invalidExternalDef, mirroredWorkDefId } from "../daemon/sources/mirror.ts";
import { invalidExternalComment } from "../daemon/sources/comments.ts";
import { SOURCE_ID_PATTERN, TASK_SOURCE_ID } from "../daemon/sources/registry.ts";
import { DEFAULT_SYNC_TIMEOUT_MS } from "../daemon/sources/sync.ts";
import { type ExternalDef, type SourceContext, WORK_SOURCE_API_VERSION, type WorkSource } from "../daemon/sources/types.ts";
import { normalizeCliSpec } from "./plugins.ts";
import { type Comment, DEFAULT_CONFIG, parsePersonaId, type SourcePersonaSetting, type WorkDef, type WorkItem } from "../shared/types.ts";
import { getBuiltinPersona } from "../daemon/personas/builtins.ts";
import { readTeamPersona } from "../daemon/personas/library.ts";
import { sourcePersonaPick } from "../daemon/sources/persona.ts";

/** What the doctor needs from `mpt plugins` (a subset of `PluginsDeps`). */
export interface PluginsDoctorDeps {
  teamDir: string;
  /** Where relative local paths given on the command line resolve from. */
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Runs npm/git to install an unconfigured, uninstalled spec into a scratch cache (absent: no install). */
  run?: PluginRunner;
}

/** One check's outcome. */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  status: DoctorStatus;
  /** What was checked / found. One line. */
  message: string;
  /** What to do about it, when it isn't ok. */
  hint?: string;
}

/** One item a live sync returned, as printed. */
export interface DoctorItem {
  externalId: string;
  revision: string;
  mode?: string;
  title: string;
  url?: string;
  directory?: string;
  /** The mirrored WorkDef id the daemon would give it. */
  mirrorId?: string;
  /** How many comments it reported (`ExternalDef.comments`), when it reported any list. */
  comments?: number;
}

/** What the throwaway context's queue capabilities were asked to do (they do nothing). */
export interface DoctorCalls {
  enqueue: string[];
  enqueueRevision: Array<{ defId: string; revision: string }>;
  upsertDef: string[];
}

/** One `mpt.sources` entry: its import, its export, and (live) its source's run. */
export interface DoctorSourceReport {
  entry: string;
  /** The source id, once known (an object export, or a called factory). */
  id?: string;
  /** The default export's form, once imported. */
  export?: "object" | "factory";
  checks: DoctorCheck[];
  /** Live only: the items the first sync returned. */
  items?: DoctorItem[];
  /** Live only: what the source logged through `ctx.log`. */
  logs?: string[];
  /** Live only: the recorded queue calls. */
  calls?: DoctorCalls;
}

export interface DoctorPackageReport {
  /** The spec as written (or the raw entry, when it doesn't parse). */
  spec: string;
  kind?: PackageSpec["kind"];
  identity?: string;
  dir?: string;
  /** Whether it is one of the team's configured packages. */
  configured: boolean;
  checks: DoctorCheck[];
  sources: DoctorSourceReport[];
}

export interface DoctorReport {
  /** True when nothing failed (the exit code is 0). */
  ok: boolean;
  /** Whether the live check ran (`--config`). */
  live: boolean;
  packages: DoctorPackageReport[];
  summary: { ok: number; warn: number; fail: number };
}

/** Thrown for a usage error or a bad target; `runPlugins` prints it and exits 1. */
export class DoctorUsageError extends Error {}

/**
 * The built-in sources' ids (daemon/store.ts registers them): a plugin with one
 * of these is rejected as a duplicate at startup.
 */
const BUILT_IN_SOURCE_IDS = [TASK_SOURCE_ID, "story", "schedule", "thought"];

/** The longest directory name most file systems accept, in bytes. */
const MAX_DIR_NAME_BYTES = 255;

const USAGE = "Usage: mpt plugins doctor [<path|spec|identity>] [--config '<json>' | --config team] [--source <id>] [--hooks] [--json]";

interface DoctorArgs {
  target?: string;
  /** `--config`: the JSON object, or "team" (the target's entry in config.json). */
  config?: Record<string, unknown> | "team";
  source?: string;
  hooks: boolean;
  json: boolean;
}

/** One package to check: its parsed spec (or why it didn't parse) and its configured `config`. */
interface Target {
  raw: string;
  spec?: PackageSpec;
  error?: string;
  configured: boolean;
  config?: Record<string, unknown>;
  /** Set when it was installed into a scratch cache: that cache's team dir (removed after the checks). */
  scratchTeamDir?: string;
  /** Why the scratch install failed. */
  installError?: string;
}

/** Parse `doctor`'s arguments (`--flag value` or `--flag=value`). */
function parseArgs(args: string[]): DoctorArgs {
  const out: DoctorArgs = { hooks: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (): string => {
      const v = inline ?? args[++i];
      if (v === undefined) throw new DoctorUsageError(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    if (flag === "--config") {
      const v = value();
      out.config = v === "team" ? "team" : parseConfigJson(v);
    } else if (flag === "--source") out.source = value();
    else if (flag === "--hooks") out.hooks = true;
    else if (flag === "--json") out.json = true;
    else if (a.startsWith("--")) throw new DoctorUsageError(`Unknown option ${a}\n${USAGE}`);
    else if (out.target === undefined) out.target = a;
    else throw new DoctorUsageError(`Unexpected argument ${a} (one package at a time)\n${USAGE}`);
  }
  if (out.config === undefined && (out.source !== undefined || out.hooks)) {
    throw new DoctorUsageError(`--source and --hooks are part of the live check: add --config '<json>' or --config team\n${USAGE}`);
  }
  return out;
}

function parseConfigJson(json: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch (e) {
    throw new DoctorUsageError(`--config is not valid JSON (or "team"): ${(e as Error).message}`);
  }
  if (!isObject(v)) throw new DoctorUsageError("--config must be a JSON object, e.g. '{\"tokenEnv\":\"JIRA_TOKEN\"}', or \"team\"");
  return v;
}

/**
 * What the persona checks read from the team: whether an id resolves, and the
 * team's per-source settings. Package personas are registered by the daemon at
 * startup, so the doctor can't see them: a package id is reported as
 * unverified rather than missing.
 */
interface PersonaCheckContext {
  /** "yes" / "no" for a team or built-in id; "unverified" for a package id. */
  resolves(id: string): "yes" | "no" | "unverified";
  setting(sourceId: string): SourcePersonaSetting | undefined;
}

/** The persona checks' view of a team dir (its `personas/` and config.json `sourcePersonas`). */
function personaCheckContext(teamDir: string): PersonaCheckContext {
  let settings: Record<string, SourcePersonaSetting> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as unknown;
    if (isObject(raw) && isObject(raw.sourcePersonas)) settings = raw.sourcePersonas as Record<string, SourcePersonaSetting>;
  } catch {
    // No (or an unreadable) config.json: no per-source settings.
  }
  return {
    resolves: (id) => {
      const kind = parsePersonaId(id).kind;
      if (kind === "package") return "unverified";
      if (kind === "builtin") return getBuiltinPersona(id) ? "yes" : "no";
      if (kind === "team") return fs.existsSync(teamDir) && readTeamPersona(teamDir, id) ? "yes" : "no";
      return "no";
    },
    setting: (sourceId) => (isObject(settings[sourceId]) ? settings[sourceId] : undefined),
  };
}

/** The team's raw config.json `packages` (empty when there's no config.json or no team dir). */
function configuredPackages(teamDir: string): unknown[] {
  const file = path.join(teamDir, "config.json");
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new DoctorUsageError(`Cannot parse ${file}: ${(e as Error).message}`);
  }
  const p = isObject(parsed) ? parsed.packages : undefined;
  if (p === undefined || p === null) return [];
  if (!Array.isArray(p)) throw new DoctorUsageError(`config.json "packages" must be an array (it is ${JSON.stringify(p)})`);
  return p;
}

/**
 * The packages to check: every configured one (none named), or the one named
 * — a configured entry by spec or identity, else a spec/path that need not be
 * configured.
 */
function resolveTargets(arg: string | undefined, d: PluginsDoctorDeps): Target[] {
  const raw = configuredPackages(d.teamDir);
  const parsed = parsePackageEntries(raw, d.teamDir);
  const configured: Target[] = parsed.packages.map((p) => ({ raw: p.spec.raw, spec: p.spec, configured: true, config: p.config }));
  if (arg === undefined) {
    return [...configured, ...parsed.rejected.map((r) => ({ raw: r.raw, error: r.error, configured: true }))];
  }
  const normalized = normalizeCliSpec(arg, d.cwd);
  const asSpec = parsePackageEntries([normalized], d.teamDir).packages[0]?.spec;
  const match = configured.find((t) => t.raw === arg || t.spec!.identity === arg || (asSpec && t.spec!.identity === asSpec.identity));
  if (match) return [match];
  if (!asSpec) {
    const err = parsePackageEntries([normalized], d.teamDir).errors[0];
    throw new DoctorUsageError(`${arg} is not a configured package (see \`mpt plugins list\`) and not a valid spec: ${err ?? "unknown"}`);
  }
  return [{ raw: normalized, spec: asSpec, configured: false }];
}

/** `mpt plugins doctor …`. Returns the exit code; throws `DoctorUsageError` for a usage error. */
export async function runPluginsDoctor(args: string[], d: PluginsDoctorDeps): Promise<number> {
  const opts = parseArgs(args);
  const targets = resolveTargets(opts.target, d);
  if (targets.length === 0) {
    if (opts.json) d.log(JSON.stringify({ ok: true, live: false, packages: [], summary: { ok: 0, warn: 0, fail: 0 } } satisfies DoctorReport, null, 2));
    else d.log("No plugin packages configured. Check one with `mpt plugins doctor <path|spec>`.");
    return 0;
  }
  let liveConfig: Record<string, unknown> | undefined;
  if (opts.config !== undefined) {
    if (targets.length !== 1) {
      throw new DoctorUsageError(`--config runs one package live; ${targets.length} are configured — name one\n${USAGE}`);
    }
    const t = targets[0]!;
    if (opts.config === "team") {
      if (!t.configured) throw new DoctorUsageError(`--config team: ${t.raw} is not in ${path.join(d.teamDir, "config.json")} "packages"; pass --config '<json>' instead`);
      liveConfig = t.config ?? {};
    } else {
      liveConfig = opts.config;
    }
  }

  // A plugin's own console output must not corrupt the JSON on stdout.
  const restore = opts.json ? redirectConsoleToStderr() : () => {};
  let report: DoctorReport;
  try {
    for (const t of targets) installIntoScratch(t, d, opts.json);
    report = await checkPlugins(targets, d.teamDir, { liveConfig, source: opts.source, hooks: opts.hooks });
  } finally {
    restore();
    for (const t of targets) if (t.scratchTeamDir) fs.rmSync(t.scratchTeamDir, { recursive: true, force: true });
  }
  if (opts.json) d.log(JSON.stringify(report, null, 2));
  else for (const line of renderReport(report)) d.log(line);
  return report.ok ? 0 : 1;
}

/**
 * An unconfigured npm/git spec that isn't installed in the team: install it
 * into a scratch team dir (the caller removes it) so it can be checked at all.
 * Progress goes to stderr under `--json` (and npm's output is captured), so the
 * report stays the only thing on stdout. A failure is kept for `checkPackage`.
 */
function installIntoScratch(t: Target, d: PluginsDoctorDeps, json: boolean): void {
  const spec = t.spec;
  if (t.configured || !spec || spec.kind === "local" || !d.run) return;
  if (!("error" in resolvePackageDir(spec, d.teamDir))) return;
  const run = d.run;
  t.scratchTeamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugins-doctor-install-"));
  const log = json ? d.error : d.log;
  log(`Installing ${spec.raw} into a scratch cache (${t.scratchTeamDir}; removed afterwards)…`);
  try {
    installPackage(spec, {
      teamDir: t.scratchTeamDir,
      run: json ? (cmd, args, o) => run(cmd, args, { ...o, capture: true }) : run,
      log,
    });
  } catch (e) {
    t.installError = errorMessage(e);
  }
}

interface CheckOptions {
  /** Set = the live check, with this as the source's options. */
  liveConfig?: Record<string, unknown>;
  source?: string;
  hooks: boolean;
}

/** Check every target, then summarize. */
async function checkPlugins(targets: Target[], teamDir: string, opts: CheckOptions): Promise<DoctorReport> {
  // Source ids seen so far, across packages (the daemon's registry is one namespace).
  const seenIds = new Map<string, string>(BUILT_IN_SOURCE_IDS.map((id) => [id, "a built-in source"]));
  // Personas resolve against the real team (not a scratch install's cache).
  const personas = personaCheckContext(teamDir);
  const packages: DoctorPackageReport[] = [];
  const scratch = opts.liveConfig ? fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugins-doctor-")) : undefined;
  try {
    for (const t of targets) packages.push(await checkPackage(t, t.scratchTeamDir ?? teamDir, seenIds, personas, opts, scratch));
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const p of packages) {
    for (const c of [...p.checks, ...p.sources.flatMap((s) => s.checks)]) summary[c.status]++;
  }
  return { ok: summary.fail === 0, live: opts.liveConfig !== undefined, packages, summary };
}

/** The install check (and, live, the run) of one package. */
async function checkPackage(
  t: Target, teamDir: string, seenIds: Map<string, string>, personas: PersonaCheckContext, opts: CheckOptions, scratch?: string,
): Promise<DoctorPackageReport> {
  const report: DoctorPackageReport = { spec: t.raw, configured: t.configured, checks: [], sources: [] };
  const check = (status: DoctorStatus, message: string, hint?: string) => report.checks.push({ status, message, ...(hint ? { hint } : {}) });
  if (!t.spec) {
    check("fail", t.error ?? "invalid package entry", "fix the entry in config.json \"packages\"");
    return report;
  }
  const spec = t.spec;
  Object.assign(report, { kind: spec.kind, identity: spec.identity });
  check("ok", `spec parses (${spec.kind}; identity ${spec.identity})`);

  if (t.installError !== undefined) {
    check("fail", `install into a scratch cache failed: ${t.installError}`, "see GUIDE.md \"Distributing a plugin\"");
    return report;
  }
  if (t.scratchTeamDir) check("ok", "installed into a scratch cache (not configured; removed after the checks)");
  const resolved = resolvePackageDir(spec, teamDir);
  if ("error" in resolved) {
    check("fail", resolved.error, spec.kind === "local" ? "check the path" : `mpt plugins add ${spec.raw}`);
    return report;
  }
  const dir = resolved.dir;
  report.dir = dir;
  check("ok", `${spec.kind === "local" ? "path exists" : "installed"}: ${dir}`);

  const manifest = readPluginManifest(dir);
  if ("error" in manifest) {
    check("fail", manifest.error, "add \"mpt\": { \"sources\": [\"./dist/index.js\"] } to package.json");
    return report;
  }
  check(manifest.sources.length ? "ok" : "warn", `package.json "mpt" manifest: ${manifest.sources.length} source entr${manifest.sources.length === 1 ? "y" : "ies"}${manifest.sources.length ? ` (${manifest.sources.join(", ")})` : ""}`);

  for (const entry of manifest.sources) {
    report.sources.push(await checkEntry(dir, entry, seenIds, personas, opts, spec.raw, scratch));
  }
  if (opts.liveConfig && opts.source !== undefined && !report.sources.some((s) => s.id === opts.source)) {
    check("fail", `--source ${opts.source}: no source with that id in this package (found: ${report.sources.map((s) => s.id ?? "?").join(", ") || "none"})`);
  }
  return report;
}

/** One source entry: import it through the real loader path, check its export, and (live) run it. */
async function checkEntry(
  dir: string, entry: string, seenIds: Map<string, string>, personas: PersonaCheckContext, opts: CheckOptions, spec: string, scratch?: string,
): Promise<DoctorSourceReport> {
  const report: DoctorSourceReport = { entry, checks: [] };
  const check = (status: DoctorStatus, message: string, hint?: string) => report.checks.push({ status, message, ...(hint ? { hint } : {}) });

  let exported: unknown;
  try {
    const file = resolveSourceEntry(dir, entry);
    exported = await importSourceEntry(file);
  } catch (e) {
    const { message, hint } = describeImportError(e, dir);
    check("fail", `import failed: ${message}`, hint);
    return report;
  }
  check("ok", `imports (with ${HOST_PLUGIN_SPECIFIER} resolved to this host)`);

  let source: WorkSource;
  if (isPluginFactory(exported)) {
    report.export = "factory";
    if (!opts.liveConfig) {
      check("ok", "default export is a factory (not called without --config; its source is checked live)");
      return report;
    }
    try {
      source = await instantiateSource(exported, opts.liveConfig, { teamDir: scratch! });
    } catch (e) {
      check("fail", `factory failed: ${errorMessage(e)}`);
      return report;
    }
    check("ok", `factory returned source "${source.id}"`);
  } else {
    report.export = "object";
    try {
      source = await instantiateSource(exported, {}, { teamDir: scratch ?? dir });
    } catch (e) {
      check("fail", errorMessage(e));
      return report;
    }
    check("ok", `default export is a WorkSource object: "${source.id}"`);
  }
  report.id = source.id;
  for (const c of sourceChecks(source, seenIds, spec)) report.checks.push(c);
  for (const c of personaChecks(source, personas)) report.checks.push(c);

  if (opts.liveConfig && !report.checks.some((c) => c.status === "fail")) {
    if (opts.source === undefined || opts.source === source.id) await liveCheck(source, opts, report, scratch!);
  }
  return report;
}

/** What the registry checks at registration (daemon/sources/registry.ts), as doctor lines. */
function sourceChecks(source: WorkSource, seenIds: Map<string, string>, spec: string): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  if (source.apiVersion === WORK_SOURCE_API_VERSION) out.push({ status: "ok", message: `apiVersion ${WORK_SOURCE_API_VERSION}` });
  else out.push({ status: "fail", message: `apiVersion ${String(source.apiVersion)}; this host supports ${WORK_SOURCE_API_VERSION}`, hint: "set apiVersion: WORK_SOURCE_API_VERSION (from my-pizza-team/plugin)" });
  if (typeof source.sync === "function") {
    if (SOURCE_ID_PATTERN.test(source.id)) out.push({ status: "ok", message: `id "${source.id}" matches ${SOURCE_ID_PATTERN} (an external source)` });
    else out.push({ status: "fail", message: `id "${source.id}" doesn't match ${SOURCE_ID_PATTERN}, required of an external source (one with sync)`, hint: "use lowercase letters, digits, and dashes, starting with a letter" });
  }
  const other = seenIds.get(source.id);
  if (other) out.push({ status: "fail", message: `id "${source.id}" is already taken by ${other}`, hint: "give the source a unique id" });
  else seenIds.set(source.id, spec);
  return out;
}

/**
 * A source's personas (docs/DESIGN.md "Work Source personas"): each declared
 * id that doesn't resolve is a warning (work items fall back to
 * `builtin:worker`); a triage-mode source whose triage persona — the team's
 * per-source setting, else declared — is missing or doesn't resolve fails,
 * since the daemon won't sync it.
 */
function personaChecks(source: WorkSource, personas: PersonaCheckContext): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  for (const field of ["defaultPersona", "triagePersona"] as const) {
    const ref = source[field];
    if (ref === undefined) continue;
    if (typeof ref !== "string" || !ref.trim()) {
      out.push({ status: "warn", message: `${field} is not a persona id (${JSON.stringify(ref)})`, hint: "a team id, builtin:<name>, or <package>/<id>" });
      continue;
    }
    const r = personas.resolves(ref);
    if (r === "yes") out.push({ status: "ok", message: `${field} "${ref}" exists` });
    else if (r === "unverified") out.push({ status: "ok", message: `${field} "${ref}" (a package persona; the daemon resolves it at startup)` });
    else out.push({ status: "warn", message: `${field} "${ref}" doesn't exist in this team (no such team or built-in persona)`, hint: "create it under Config → Personas, or fix the id" });
  }
  if (source.mode === "triage") {
    const pick = sourcePersonaPick("triage", personas.setting(source.id), source);
    const hint = `set its triage persona on Config → Sources (sourcePersonas.${source.id}.triagePersona), or declare triagePersona`;
    if (!pick) out.push({ status: "fail", message: "triage-mode source has no triage persona: the daemon won't sync it", hint });
    else if (personas.resolves(pick.ref) === "no") out.push({ status: "fail", message: `triage persona "${pick.ref}" doesn't exist: the daemon won't sync it`, hint });
    else out.push({ status: "ok", message: `triage persona: ${pick.ref} (${pick.via === "source-setting" ? "the team's setting" : "declared"})` });
  }
  return out;
}

/** The live part: init, sync twice (stability), optionally the write-back hooks — all on a throwaway context. */
async function liveCheck(source: WorkSource, opts: CheckOptions, report: DoctorSourceReport, scratch: string): Promise<void> {
  const check = (status: DoctorStatus, message: string, hint?: string) => report.checks.push({ status, message, ...(hint ? { hint } : {}) });
  const logs: string[] = [];
  const calls: DoctorCalls = { enqueue: [], enqueueRevision: [], upsertDef: [] };
  report.logs = logs;
  report.calls = calls;
  const teamDir = path.join(scratch, source.id.replace(/[^A-Za-z0-9-]/g, "_"));
  fs.mkdirSync(teamDir, { recursive: true });
  const ctx = throwawayContext(source.id, teamDir, opts.liveConfig!, logs, calls);

  if (source.init) {
    try {
      await withTimeout(Promise.resolve(source.init(ctx)), DEFAULT_PLUGIN_LOAD_TIMEOUT_MS, "init");
      check("ok", "init");
    } catch (e) {
      check("fail", `init failed: ${errorMessage(e)}`);
      return;
    }
  }
  if (typeof source.sync !== "function") {
    check("ok", "no sync (not an external source): nothing to sync");
    return;
  }

  const timeoutMs = source.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const first = await runSync(source, ctx, timeoutMs);
  if ("error" in first) {
    check("fail", `sync failed: ${first.error}`);
    return;
  }
  check("ok", `sync returned ${first.defs.length} item(s) in ${first.ms}ms (timeout ${timeoutMs}ms)`);
  report.items = first.defs.map((def) => itemSummary(source.id, def));
  for (const c of itemChecks(source.id, first.defs)) report.checks.push(c);

  const second = await runSync(source, ctx, timeoutMs);
  if ("error" in second) check("warn", `a second sync failed: ${second.error}`);
  else for (const c of stabilityChecks(first.defs, second.defs)) report.checks.push(c);

  if (opts.hooks) await hookChecks(source, ctx, first.defs, report);
}

/** One bounded sync, its result checked to be an array. */
async function runSync(source: WorkSource, ctx: SourceContext, timeoutMs: number): Promise<{ defs: unknown[]; ms: number } | { error: string }> {
  const start = performance.now();
  try {
    const result: unknown = await withTimeout(Promise.resolve(source.sync!(ctx)), timeoutMs, "sync");
    if (!Array.isArray(result)) return { error: `returned ${result === null ? "null" : typeof result}, not an array of ExternalDefs` };
    return { defs: result, ms: Math.round(performance.now() - start) };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

/** The fields printed for an item (whatever it has, even an invalid one). */
function itemSummary(sourceId: string, def: unknown): DoctorItem {
  const d = isObject(def) ? def : {};
  const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? undefined : JSON.stringify(v));
  const externalId = str(d.externalId) ?? "";
  return {
    externalId,
    revision: str(d.revision) ?? "",
    ...(d.mode !== undefined ? { mode: str(d.mode) } : {}),
    title: str(d.title) ?? "",
    ...(d.url !== undefined ? { url: str(d.url) } : {}),
    ...(d.directory !== undefined ? { directory: str(d.directory) } : {}),
    ...(externalId ? { mirrorId: mirroredWorkDefId(sourceId, externalId) } : {}),
    ...(Array.isArray(d.comments) ? { comments: d.comments.length } : {}),
  };
}

/**
 * Each item's validity (what the daemon would refuse to mirror), duplicate
 * externalIds, and a mirror id that can't name a directory.
 */
function itemChecks(sourceId: string, defs: unknown[]): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const seen = new Set<string>();
  const dupes = new Set<string>();
  let invalid = 0;
  for (const [i, def] of defs.entries()) {
    const why = invalidExternalDef(def);
    if (why) {
      invalid++;
      out.push({ status: "fail", message: `item #${i + 1}: ${why} (the daemon skips it)`, hint: "every item needs a non-empty externalId, revision, and title" });
      continue;
    }
    const ext = def as ExternalDef;
    // Comments: each is checked when merged; a bad one is skipped, not the item.
    const commentIds = new Set<string>();
    for (const [j, c] of (ext.comments ?? []).entries()) {
      const bad = invalidExternalComment(c);
      if (bad) out.push({ status: "warn", message: `item ${ext.externalId}, comment #${j + 1}: ${bad} (the daemon skips it)`, hint: "every comment needs a non-empty externalId, author, createdAt (a date), and body" });
      else if (commentIds.has(c.externalId)) out.push({ status: "warn", message: `item ${ext.externalId}: comment id ${c.externalId} repeated (only the first is kept)` });
      else commentIds.add(c.externalId);
    }
    if (seen.has(ext.externalId)) dupes.add(ext.externalId);
    seen.add(ext.externalId);
    const unsafe = unsafeDirName(mirroredWorkDefId(sourceId, ext.externalId));
    if (unsafe) out.push({ status: "fail", message: `item ${ext.externalId}: its mirror id ${unsafe}`, hint: "use shorter externalIds" });
  }
  if (dupes.size) out.push({ status: "fail", message: `duplicate externalIds: ${[...dupes].join(", ")}`, hint: "each item's externalId must be unique within the source" });
  if (invalid === 0 && dupes.size === 0 && defs.length > 0) out.push({ status: "ok", message: `${defs.length} item(s) valid (required fields, unique externalIds, file-system-safe mirror ids)` });
  if (defs.length === 0) out.push({ status: "warn", message: "sync returned no items (is the config pointing at anything?)" });
  return out;
}

/** Why a mirror id can't be a directory name, or null. (`mirroredWorkDefId` already escapes separators.) */
function unsafeDirName(id: string): string | null {
  if (id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) return `"${id}" is not a safe directory name`;
  const bytes = Buffer.byteLength(id, "utf8");
  if (bytes > MAX_DIR_NAME_BYTES) return `is ${bytes} bytes, over the ${MAX_DIR_NAME_BYTES}-byte directory-name limit`;
  return null;
}

/** The parts of an item the revision should cover (what its mirror holds). */
function contentKey(d: ExternalDef): string {
  return JSON.stringify([d.title, d.goal, d.acceptanceCriteria, d.additionalContext, d.directory, d.url, d.mode]);
}

/**
 * Two back-to-back syncs: a revision that moves with no content change re-runs
 * work for nothing (a timestamp of "now", a random etag); content that changes
 * under the same revision is never re-mirrored.
 */
function stabilityChecks(first: unknown[], second: unknown[]): DoctorCheck[] {
  const before = new Map<string, ExternalDef>();
  for (const d of first) if (!invalidExternalDef(d)) before.set((d as ExternalDef).externalId, d as ExternalDef);
  const moved: string[] = [];
  const stale: string[] = [];
  for (const d of second) {
    if (invalidExternalDef(d)) continue;
    const now = d as ExternalDef;
    const was = before.get(now.externalId);
    if (!was) continue;
    const same = contentKey(was) === contentKey(now);
    if (was.revision !== now.revision && same) moved.push(now.externalId);
    if (was.revision === now.revision && !same) stale.push(now.externalId);
  }
  const out: DoctorCheck[] = [];
  if (moved.length) out.push({ status: "warn", message: `revision changed between two syncs with no content change: ${moved.join(", ")}`, hint: "derive the revision from the item (an updated-at, a content hash), or every sync re-runs it" });
  if (stale.length) out.push({ status: "warn", message: `content changed between two syncs under the same revision: ${stale.join(", ")}`, hint: "the revision must move when the content does, or the change is never mirrored" });
  if (!moved.length && !stale.length) out.push({ status: "ok", message: "revisions stable across two syncs" });
  return out;
}

/** `--hooks`: call `onComment` and `onItemTerminal` (a fake COMPLETE item) on the first valid item. */
async function hookChecks(source: WorkSource, ctx: SourceContext, defs: unknown[], report: DoctorSourceReport): Promise<void> {
  const check = (status: DoctorStatus, message: string) => report.checks.push({ status, message });
  if (!source.onComment && !source.onItemTerminal) {
    check("ok", "--hooks: the source has no onComment / onItemTerminal");
    return;
  }
  const ext = defs.find((d) => !invalidExternalDef(d)) as ExternalDef | undefined;
  if (!ext) {
    check("warn", "--hooks: no valid item to call the hooks on");
    return;
  }
  const def = stubWorkDef(source.id, ext);
  const now = new Date().toISOString();
  const hooks: Array<[string, (() => unknown) | undefined]> = [
    ["onComment", source.onComment && (() => {
      const comment: Comment = { from: "mpt-plugins-doctor", body: "A test comment from `mpt plugins doctor --hooks`.", at: now };
      return source.onComment!(def, comment, ctx);
    })],
    ["onItemTerminal", source.onItemTerminal && (() => {
      const item: WorkItem = {
        id: "mpt-plugins-doctor-item", title: def.title, ref: { workDefId: def.id }, state: "COMPLETE",
        read: true, enqueuedAt: now, lastStateChangeAt: now, attempt: 1,
        ...(def.directory ? { directory: def.directory } : {}),
      };
      return source.onItemTerminal!(def, item, ctx);
    })],
  ];
  for (const [name, call] of hooks) {
    if (!call) continue;
    const logsBefore = report.logs!.length;
    try {
      const result = await withTimeout(Promise.resolve(call()), DEFAULT_PLUGIN_LOAD_TIMEOUT_MS, name);
      const logged = report.logs!.length - logsBefore;
      check("ok", `${name} on ${ext.externalId}: ok${result !== undefined ? ` (returned ${JSON.stringify(result)})` : ""}${logged ? `, ${logged} log line(s)` : ""}`);
    } catch (e) {
      check("fail", `${name} on ${ext.externalId} failed: ${errorMessage(e)}`);
    }
  }
}

/** The mirrored WorkDef the daemon would hold for an item (never written). */
function stubWorkDef(sourceId: string, ext: ExternalDef): WorkDef {
  return {
    id: mirroredWorkDefId(sourceId, ext.externalId),
    title: ext.title.trim(),
    parent: { kind: "external", id: ext.externalId, source: sourceId },
    goal: (ext.goal ?? "").trim(),
    acceptanceCriteria: (ext.acceptanceCriteria ?? "").trim(),
    status: "active",
    ...(ext.additionalContext?.trim() ? { additionalContext: ext.additionalContext.trim() } : {}),
    ...(ext.directory?.trim() ? { directory: ext.directory.trim() } : {}),
    ...(ext.url?.trim() ? { url: ext.url.trim() } : {}),
  };
}

/**
 * A `SourceContext` that touches nothing real: `teamDir` is a temp dir, the kv
 * is in memory, there are no WorkDefs, and the queue capabilities only record
 * what they were asked (`upsertDef` returns the stub mirror, never writes it).
 */
function throwawayContext(sourceId: string, teamDir: string, options: Record<string, unknown>, logs: string[], calls: DoctorCalls): SourceContext {
  const kv = new Map<string, string>();
  const frozen = Object.freeze({ ...options });
  return {
    sourceId,
    teamDir,
    config: () => structuredClone(DEFAULT_CONFIG),
    options: () => frozen,
    log: (message) => logs.push(`[${sourceId}] ${message}`),
    listWorkDefs: () => [],
    hasActiveItem: () => false,
    enqueue: (defId) => {
      calls.enqueue.push(defId);
      return null;
    },
    enqueueRevision: (defId, revision) => {
      calls.enqueueRevision.push({ defId, revision });
      return null;
    },
    upsertDef: (def) => {
      calls.upsertDef.push(isObject(def) && typeof def.externalId === "string" ? def.externalId : "?");
      return invalidExternalDef(def) ? null : stubWorkDef(sourceId, def);
    },
    kv: {
      get: (k) => kv.get(k),
      set: (k, v) => void kv.set(k, String(v)),
      delete: (k) => void kv.delete(k),
    },
    readiness: { canEnqueueNow: () => true },
  };
}

/**
 * An import failure, readable: the message, plus a hint for the usual causes
 * — a native module built for another Node (its NODE_MODULE_VERSION against
 * this one's), a missing dependency, TypeScript shipped in node_modules.
 */
export function describeImportError(e: unknown, dir: string): { message: string; hint?: string } {
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err as NodeJS.ErrnoException).code;
  const message = err.message.split("\n").filter(Boolean).slice(0, 3).join(" ");
  if (code === "ERR_DLOPEN_FAILED" || /NODE_MODULE_VERSION/.test(err.message)) {
    return {
      message,
      hint: `a native module was built for a different Node: this is Node ${process.versions.node} (NODE_MODULE_VERSION ${process.versions.modules}). `
        + `Rebuild the package with this Node: (cd ${dir} && npm rebuild), or reinstall it (mpt plugins update)`,
    };
  }
  if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find (package|module)/.test(err.message)) {
    return { message, hint: `a file or dependency is missing: build the package and install its dependencies (cd ${dir} && npm install && npm run build)` };
  }
  if (code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING") {
    return { message, hint: "Node won't run TypeScript from node_modules: build to JavaScript and point \"mpt.sources\" at it" };
  }
  const at = err.stack?.split("\n").find((l) => l.trim().startsWith("at ") && !l.includes("node:internal"));
  return { message, ...(at ? { hint: `thrown ${at.trim()}` } : {}) };
}

/** Render the report: a line per check, grouped by package then source, then the summary. */
export function renderReport(r: DoctorReport): string[] {
  const glyph: Record<DoctorStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };
  const lines: string[] = [];
  lines.push(r.live
    ? "mpt plugins doctor — install check + live run (init, sync ×2) on a throwaway context"
    : "mpt plugins doctor — install check only (add --config '<json>' or --config team to run init + sync)");
  const push = (indent: string, c: DoctorCheck) => {
    lines.push(`${indent}${glyph[c.status]} ${c.message}`);
    if (c.hint && c.status !== "ok") lines.push(`${indent}  → ${c.hint}`);
  };
  for (const p of r.packages) {
    lines.push("");
    lines.push(`📦 ${p.spec}${p.configured ? "" : " (not configured)"}`);
    for (const c of p.checks) push("  ", c);
    for (const s of p.sources) {
      lines.push(`  ▸ ${s.entry}${s.id ? ` → source "${s.id}"` : ""}${s.export ? ` (${s.export})` : ""}`);
      for (const c of s.checks) push("    ", c);
      for (const item of s.items ?? []) {
        const extra = [item.mode ? `mode ${item.mode}` : "", item.comments !== undefined ? `${item.comments} comment(s)` : "", item.url ?? "", item.directory ? `dir ${item.directory}` : ""].filter(Boolean).join("  ");
        lines.push(`      • ${item.externalId || "(no externalId)"} @ ${item.revision || "(no revision)"}  "${item.title}"${extra ? `  ${extra}` : ""}`);
      }
      for (const l of s.logs ?? []) lines.push(`      log ${l}`);
      const c = s.calls;
      if (c && (c.enqueue.length || c.enqueueRevision.length || c.upsertDef.length)) {
        lines.push(`      (recorded, not applied: enqueue ×${c.enqueue.length}, enqueueRevision ×${c.enqueueRevision.length}, upsertDef ×${c.upsertDef.length})`);
      }
    }
  }
  lines.push("");
  const n = r.packages.length;
  lines.push(`${r.ok ? "✓" : "✗"} ${n} package${n === 1 ? "" : "s"}: ${r.summary.ok} ok, ${r.summary.warn} warning(s), ${r.summary.fail} failed`);
  return lines;
}

/** Send console.log/info/debug to stderr until the returned function is called (for `--json`). */
function redirectConsoleToStderr(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  return () => Object.assign(console, saved);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
