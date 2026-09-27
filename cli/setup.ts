/**
 * cli/setup.ts — `mpt setup`: make this machine ready to run a team.
 *
 * Split into a **plan** and an **apply** step. The planner is pure, so every
 * conflict rule is testable without a Pi install; apply does the smallest possible
 * set of writes and records them so `--uninstall` can undo exactly what was done.
 *
 * The rules exist because of how Pi identifies packages (docs/DESIGN.md
 * DESIGN.md "One Protocol, One Version"): a local package is identified by *resolved path*, so two registrations are
 * two different packages and Pi loads the extension **twice** — duplicate tools and
 * commands, two directive pollers, two heartbeats per agent. None of that announces
 * itself, so setup must guarantee exactly one registration rather than hope.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import {
  type ExtensionRegistration,
  packageSource,
  type PiSettings,
} from "./pi-config.ts";

/** One change setup intends to make. Rendered to the user before anything happens. */
export type Action =
  | { kind: "write-extension"; targetDir: string }
  | { kind: "register-extension"; targetDir: string }
  | { kind: "unregister"; source: string; resolvedPath: string; because: RegistrationKindReason }
  | { kind: "create-team-dir"; teamDir: string }
  | { kind: "trust-project"; projectDir: string };

export type RegistrationKindReason =
  | "superseded by the managed install"
  | "a development checkout is registered, so the managed copy is not needed"
  | "the pre-merge standalone repo is archived"
  | "the path no longer exists";

export interface SetupPlan {
  actions: Action[];
  /** Left alone on purpose, with the reason — shown so the choice is visible. */
  respected: string[];
  /** Reasons setup cannot proceed at all. */
  blockers: string[];
}

export interface PlanInput {
  /** Our own registrations, already classified and resolved. */
  registrations: ExtensionRegistration[];
  managedDir: string;
  /** False when Pi's settings exist but could not be parsed. */
  settingsReadable: boolean;
  /** The bundled extension is locatable (it isn't, if the binary was built wrong). */
  bundledExtensionAvailable: boolean;
  teamDirConfigured: boolean;
  projectTrusted: boolean;
  teamDir: string;
  projectDir: string;
}

/**
 * Decide what setup should do. Pure.
 *
 * The one judgement call worth stating: **a development checkout wins.** If someone
 * has `…/harnesses/pi` registered they are working on the extension, and quietly
 * replacing it with a managed copy would make their edits stop taking effect with no
 * indication why. So setup steps aside — it removes its own managed registration if
 * present (otherwise the extension loads twice) and reports that it did.
 */
export function planSetup(input: PlanInput): SetupPlan {
  const actions: Action[] = [];
  const respected: string[] = [];
  const blockers: string[] = [];

  if (!input.settingsReadable) {
    blockers.push(
      "Pi's settings.json exists but could not be parsed. Fix or remove it first — " +
        "mpt will not overwrite configuration it cannot read.",
    );
  }
  if (!input.bundledExtensionAvailable) {
    blockers.push(
      "the bundled Pi extension could not be located. Reinstall mpt, or set MPT_PI_EXTENSION to a checkout.",
    );
  }

  const dev = input.registrations.find((r) => r.kind === "dev");

  if (dev) {
    respected.push(`development checkout at ${dev.resolvedPath} — left registered, and left untouched on disk`);
    // Anything else of ours must go, or Pi loads the extension twice.
    for (const reg of input.registrations) {
      if (reg === dev) continue;
      actions.push({
        kind: "unregister",
        source: reg.source,
        resolvedPath: reg.resolvedPath,
        because: reg.kind === "managed"
          ? "a development checkout is registered, so the managed copy is not needed"
          : reasonFor(reg),
      });
    }
  } else {
    // Remove every non-managed registration of ours, then ensure the managed one.
    for (const reg of input.registrations) {
      if (reg.kind === "managed") continue;
      actions.push({ kind: "unregister", source: reg.source, resolvedPath: reg.resolvedPath, because: reasonFor(reg) });
    }

    // Always rewrite the directory: it is how an upgrade takes effect, and Pi loads
    // it from the path without copying, so writing is the whole job.
    actions.push({ kind: "write-extension", targetDir: input.managedDir });

    if (!input.registrations.some((r) => r.kind === "managed")) {
      actions.push({ kind: "register-extension", targetDir: input.managedDir });
    } else {
      respected.push(`already registered at ${input.managedDir}`);
    }
  }

  if (!input.teamDirConfigured) actions.push({ kind: "create-team-dir", teamDir: input.teamDir });
  if (!input.projectTrusted) actions.push({ kind: "trust-project", projectDir: input.projectDir });

  return { actions, respected, blockers };
}

