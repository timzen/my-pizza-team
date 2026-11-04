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
import { createTerminalBackend, formatTerminalStatus, getTerminalBackend } from "../daemon/terminal/index.ts";
import type { TerminalStatus } from "../daemon/terminal/backend.ts";
import { findPreCutoffLayout, type PreCutoffFinding } from "../daemon/layout-check.ts";
import { MIN_UPGRADE_FROM_VERSION, PRE_CUTOFF_UPGRADE_MESSAGE } from "../shared/types.ts";
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
import { readTeamConfigFile } from "../shared/team-config.ts";
import { loadAgentEnv } from "../shared/env-file.ts";
import type { ServiceProgram } from "./service.ts";
import type { PluginLoadStatus, SourcesResponse } from "../shared/protocol.ts";
import { checkLines, checksExitCode, type CheckStatus, countChecks, EMOJI_GLYPHS } from "./checks.ts";

/** The Pi release this build was tested against. See DESIGN.md "One Protocol, One Version" — advisory, not a gate. */
export const TESTED_PI_VERSION = "0.87.1";

/** The npm package that makes autonomous teammates possible. */
export const PERMISSION_SYSTEM_PACKAGE = "npm:@gotgenes/pi-permission-system";

export type { CheckStatus } from "./checks.ts";

/** One `mpt doctor` check (the shared model is cli/checks.ts). */
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
  /**
   * Signs that the team was last run on a version older than 0.36.0
   * (daemon/layout-check.ts). Empty or absent = the current layout.
   */
  preCutoffLayout?: PreCutoffFinding[];
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
  /** Whether the daemon can realize spawns (it is the only realizer), as reported by the running daemon. */
  spawning: { canSpawn: boolean; reason?: string; fix?: string } | null;
  /**
   * The tmux server socket the running daemon talks to (`/health` `tmuxSocket`),
   * and the one this CLI resolves (the terminal backend's `identity`,
   * daemon/terminal/tmux.ts tmuxSocketPath). Absent/null =
   * not known (daemon down or older, or tmux unreachable); the same-server check
   * runs only when both are known.
   */
  daemonTmuxSocket?: string | null;
  cliTmuxSocket?: string | null;
  /**
   * The terminal the running daemon opens new windows in (`/health` `terminal`), and
   * the online agents it still has under another one (`agentsOnOtherTerminal`) — a
   * `terminal` switch applies to new windows only. Absent/null = not known.
   */
  daemonTerminal?: string | null;
  agentsOnOtherTerminal?: Array<{ name: string; terminal: string }> | null;
  /**
   * The team's configured terminal as this CLI sees it (`TerminalBackend.describe`:
   * available, version, server running, socket; herdr's session), and as the running
   * daemon does (`/health` `terminalStatus`). Absent/null = not known (no team
   * config, the daemon down or older). For herdr, the two sockets are compared like
   * tmux's.
   */
  terminal?: TerminalStatus | null;
  daemonTerminalStatus?: TerminalStatus | null;
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
   * (`GET /api/sources` `plugins`; daemon/plugins/loader.ts). Absent/null =
   * not known (daemon down, or an older daemon).
   */
  plugins?: PluginLoadStatus[] | null;
  /**
   * The team's agent env file (`agentEnvFile`, shared/env-file.ts), as this CLI
   * reads it now: its path (null = unset), why it can't be used (null = fine), and
   * how many keys it defines. Never values. Absent = not checked.
   */
  agentEnv?: { path: string | null; problem: string | null; keys: number };
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
 * The terminal checks: tmux (the default) and, when the team uses it, herdr — the
 * selected backend's version, server and session, from this CLI's side — plus
 * herdr's same-server check (the daemon's socket vs this shell's, like tmux's below).
 *
 * tmux missing fails only while tmux is the team's terminal: a herdr team doesn't
 * need it (agents started under tmux before a switch are the "Terminal" check's
 * business).
 */
