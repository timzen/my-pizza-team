/**
 * cli/doctor.ts — `mpt doctor`: check the prerequisites and print one fix per problem.
 *
 * The problem this exists for (docs/BATTERIES_INCLUDED.md §1.1): setup is a
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
 *     a requirement (§7).
 *   - Build-version skew between daemon and extension is reported, never enforced.
 *     The protocol handshake already refuses what it cannot serve (P1b-3); gating on
 *     build version would nag on every patch release until people ignored it.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
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

/** The Pi release this build was tested against. See §7 — advisory, not a gate. */
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
  serviceInstalled: boolean;
  githubTokenSet: boolean;
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
    checks.push(
      f.leaderConnected
        ? { name: "Leader", status: "ok", detail: "connected" }
        : {
          name: "Leader",
          status: "warn",
          detail: "no leader connected — nothing will spawn teammates or answer the chat",
          fix: "run `pi` in this folder (the leader is the agent you chat with)",
        },
    );
  }

  checks.push(
    f.serviceInstalled
      ? { name: "Service", status: "ok", detail: "installed (starts on login)" }
      : { name: "Service", status: "ok", detail: "not installed (optional)", fix: "mpt install" },
  );

  if (!f.githubTokenSet) {
    checks.push({
      name: "GITHUB_TOKEN",
      status: "ok",
      detail: "unset (only needed if `mpt upgrade` hits a rate limit on a shared IP)",
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
    const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output();
    if (!out.success) return null;
    const text = new TextDecoder().decode(out.stdout).trim();
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
}

export async function gather(opts: GatherOptions): Promise<DoctorFacts> {
  const agentDir = piAgentDir();
  const settings = readPiSettings(agentDir);
  const managedDir = managedExtensionDir();
  const sourceDir = resolveExtensionSourceDir();

  let daemonRunning = false;
  let leaderConnected: boolean | null = null;
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
    serviceInstalled: opts.serviceInstalled,
    githubTokenSet: Boolean(Deno.env.get("GITHUB_TOKEN")),
  };
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