function reasonFor(reg: ExtensionRegistration): RegistrationKindReason {
  switch (reg.kind) {
    case "legacy":
      return "the pre-merge standalone repo is archived";
    case "missing":
      return "the path no longer exists";
    default:
      return "superseded by the managed install";
  }
}

/** Nothing to do — used to print "already set up" rather than a blank plan. */
export function isNoOp(plan: SetupPlan): boolean {
  return plan.blockers.length === 0 && plan.actions.length === 0;
}

// ─── Settings mutation ───────────────────────────────────────────────

/**
 * Apply package-list changes to Pi's settings, preserving everything else.
 *
 * Returns the new settings object rather than writing, so the caller controls when
 * the file is touched (and so this is testable). `removed` and `added` are reported
 * for the uninstall manifest.
 */
export function applyPackageChanges(
  settings: PiSettings,
  opts: { remove: string[]; addLocalPath?: string; agentDir: string },
): { raw: Record<string, unknown>; removed: string[]; added: string[] } {
  const removeSet = new Set(opts.remove);
  const kept = settings.packages.filter((entry) => !removeSet.has(packageSource(entry)));
  const removed = settings.packages
    .map((e) => packageSource(e))
    .filter((s) => removeSet.has(s));

  const added: string[] = [];
  if (opts.addLocalPath) {
    // Record it the way Pi does: relative to the settings file. Matching Pi's own
    // convention keeps the file stable if Pi rewrites it later, and keeps the entry
    // portable if the home directory moves.
    const relative = path.relative(opts.agentDir, opts.addLocalPath);
    const entry = relative.startsWith("..") || path.isAbsolute(relative) ? relative : `./${relative}`;
    if (!kept.some((e) => packageSource(e) === entry)) {
      kept.push(entry);
      added.push(entry);
    }
  }

  return { raw: { ...settings.raw, packages: kept }, removed, added };
}

/**
 * Write Pi's settings atomically.
 *
 * Via a temp file and rename so an interrupted write cannot truncate a working
 * configuration — this is the user's editor-and-model setup, not ours.
 */
export function writePiSettingsFile(agentDir: string, raw: Record<string, unknown>): void {
  Deno.mkdirSync(agentDir, { recursive: true });
  const target = path.join(agentDir, "settings.json");
  const temp = `${target}.mpt-tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    Deno.writeTextFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`);
    Deno.renameSync(temp, target);
  } finally {
    if (existsSync(temp)) Deno.removeSync(temp);
  }
}

/** Mark a project directory trusted, preserving any other entries. */
export function trustProject(agentDir: string, projectDir: string): void {
  const file = path.join(agentDir, "trust.json");
  let trust: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      trust = JSON.parse(Deno.readTextFileSync(file)) as Record<string, unknown>;
    } catch {
      // An unreadable trust file is not worth failing setup over: Pi will re-prompt.
      trust = {};
    }
  }
  trust[path.resolve(projectDir)] = true;
  Deno.mkdirSync(agentDir, { recursive: true });
  const temp = `${file}.mpt-tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    Deno.writeTextFileSync(temp, `${JSON.stringify(trust, null, 2)}\n`);
    Deno.renameSync(temp, file);
  } finally {
    if (existsSync(temp)) Deno.removeSync(temp);
  }
}

// ─── Uninstall manifest ──────────────────────────────────────────────

/**
 * What setup changed, so `--uninstall` can undo exactly that and no more.
 *
 * Recorded because setup edits the *user's* Pi configuration. Without this,
 * uninstall would have to guess — and guessing at someone else's settings file is
 * how you delete a registration they added themselves.
 */
export interface SetupManifest {
  /** ISO timestamp of the last successful setup. */
  at: string;
  /** mpt version that performed it. */
  version: string;
  /** Pi config directory the changes were made in. */
  agentDir: string;
  /** Package entries setup added, exactly as written. */
  addedPackages: string[];
  /** Package entries setup removed, so uninstall doesn't restore them blindly. */
  removedPackages: string[];
  /** The managed extension directory, if setup wrote one. */
  managedDir: string | null;
  /** Project directories setup marked trusted. */
  trustedProjects: string[];
}

export function manifestPath(managedDirParent: string): string {
  return path.join(managedDirParent, "setup-manifest.json");
}

export function readManifest(file: string): SetupManifest | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(Deno.readTextFileSync(file)) as SetupManifest;
  } catch {
    return null;
  }
}

export function writeManifest(file: string, manifest: SetupManifest): void {
  Deno.mkdirSync(path.dirname(file), { recursive: true });
  Deno.writeTextFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