function terminalChecks(f: DoctorFacts): Check[] {
  const checks: Check[] = [];
  const selected = f.terminal?.kind ?? f.daemonTerminal ?? "tmux";
  if (!f.tmuxPresent && selected !== "tmux") {
    checks.push({ name: "tmux", status: "ok", detail: `not found (not needed: this team's terminal is ${selected})` });
  } else if (!f.tmuxPresent) {
    checks.push({
      name: "tmux",
      status: "fail",
      detail: "not found on PATH — teammates run in tmux windows",
      fix: "brew install tmux (or your platform's package manager)",
    });
  } else if (f.terminal?.kind === "tmux") {
    checks.push({ name: "tmux", status: "ok", detail: `the team's terminal: ${formatTerminalStatus(f.terminal, "tmux")}` });
  } else {
    checks.push({ name: "tmux", status: "ok", detail: "found" });
  }

  if (f.terminal?.kind === "herdr") {
    const t = f.terminal;
    checks.push(
      t.available
        ? {
          name: "herdr",
          status: "ok",
          detail: `the team's terminal: ${formatTerminalStatus(t, "herdr")}` +
            (t.serverRunning === false ? " — mpt starts it when it opens the next window" : ""),
        }
        : {
          name: "herdr",
          status: "fail",
          detail: `the team's terminal, but ${t.reason ?? "it can't be used from this shell"}`,
          fix: t.fix ?? "install herdr (https://herdr.dev), or set Terminal back to tmux in Config → General",
        },
    );
    // Same herdr server: the socket comes from $XDG_CONFIG_HOME / $HOME, so a daemon
    // launched with a different environment talks to a server `herdr` never attaches to.
    const daemonSocket = f.daemonRunning && f.daemonTerminalStatus?.kind === "herdr" ? f.daemonTerminalStatus.identity : null;
    if (daemonSocket && t.identity && daemonSocket !== t.identity) {
      checks.push({
        name: "herdr server",
        status: "warn",
        detail: `the daemon uses ${daemonSocket}, this shell uses ${t.identity} — its windows open on a server you don't attach to`,
        fix: "restart the daemon from this shell (mpt stop && mpt start; for the login service, mpt install) so they match",
      });
    }
  }
  return checks;
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

  checks.push(...terminalChecks(f));

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

  const tooOld = f.preCutoffLayout ?? [];
  if (tooOld.length > 0) checks.push(teamLayoutCheck(f.teamDir, tooOld));

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
    // What a missing leader costs depends on whether the daemon can spawn (it is the
    // only thing that does). Saying "nothing will spawn" next to "Spawning:
    // daemon-driven" would be self-contradicting; when it can't, the Spawning check
    // below says so, with its own fix.
    const daemonSpawns = f.spawning?.canSpawn === true;
    checks.push(
      f.leaderConnected
        ? { name: "Assistant", status: "ok", detail: "connected" }
        : {
          name: "Assistant",
          status: "warn",
          detail: daemonSpawns
            ? "no assistant connected — the chat is unanswered and the team size waits for one (a one-off spawn still starts)"
            : "no assistant connected — the chat is unanswered",
          fix: "mpt assistant, or the Start button in the web UI (the assistant is the agent you chat with)",
        },
    );
  }

  // Spawning: the daemon realizes every spawn and dismiss, or none — there is no
  // leader-driven fallback any more, so "can't" is an error with a fix, not a mode.
  if (f.daemonRunning && f.spawning) {
    checks.push(
      f.spawning.canSpawn
        ? { name: "Spawning", status: "ok", detail: `daemon-driven (it can reach ${f.daemonTerminalStatus?.displayName ?? f.daemonTerminal ?? "tmux"})` }
        : {
          name: "Spawning",
          status: "fail",
          detail: `the daemon can't spawn teammates: ${f.spawning.reason ?? "unknown"}`,
          fix: f.spawning.fix ?? "restart the daemon from a shell that has tmux (mpt stop && mpt start)",
        },
    );
  }

  // Same tmux server: plain `tmux` means the user's default server, but which socket
  // that is depends on the environment ($TMUX, $TMUX_TMPDIR, the uid). A daemon that
  // resolves a different one opens its windows where `tmux attach -t mpt` never looks.
  if (f.daemonRunning && f.daemonTmuxSocket && f.cliTmuxSocket && f.daemonTmuxSocket !== f.cliTmuxSocket) {
    checks.push({
      name: "tmux server",
      status: "warn",
      detail: `the daemon uses ${f.daemonTmuxSocket}, this shell uses ${f.cliTmuxSocket} — its windows open on a server you don't attach to`,
      fix: `restart the daemon from this shell (mpt stop && mpt start; for the login service, mpt install) so they match, or attach with: tmux -S ${f.daemonTmuxSocket} attach`,
    });
  }

  // A terminal switch applies to new windows only: say so while agents started under
  // the old one are still online (they keep working there, and dismiss/focus still
  // reach them), so a half-switched team isn't a mystery.
  if (f.daemonRunning && f.daemonTerminal && f.agentsOnOtherTerminal && f.agentsOnOtherTerminal.length > 0) {
    const others = f.agentsOnOtherTerminal.map((a) => `${a.name} (${a.terminal})`).join(", ");
    checks.push({
      name: "Terminal",
      status: "warn",
      detail: `new windows open in ${f.daemonTerminal}, but ${f.agentsOnOtherTerminal.length} online agent(s) still run under another terminal: ${others}`,
      fix: "they keep working where they are; to move one, dismiss it (the team respawns teammates) — for the assistant, quit it and start it again",
    });
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

  if (f.agentEnv) checks.push(agentEnvCheck(f.agentEnv));

  if (f.node) checks.push(...nodeChecks(f.node));

  return checks;
}

