/**
 * cli/pi-config.ts — Reading Pi's own configuration.
 *
 * `mpt setup` registers the managed extension in Pi's package list, so it has to
 * understand that file well enough to change it safely. Everything here is
 * read-only; writing lives in the setup path so the risky part has one home.
 *
 * Two properties of `pi install <path>` drive the design (both confirmed against an
 * isolated `PI_CODING_AGENT_DIR`, not assumed):
 *
 *   - Pi records a local package **relative to the settings file**, so the managed
 *     directory appears as `"../../.my-pizza-team/pi-extension"`. Every comparison
 *     here therefore resolves entries to absolute paths first. String matching
 *     would miss a conflict, which is the whole hazard (P2-4).
 *   - Pi identifies a local package by resolved path, so two entries resolving to
 *     different directories are two *different* packages — and registering both
 *     loads the extension twice: duplicate tools and commands, two directive
 *     pollers, two heartbeats per agent.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";

/** The extension's package name, used to recognise our own registrations. */
export const EXTENSION_PACKAGE_NAME = "pi-pizza-team";

/** Pi's per-user config directory. */
export function piAgentDir(): string {
  const override = Deno.env.get("PI_CODING_AGENT_DIR");
  if (override) return override;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return path.join(home, ".pi", "agent");
}

export function piSettingsPath(agentDir = piAgentDir()): string {
  return path.join(agentDir, "settings.json");
}

export function piTrustPath(agentDir = piAgentDir()): string {
  return path.join(agentDir, "trust.json");
}

/**
 * Pi's settings, as raw JSON plus the package list.
 *
 * The raw object is kept so a writer can round-trip fields it doesn't understand —
 * dropping a user's `defaultModel` or `theme` while installing an extension would
 * be unforgivable.
 */
export interface PiSettings {
  raw: Record<string, unknown>;
  packages: Array<string | Record<string, unknown>>;
  exists: boolean;
}

export function readPiSettings(agentDir = piAgentDir()): PiSettings {
  const file = piSettingsPath(agentDir);
  if (!existsSync(file)) return { raw: {}, packages: [], exists: false };
  try {
    const raw = JSON.parse(Deno.readTextFileSync(file)) as Record<string, unknown>;
    const packages = Array.isArray(raw.packages) ? raw.packages as Array<string | Record<string, unknown>> : [];
    return { raw, packages, exists: true };
  } catch {
    // Unparseable settings: report rather than guess. Overwriting would destroy
    // configuration we cannot read.
    return { raw: {}, packages: [], exists: true };
  }
}

/** Is a project directory trusted by Pi? Untrusted folders block agent startup. */
export function isProjectTrusted(dir: string, agentDir = piAgentDir()): boolean {
  const file = piTrustPath(agentDir);
  if (!existsSync(file)) return false;
  try {
    const trust = JSON.parse(Deno.readTextFileSync(file)) as Record<string, unknown>;
    const target = path.resolve(dir);
    // Pi trusts a folder or any ancestor of it.
    for (const [trusted, value] of Object.entries(trust)) {
      if (value !== true) continue;
      const t = path.resolve(trusted);
      if (target === t || target.startsWith(t + path.SEPARATOR)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The `source` string of a package entry, whichever form it takes. */
export function packageSource(entry: string | Record<string, unknown>): string {
  if (typeof entry === "string") return entry;
  const source = entry.source;
  return typeof source === "string" ? source : "";
}

/** A local path entry resolved to an absolute path, or null for npm/git sources. */
export function resolveLocalPackage(
  entry: string | Record<string, unknown>,
  agentDir = piAgentDir(),
): string | null {
  const source = packageSource(entry);
  if (!source) return null;
  // npm:, git:, and URL sources are not paths.
  if (/^(npm:|git:|https?:|ssh:)/.test(source)) return null;
  // Relative entries resolve from the settings file that contains them.
  return path.resolve(agentDir, source);
}

/** How a registration of our extension got there, which decides what to do with it. */
export type RegistrationKind =
  /** The directory `mpt setup` manages — the one that should remain. */
  | "managed"
  /**
   * A monorepo checkout (`…/harnesses/pi`). Someone is developing against it, so
   * setup leaves it alone and steps aside rather than competing with it.
   */
  | "dev"
  /**
   * A pre-merge standalone `pi-pizza-team` checkout. Indistinguishable from a dev
   * checkout by manifest — both are named `pi-pizza-team` — so it is told apart by
   * path shape. Worth calling out separately because it is actionable: that repo is
   * archived, and the extension now ships inside `mpt`.
   */
  | "legacy"
  /** Points at a path that no longer exists. */
  | "missing";

export interface ExtensionRegistration {
  /** The entry exactly as it appears in settings.json. */
  entry: string | Record<string, unknown>;
  source: string;
  resolvedPath: string;
  kind: RegistrationKind;
}

/**
 * Find every registration of *our* extension in Pi's package list.
 *
 * Identified by the package manifest's `name` where it can be read, and by path
 * shape where it can't — a stale entry pointing at a deleted directory has no
 * manifest to inspect, but is exactly the kind of leftover setup must clear.
 */
export function findExtensionRegistrations(
  settings: PiSettings,
  opts: { managedDir: string; agentDir?: string },
): ExtensionRegistration[] {
  const agentDir = opts.agentDir ?? piAgentDir();
  const managed = path.resolve(opts.managedDir);
  const found: ExtensionRegistration[] = [];

  for (const entry of settings.packages) {
    const resolvedPath = resolveLocalPackage(entry, agentDir);
    if (!resolvedPath) continue;

    const manifestPath = path.join(resolvedPath, "package.json");
    let name: string | null = null;
    if (existsSync(manifestPath)) {
      try {
        name = (JSON.parse(Deno.readTextFileSync(manifestPath)) as { name?: string }).name ?? null;
      } catch { /* unreadable manifest falls through to the path heuristic */ }
    }

    const looksLikeOurs = name === EXTENSION_PACKAGE_NAME ||
      (name === null && /(^|[/\\])(pi-pizza-team|pi-extension)$|[/\\]harnesses[/\\]pi$/.test(resolvedPath));
    if (!looksLikeOurs) continue;

    let kind: RegistrationKind;
    if (resolvedPath === managed) kind = "managed";
    else if (!existsSync(resolvedPath)) kind = "missing";
    else if (/[/\\]harnesses[/\\]pi$/.test(resolvedPath)) kind = "dev";
    else kind = "legacy";

    found.push({ entry, source: packageSource(entry), resolvedPath, kind });
  }

  return found;
}

/** Is a non-local package (by npm name or git repo) registered? */
export function hasPackage(settings: PiSettings, source: string): boolean {
  return settings.packages.some((entry) => {
    const s = packageSource(entry);
    // Match ignoring an npm version suffix: npm:pkg@1.2.3 satisfies npm:pkg.
    return s === source || s.startsWith(`${source}@`);
  });
}
