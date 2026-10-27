/**
 * cli/doctor.ts — `mpt doctor`: check the prerequisites and print one fix per problem.
 *
 * The problem this exists for (docs/DESIGN.md "Setup Is One Command"): setup is a
 * scavenger hunt where no step checks the others, so a missing piece shows up later
 * as a *symptom* — a teammate stuck on a prompt, a chat nobody answers — rather than
 * an error. Every check here therefore carries the command or action that fixes it.
 *
 * Read-only by construction. `mpt setup` performs the fixes; doctor only reports,
 * which also makes it the honest dry-run for setup.
 *
 * Two deliberate calibrations:
 *
 *   - The Pi version is a **warning, not a gate**. There is no extension-API version
 *     to negotiate, and the extension's surface is seven long-stable methods, all
 *     imported as types. Blocking on an untested Pi would be a guess dressed up as
 *     a requirement (DESIGN.md "One Protocol, One Version").
 *   - Build-version skew between daemon and extension is reported, never enforced.
 *     The protocol handshake already refuses what it cannot serve (P1b-3); gating on
 *     build version would nag on every patch release until people ignored it.
 */

import { ACP_HARNESSES } from "../agent/harnesses.ts";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import {
  findExtensionRegistrations,
  hasPackage,
  isProjectTrusted,
  piAgentDir,
  piSettingsPath,
  readPiSettings,
  type ExtensionRegistration,
} from "./pi-config.ts";
import { managedExtensionDir, readExtensionVersion, resolveExtensionSourceDir } from "./extension.ts";
import { tmuxAvailable } from "../daemon/tmux.ts";
import {
  checkNode,
  configuredNode,
  describeNodeSource,
  pinnedNodeWarning,
  requiredNodeVersionString,
  sameFile,
  stableNodeAlternative,
} from "../shared/runtime-config.ts";
import { cliEntryScript } from "../shared/paths.ts";
import type { ServiceProgram } from "./service.ts";
import type { PluginLoadStatus, WorkSourcesResponse } from "../shared/protocol.ts";

/** The Pi release this build was tested against. See DESIGN.md "One Protocol, One Version" — advisory, not a gate. */
export const TESTED_PI_VERSION = "0.87.1";

/** The npm package that makes autonomous teammates possible. */
export const PERMISSION_SYSTEM_PACKAGE = "npm:@gotgenes/pi-permission-system";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  /** What was found. One line. */
  detail: string;
  /** What to do about it — a command where possible. Omitted when status is ok. */
  fix?: string;
}

/** Everything doctor needs to know, gathered so the check logic stays testable. */
export interface DoctorFacts {
  piVersion: string | null;
  tmuxPresent: boolean;
  daemonVersion: string;
  /** The bundled extension's version, or null when it can't be located. */
  bundledExtensionVersion: string | null;
  /** The team directory exists at all (it may still be unconfigured). */
  teamDirPresent: boolean;
  registrations: ExtensionRegistration[];
  managedDir: string;
  managedDirVersion: string | null;
  permissionSystemInstalled: boolean;
  settingsPath: string;
  settingsReadable: boolean;
  teamDir: string;
  teamDirExists: boolean;
  projectTrusted: boolean;
  daemonRunning: boolean;
  leaderConnected: boolean | null;
  /** Which path realizes spawns, as reported by the running daemon. */
  spawning: { canSpawn: boolean; reason?: string; fix?: string } | null;
  serviceInstalled: boolean;
  /** Which Node runs mpt, and how that compares to the service and this process. Absent = not checked. */
  node?: NodeFacts;
  /**
   * The experimental ACP harnesses, when the team has `experimental.harnesses` on
   * (absent otherwise): whether each could start on this machine.
   */
  experimentalHarnesses?: Record<string, { ready: boolean; missing?: string; fix?: string }>;
  /**
   * How the team's plugin packages loaded, as reported by the running daemon
   * (`GET /api/work-sources` `plugins`; daemon/plugins/loader.ts). Absent/null =
   * not known (daemon down, or an older daemon).
   */
  plugins?: PluginLoadStatus[] | null;
}