/**
 * The ✗ for a pre-0.36.0 team (daemon/layout-check.ts): what was found, on one
 * line, and the same upgrade path the daemon prints when it refuses to start.
 */
export function teamLayoutCheck(teamDir: string, findings: PreCutoffFinding[]): Check {
  const MAX = 4;
  const names = findings.slice(0, MAX).map((x) => path.relative(teamDir, x.path) || x.path);
  const more = findings.length > MAX ? ` and ${findings.length - MAX} more` : "";
  return {
    name: "Team layout",
    status: "fail",
    detail: `from before ${MIN_UPGRADE_FROM_VERSION} — the daemon won't start on it (found ${names.join(", ")}${more})`,
    fix: PRE_CUTOFF_UPGRADE_MESSAGE,
  };
}

/**
 * The agent env file check: unset is fine (optional); a set file must exist and
 * parse, else windows open without it — a warning, since spawning goes on. The
 * detail carries the key count, never a value.
 */
export function agentEnvCheck(env: NonNullable<DoctorFacts["agentEnv"]>): Check {
  if (!env.path) return { name: "Agent env", status: "ok", detail: "agentEnvFile not set (optional)" };
  if (env.problem) {
    return {
      name: "Agent env",
      status: "warn",
      detail: `${env.problem} — new windows open without it`,
      fix: "fix the file (KEY=value per line, # comments, no `export`), or unset agentEnvFile in config.json",
    };
  }
  return { name: "Agent env", status: "ok", detail: `${env.path} (${env.keys} variable(s), passed to every new window)` };
}

/**
 * The plugin checks: one line when every package loaded, else a warning per
 * failed package (the daemon runs without it — a failing plugin is skipped,
 * never fatal), whose fix points at `mpt plugins doctor` for the details.
 * Nothing when the team declares no `packages`.
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
    fix: p.error?.startsWith("install failed")
      ? "the daemon's install-on-start failed: fix the package (see docs/PLUGINS.md \"Distributing a plugin\") or `mpt plugins update` it, then restart the daemon (it retries); see [plugins] in the daemon log"
      : p.error?.includes("not installed")
      ? `mpt plugins add ${p.spec} (or mpt plugins update), then restart the daemon; run \`mpt plugins doctor\` for details`
      : "fix the package or its entry in config.json packages, then restart the daemon; run `mpt plugins doctor` for details (or see [plugins] in the daemon log)",
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

  if (n.service && !n.service.entry) {
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
      // The registration is classified by path alone, so it stays "managed" even
      // after the directory is deleted (e.g. `rm -rf ~/.my-pizza-team`). Without a
      // readable manifest Pi can't load it, so that is a failure, not "ok".
      if (f.managedDirVersion === null) {
        return {
          name: "Extension",
          status: "fail",
          detail: `registered at ${reg.resolvedPath}, but the managed install is missing or has no readable package.json`,
          fix: "mpt setup (rewrites the managed extension)",
        };
      }
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
  };
}

export async function gather(opts: GatherOptions): Promise<DoctorFacts> {
  const agentDir = piAgentDir();
  const settings = readPiSettings(agentDir);
  const managedDir = managedExtensionDir();
  const sourceDir = resolveExtensionSourceDir();

  let daemonRunning = false;
  let leaderConnected: boolean | null = null;
  let spawning: DoctorFacts["spawning"] = null;
  let daemonTmuxSocket: string | null = null;
  let daemonTerminal: string | null = null;
  let agentsOnOtherTerminal: DoctorFacts["agentsOnOtherTerminal"] = null;
  let daemonTerminalStatus: TerminalStatus | null = null;
  try {
    const health = await fetch(`${opts.daemonUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (health.ok) {
      const body = await health.json() as {
        spawning?: { canSpawn: boolean; reason?: string; fix?: string };
        tmuxSocket?: string | null;
        terminal?: string;
        agentsOnOtherTerminal?: Array<{ name: string; terminal: string }>;
        terminalStatus?: TerminalStatus | null;
      };
      spawning = body.spawning ?? null;
      daemonTmuxSocket = body.tmuxSocket ?? null;
      daemonTerminal = body.terminal ?? null;
      agentsOnOtherTerminal = body.agentsOnOtherTerminal ?? null;
      daemonTerminalStatus = body.terminalStatus ?? null;
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
      const res = await fetch(`${opts.daemonUrl}/api/sources`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) plugins = (await res.json() as Partial<SourcesResponse>).plugins ?? null;
    } catch { /* an older or unreachable daemon: the check is skipped */ }
  }

  // tmux specifically: its presence and socket are what the checks below compare
  // (the daemon's tmux server), whatever the team's `terminal` says.
  const terminal = createTerminalBackend("tmux");
  // And the team's configured terminal, described from this shell (never starts a server).
  const selected = configuredTerminalStatus(opts.teamDir);
  return {
    piVersion: await probeVersion("pi"),
    tmuxPresent: terminal.available(),
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
    preCutoffLayout: findPreCutoffLayout(opts.teamDir),
    teamDirExists: existsSync(path.join(opts.teamDir, "config.json")),
    projectTrusted: isProjectTrusted(opts.projectDir, agentDir),
    daemonRunning,
    leaderConnected,
    spawning,
    daemonTmuxSocket,
    cliTmuxSocket: daemonTmuxSocket ? terminal.identity() : null,
    daemonTerminal,
    agentsOnOtherTerminal,
    terminal: selected,
    daemonTerminalStatus,
    serviceInstalled: opts.serviceInstalled,
    node: gatherNodeFacts(opts.service ?? null),
    experimentalHarnesses: experimentalHarnessFacts(opts.teamDir),
    plugins,
    agentEnv: agentEnvFacts(opts.teamDir),
  };
}

/**
 * The team's configured terminal (`terminal`, `herdrSession` in config.json), as
 * this shell can reach it; null when config.json can't be read. tmux's status
 * comes from the same calls doctor makes anyway; herdr's from `herdr status`.
 */
function configuredTerminalStatus(teamDir: string): TerminalStatus | null {
  let config: Record<string, unknown> | undefined;
  try {
    config = readTeamConfigFile(teamDir) as Record<string, unknown> | undefined;
  } catch {
    return null;
  }
  try {
    return getTerminalBackend(config ?? {}).describe();
  } catch {
    return null; // an unknown `terminal` value: the daemon's Spawning check says so
  }
}

/** The agent env file as `mpt doctor` reports it (path, problem, key count), or undefined when config.json can't be read. */
function agentEnvFacts(teamDir: string): DoctorFacts["agentEnv"] {
  let config: { agentEnvFile?: string } | undefined;
  try {
    config = readTeamConfigFile(teamDir) as { agentEnvFile?: string } | undefined;
  } catch {
    return undefined;
  }
  const env = loadAgentEnv(config ?? {}, teamDir);
  return { path: env.path, problem: env.problem, keys: env.keys.length };
}

/** Whether each ACP harness could launch here — only if the team opted in to them. */
function experimentalHarnessFacts(teamDir: string): DoctorFacts["experimentalHarnesses"] {
  try {
    const config = readTeamConfigFile(teamDir) as { experimental?: { harnesses?: boolean } } | undefined;
    if (!config?.experimental?.harnesses) return undefined;
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

/** Print the checklist. Returns the process exit code: non-zero when anything failed. */
export function report(checks: Check[]): number {
  const width = Math.max(...checks.map((c) => c.name.length));
  const hintIndent = " ".repeat(width + 4);
  for (const c of checks) {
    for (const line of checkLines(c.status, `${c.name.padEnd(width)}  ${c.detail}`, c.fix, { glyphs: EMOJI_GLYPHS, hintIndent, optionalOkHint: true })) {
      console.log(line);
    }
  }

  const counts = countChecks(checks);
  console.log();
  if (counts.fail === 0 && counts.warn === 0) console.log("Everything checks out.");
  else console.log(`${counts.fail} problem(s), ${counts.warn} warning(s).`);
  return checksExitCode(counts);
}