/** The Node facts (shared/runtime-config.ts), gathered so the checks stay pure. */
export interface NodeFacts {
  /** The configured Node, or null when nothing is saved or overridden. */
  configured: {
    path: string;
    /** Where the setting came from: "--node", "MPT_NODE", or the settings file's path. */
    source: string;
    /** Its version when it ran, else null. */
    version: string | null;
    /** Why it can't run mpt (missing, not executable, too old), or null when fine. */
    problem: string | null;
    /** The version-pinned-path warning (shared/runtime-config.ts pinnedNodeWarning), or null. */
    pinnedWarning: string | null;
  } | null;
  /** The minimum Node version (package.json engines). */
  required: string;
  /** The Node running this process (`process.execPath`). */
  runningNode: string;
  /** Does the running Node name the same binary as the configured one (following symlinks)? */
  runningMatchesConfigured: boolean;
  /** What the installed service launches, or null (no service, or unreadable). */
  service: ServiceProgram | null;
  /** The entry script this copy of mpt would install (shared/paths.ts cliEntryScript). */
  expectedEntry: string;
  /** Does the service's entry name the same file as `expectedEntry`? */
  serviceEntryMatches: boolean;
  /**
   * `mpt` executables on PATH that are native binaries — leftovers of the old
   * single-binary (compiled) builds, which shadow or confuse the npm install.
   */
  legacyBinaries: string[];
  /**
   * `mpt` files on PATH that are scripts/legacy-bridge.sh — what the old binary's
   * `mpt upgrade` put in its place. They work (they hand off to the npm package).
   */
  legacyBridges: string[];
  /** Does the service launch the bridge (an old service the bridge couldn't re-point)? */
  serviceIsBridge: boolean;
}

/** Compare dotted versions numerically. Null when either is unparseable. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const parts = v.trim().replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10));
    return parts.some(Number.isNaN) ? null : parts;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Turn gathered facts into a checklist. Pure, so every branch is testable without
 * a Pi install, a daemon, or a real home directory.
 */
export function evaluate(f: DoctorFacts): Check[] {
  const checks: Check[] = [];

  // ── Prerequisites ────────────────────────────────────────────────
  if (!f.piVersion) {
    checks.push({
      name: "Pi",
      status: "fail",
      detail: "not found on PATH",
      fix: "npm install -g @earendil-works/pi-coding-agent",
    });
  } else {
    const cmp = compareVersions(f.piVersion, TESTED_PI_VERSION);
    checks.push(
      cmp !== null && cmp < 0
        ? {
          name: "Pi",
          status: "warn",
          detail: `${f.piVersion} — older than the ${TESTED_PI_VERSION} this build was tested against`,
          fix: "npm install -g @earendil-works/pi-coding-agent@latest (only if something misbehaves)",
        }
        : { name: "Pi", status: "ok", detail: f.piVersion },
    );
  }

  checks.push(
    f.tmuxPresent
      ? { name: "tmux", status: "ok", detail: "found" }
      : {
        name: "tmux",
        status: "fail",
        detail: "not found on PATH — teammates run in tmux windows",
        fix: "brew install tmux (or your platform's package manager)",
      },
  );

  // ── Pi settings ──────────────────────────────────────────────────
  if (!f.settingsReadable) {
    checks.push({
      name: "Pi settings",
      status: "fail",
      detail: `${f.settingsPath} exists but could not be parsed`,
      fix: "fix or remove that file — mpt will not overwrite configuration it cannot read",
    });
  }

  // ── Extension registration ───────────────────────────────────────
  checks.push(extensionCheck(f));

  // ── Version skew ─────────────────────────────────────────────────
  const installed = f.managedDirVersion;
  if (installed && compareVersions(installed, f.daemonVersion) !== 0) {
    checks.push({
      name: "Extension version",
      status: "warn",
      detail: `installed ${installed}; the daemon is ${f.daemonVersion}`,
      fix: "mpt setup (rewrites the managed extension), then restart running agents",
    });
  } else if (installed) {
    checks.push({ name: "Extension version", status: "ok", detail: `${installed} (matches the daemon)` });
  }

  // ── Permission system ────────────────────────────────────────────
  checks.push(
    f.permissionSystemInstalled
      ? { name: "Permission system", status: "ok", detail: "installed" }
      : {
        name: "Permission system",
        status: "warn",
        detail: "not installed — autonomous teammates will stop on permission prompts",
        fix: `pi install ${PERMISSION_SYSTEM_PACKAGE}`,
      },
  );

  // ── Team directory and trust ─────────────────────────────────────
  // "Configured" means config.json is present. A directory holding only a database
  // is a half-initialised team, which is worth saying precisely rather than calling
  // it absent.
  if (f.teamDirExists) {
    checks.push({ name: "Team directory", status: "ok", detail: f.teamDir });
  } else if (f.teamDirPresent) {
    checks.push({
      name: "Team directory",
      status: "warn",
      detail: `${f.teamDir} exists but has no config.json`,
      fix: "mpt setup (writes the default config without touching existing data)",
    });
  } else {
    checks.push({ name: "Team directory", status: "warn", detail: `${f.teamDir} does not exist yet`, fix: "mpt setup" });
  }

  checks.push(
    f.projectTrusted
      ? { name: "Project trust", status: "ok", detail: "this folder is trusted by Pi" }
      : {
        name: "Project trust",
        status: "fail",
        detail: "this folder is not trusted by Pi — agents will block on the trust prompt",
        fix: "mpt setup, or run `pi` here once and accept the prompt",
      },
  );

  // ── Runtime ──────────────────────────────────────────────────────
  if (!f.daemonRunning) {
    checks.push({ name: "Daemon", status: "warn", detail: "not running", fix: "mpt start" });
  } else {
    checks.push({ name: "Daemon", status: "ok", detail: `running (v${f.daemonVersion})` });
    // What a missing leader costs depends on who spawns. With daemon-driven spawning
    // (P3-1) teammates still start without one; only the chat is unanswered. Saying
    // "nothing will spawn" next to "spawning: daemon-driven" would be self-contradicting.
    const daemonSpawns = f.spawning?.canSpawn === true;
    checks.push(
      f.leaderConnected
        ? { name: "Leader", status: "ok", detail: "connected" }
        : {
          name: "Leader",
          status: "warn",
          detail: daemonSpawns
            ? "no leader connected — the chat is unanswered (teammates still spawn, daemon-driven)"
            : "no leader connected — nothing will spawn teammates or answer the chat",
          fix: "mpt lead (the leader is the agent you chat with)",
        },
    );
  }

  // Which path spawns teammates. Both work; knowing which is live turns "nothing
  // spawned" from a mystery into a fact.
  if (f.daemonRunning && f.spawning) {
    checks.push(
      f.spawning.canSpawn
        ? { name: "Spawning", status: "ok", detail: "daemon-driven (it can reach tmux)" }
        : {
          name: "Spawning",
          status: "warn",
          detail: `leader-driven — the daemon can't reach tmux: ${f.spawning.reason ?? "unknown"}`,
          fix: f.spawning.fix ?? "start the daemon from a shell that has tmux",
        },
    );
  }

  checks.push(
    f.serviceInstalled
      ? { name: "Service", status: "ok", detail: "installed (starts on login)" }
      : { name: "Service", status: "ok", detail: "not installed (optional)", fix: "mpt install" },
  );

  // Experimental harnesses: reported only where the team has opted in, and never a
  // failure — a Pi team works regardless.
  for (const [name, h] of Object.entries(f.experimentalHarnesses ?? {})) {
    checks.push(h.ready
      ? { name: `${name} (experimental)`, status: "ok", detail: "ready to spawn" }
      : { name: `${name} (experimental)`, status: "warn", detail: h.missing ?? "not ready", fix: h.fix ?? `mpt setup --harness ${name}` });
  }

  if (f.daemonRunning && f.plugins) checks.push(...pluginChecks(f.plugins));

  if (f.node) checks.push(...nodeChecks(f.node));

  return checks;
}

/**
 * The plugin checks: one line when every package loaded, else a warning per
 * failed package (the daemon runs without it — a failing plugin is skipped,
 * never fatal). Nothing when the team declares no `packages`.
 */
export function pluginChecks(plugins: PluginLoadStatus[]): Check[] {
  if (plugins.length === 0) return [];
  const failed = plugins.filter((p) => p.state === "error");
  if (failed.length === 0) {
    const sources = plugins.flatMap((p) => p.sources);
    return [{ name: "Plugins", status: "ok", detail: `${plugins.length} loaded${sources.length ? ` (sources: ${sources.join(", ")})` : ""}` }];
  }
  return failed.map((p) => ({
    name: `Plugin ${p.spec}`,
    status: "warn" as const,
    detail: `failed to load: ${p.error ?? "unknown error"}`,
    fix: p.error?.includes("not installed")
      ? `mpt plugins add ${p.spec} (or mpt plugins update), then restart the daemon`
      : "fix the package or its entry in config.json packages, then restart the daemon (details: [plugins] in the daemon log)",
  }));
}

/**
 * The Node checks: the configured Node itself, then whether the service and this
 * process agree with it. All warnings — a mismatch works today and breaks later.
 */
export function nodeChecks(n: NodeFacts): Check[] {
  const checks: Check[] = [];
  const c = n.configured;
  if (!c) {
    checks.push({
      name: "Node",
      status: "warn",
      detail: `no Node saved for mpt (this process runs ${n.runningNode})`,
      fix: "mpt setup (asks which Node runs mpt and saves it)",
    });
  } else if (c.problem) {
    checks.push({
      name: "Node",
      status: "warn",
      detail: `${c.problem} (from ${c.source})`,
      fix: `mpt setup --node <path to Node >=${n.required}>`,
    });
  } else {
    checks.push({ name: "Node", status: "ok", detail: `${c.path} (v${c.version}, from ${c.source})` });
  }
  if (c?.pinnedWarning) {
    checks.push({ name: "Node path", status: "warn", detail: c.pinnedWarning, fix: "mpt setup --node <stable path>, then mpt install" });
  }

  if (n.service && !n.service.entry && n.serviceIsBridge) {
    checks.push({
      name: "Service entry",
      status: "warn",
      detail: `the service launches ${n.service.node}, the bridge left by the old binary's upgrade (it works, via Node)`,
      fix: "mpt install (rewrites the service to run Node directly)",
    });
  } else if (n.service && !n.service.entry) {
    // The service launches a program with no entry script: the old compiled binary.
    // Its "Node" is that binary, so a Node mismatch would only repeat this.
    checks.push({
      name: "Service entry",
      status: "warn",
      detail: `the service launches ${n.service.node} directly (an old compiled-binary install)`,
      fix: "mpt install (rewrites the service to run the npm package)",
    });
  } else if (c && n.service) {
    if (n.service.node !== c.path) {
      checks.push({
        name: "Service Node",
        status: "warn",
        detail: `the service runs ${n.service.node}, not the configured ${c.path}`,
        fix: "mpt install (rewrites the service with the configured Node)",
      });
    }
    if (n.service.entry && !n.serviceEntryMatches) {
      checks.push({
        name: "Service entry",
        status: "warn",
        detail: `the service runs ${n.service.entry}, not this copy (${n.expectedEntry})`,
        fix: "mpt install from the copy you want the service to run",
      });
    }
  }

  for (const binary of n.legacyBinaries) {
    checks.push({
      name: "Old mpt binary",
      status: "warn",
      detail: `${binary} is a leftover compiled mpt binary; mpt is now the npm package`,
      fix: `rm ${binary} (then \`hash -r\`; the npm-installed mpt takes over)`,
    });
  }

  for (const bridge of n.legacyBridges) {
    checks.push({
      name: "mpt bridge",
      status: "warn",
      detail: `${bridge} is the bridge the old binary's \`mpt upgrade\` installed; it works, handing off to the npm package`,
      fix: `rm ${bridge} once npm's own mpt is on PATH (\`npm prefix -g\`/bin; then \`hash -r\`)`,
    });
  }

  if (c && !c.problem && !n.runningMatchesConfigured) {
    checks.push({
      name: "Running Node",
      status: "warn",
      detail: `this mpt runs on ${n.runningNode}, not the configured ${c.path}`,
      fix: "fine for a one-off; otherwise run mpt with the configured Node, or mpt setup --node <path>",
    });
  }
  return checks;
}

/**
 * The extension registration check, which carries the most consequence.
 *
 * Pi identifies a local package by resolved path, so two registrations are two
 * packages and the extension loads **twice** — duplicate tools and commands, two
 * directive pollers, two heartbeats per agent. That is the failure P2-4 prevents,
 * and it is silent, so doctor names it explicitly.
 */
function extensionCheck(f: DoctorFacts): Check {
  const { registrations: regs } = f;

  if (regs.length > 1) {
    return {
      name: "Extension",
      status: "fail",
      detail: `registered ${regs.length} times (${regs.map((r) => `${r.kind}: ${r.resolvedPath}`).join("; ")}) — ` +
        "Pi would load it twice: duplicate tools, two directive pollers, two heartbeats per agent",
      fix: "mpt setup (removes the extra registrations, keeping one)",
    };
  }

  if (regs.length === 0) {
    return {
      name: "Extension",
      status: "fail",
      detail: "not registered with Pi",
      fix: "mpt setup",
    };
  }

  const reg = regs[0]!;
  switch (reg.kind) {
    case "managed":
      return { name: "Extension", status: "ok", detail: `managed install at ${reg.resolvedPath}` };
    case "dev":
      return {
        name: "Extension",
        status: "ok",
        detail: `development checkout at ${reg.resolvedPath} — mpt setup will leave it alone`,
      };
    case "legacy":
      return {
        name: "Extension",
        status: "warn",
        detail: `${reg.resolvedPath} is a pre-merge standalone pi-pizza-team checkout; ` +
          "that repo is archived and the extension now ships inside mpt",
        fix: "mpt setup (registers the managed copy and removes this entry)",
      };
    case "missing":
      return {
        name: "Extension",
        status: "fail",
        detail: `registered at ${reg.resolvedPath}, which no longer exists`,
        fix: "mpt setup (replaces it with the managed copy)",
      };
  }
}

// ─── Fact gathering ──────────────────────────────────────────────────

/** Is `cmd` runnable, and what does it report for `--version`? */
async function probeVersion(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    // Rejects on a non-zero exit or a missing command alike — both mean "not usable".
    const { stdout } = await promisify(execFile)(cmd, args, { encoding: "utf8" });
    const text = stdout.trim();
    return text.match(/\d+\.\d+\.\d+/)?.[0] ?? text.split("\n")[0] ?? null;
  } catch {
    return null;
  }
}


export interface GatherOptions {
  teamDir: string;
  projectDir: string;
  daemonVersion: string;
  daemonUrl: string;
  serviceInstalled: boolean;
  /** What the installed service launches (cli/service.ts detectInstalledService), for the Node checks. */
  service?: ServiceProgram | null;
}

/** Gather the Node facts: the configured Node (run once for its version), the service, this process. */
export function gatherNodeFacts(service: ServiceProgram | null): NodeFacts {
  const configured = configuredNode();
  let facts: NodeFacts["configured"] = null;
  if (configured) {
    const result = checkNode(configured.path);
    facts = {
      path: configured.path,
      source: describeNodeSource(configured.source),
      version: result.ok ? result.version : result.version ?? null,
      problem: result.ok ? null : result.problem,
      pinnedWarning: pinnedNodeWarning(configured.path, stableNodeAlternative()),
    };
  }
  const expectedEntry = cliEntryScript();
  return {
    configured: facts,
    required: requiredNodeVersionString(),
    runningNode: process.execPath,
    runningMatchesConfigured: configured ? sameFile(process.execPath, configured.path) : true,
    service,
    expectedEntry,
    serviceEntryMatches: service?.entry ? sameFile(service.entry, expectedEntry) : false,
    legacyBinaries: findLegacyBinaries(),
    legacyBridges: findLegacyBridges(),
    serviceIsBridge: service ? isLegacyBridge(service.node) : false,
  };
}

/** Magic numbers of native executables: ELF, Mach-O (32/64-bit, either byte order, universal), PE. */
const NATIVE_MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x4d, 0x5a],
];

/** Does the file (symlinks followed) start like a native executable rather than a script? */
export function isNativeExecutable(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, 4, 0);
    return NATIVE_MAGIC.some((m) => n >= m.length && m.every((b, i) => head[i] === b));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Every `mpt` on PATH that is a native binary. The npm install's `mpt` is a symlink
 * to (or, on Windows, a shim for) a JS file, so a native one is the old compiled build.
 */
export function findLegacyBinaries(pathEnv: string = process.env.PATH ?? ""): string[] {
  const found: string[] = [];
  for (const dir of new Set(pathEnv.split(path.delimiter).filter(Boolean))) {
    const candidate = path.join(dir, process.platform === "win32" ? "mpt.exe" : "mpt");
    if (existsSync(candidate) && isNativeExecutable(candidate)) found.push(candidate);
  }
  return found;
}

/** The marker line in scripts/legacy-bridge.sh. */
const BRIDGE_MARKER = "MPT_LEGACY_BRIDGE";

/** Is the file (symlinks followed) scripts/legacy-bridge.sh? It carries the marker near its top. */
export function isLegacyBridge(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(1024);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const text = head.subarray(0, n).toString("utf8");
    return text.startsWith("#!") && text.includes(BRIDGE_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Every `mpt` on PATH that is the legacy bridge (see `isLegacyBridge`). */
export function findLegacyBridges(pathEnv: string = process.env.PATH ?? ""): string[] {
  if (process.platform === "win32") return [];
  const found: string[] = [];
  for (const dir of new Set(pathEnv.split(path.delimiter).filter(Boolean))) {
    const candidate = path.join(dir, "mpt");
    if (existsSync(candidate) && isLegacyBridge(candidate)) found.push(candidate);
  }
  return found;
}

export async function gather(opts: GatherOptions): Promise<DoctorFacts> {
  const agentDir = piAgentDir();
  const settings = readPiSettings(agentDir);
  const managedDir = managedExtensionDir();
  const sourceDir = resolveExtensionSourceDir();

  let daemonRunning = false;
  let leaderConnected: boolean | null = null;
  let spawning: DoctorFacts["spawning"] = null;
  try {
    const health = await fetch(`${opts.daemonUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (health.ok) {
      const body = await health.json() as { spawning?: { canSpawn: boolean; reason?: string; fix?: string } };
      spawning = body.spawning ?? null;
    }
  } catch { /* covered by the daemon check below */ }
  try {
    const res = await fetch(`${opts.daemonUrl}/api/agents`, { signal: AbortSignal.timeout(1500) });
    daemonRunning = res.ok;
    if (res.ok) {
      const body = await res.json() as { agents?: Array<{ name: string; status: string }> };
      leaderConnected = (body.agents ?? []).some((a) =>
        a.status !== "offline" && a.name.toLowerCase().includes("leader")
      );
    }
  } catch {
    daemonRunning = false;
  }
  let plugins: PluginLoadStatus[] | null = null;
  if (daemonRunning) {
    try {
      const res = await fetch(`${opts.daemonUrl}/api/work-sources`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) plugins = (await res.json() as Partial<WorkSourcesResponse>).plugins ?? null;
    } catch { /* an older or unreachable daemon: the check is skipped */ }
  }

  return {
    piVersion: await probeVersion("pi"),
    tmuxPresent: tmuxAvailable(),
    daemonVersion: opts.daemonVersion,
    bundledExtensionVersion: sourceDir ? readExtensionVersion(sourceDir) : null,
    registrations: findExtensionRegistrations(settings, { managedDir, agentDir }),
    managedDir,
    managedDirVersion: existsSync(managedDir) ? readExtensionVersion(managedDir) : null,
    permissionSystemInstalled: hasPackage(settings, PERMISSION_SYSTEM_PACKAGE),
    settingsPath: piSettingsPath(agentDir),
    settingsReadable: !settings.exists || Object.keys(settings.raw).length > 0,
    teamDir: opts.teamDir,
    teamDirPresent: existsSync(opts.teamDir),
    teamDirExists: existsSync(path.join(opts.teamDir, "config.json")),
    projectTrusted: isProjectTrusted(opts.projectDir, agentDir),
    daemonRunning,
    leaderConnected,
    spawning,
    serviceInstalled: opts.serviceInstalled,
    node: gatherNodeFacts(opts.service ?? null),
    experimentalHarnesses: experimentalHarnessFacts(opts.teamDir),
    plugins,
  };
}

/** Whether each ACP harness could launch here — only if the team opted in to them. */
function experimentalHarnessFacts(teamDir: string): DoctorFacts["experimentalHarnesses"] {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as { experimental?: { harnesses?: boolean } };
    if (!config.experimental?.harnesses) return undefined;
  } catch {
    return undefined;
  }
  const out: NonNullable<DoctorFacts["experimentalHarnesses"]> = {};
  for (const [name, h] of Object.entries(ACP_HARNESSES)) {
    try {
      h.launch();
      out[name] = { ready: true };
    } catch (e) {
      out[name] = { ready: false, missing: (e as Error).message.split(" — ")[0], fix: `mpt setup --harness ${name}` };
    }
  }
  return out;
}

// ─── Rendering ───────────────────────────────────────────────────────

const GLYPH: Record<CheckStatus, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

/** Print the checklist. Returns the process exit code: non-zero when anything failed. */
export function report(checks: Check[]): number {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${GLYPH[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
    // A fix on an ok check is an optional next step, not a problem to solve.
    if (c.fix && c.status !== "ok") console.log(`${" ".repeat(width + 4)}→ ${c.fix}`);
    else if (c.fix) console.log(`${" ".repeat(width + 4)}  (optional: ${c.fix})`);
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  console.log();
  if (failed === 0 && warned === 0) console.log("Everything checks out.");
  else console.log(`${failed} problem(s), ${warned} warning(s).`);
  return failed > 0 ? 1 : 0;
}
