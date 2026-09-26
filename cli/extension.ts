/**
 * cli/extension.ts — Locating and writing out the bundled Pi extension.
 *
 * `mpt` carries the extension's source inside the binary (`deno compile
 * --include`), so installing it is `mpt setup` writing files rather than a
 * separate `pi install` of another repo. That is what stops the daemon and the
 * extension drifting apart — docs/BATTERIES_INCLUDED.md §1.2.
 *
 * Two things make this simpler than it sounds:
 *
 *   - **No install step.** The extension declares no runtime `dependencies`, and
 *     every package it imports is one Pi supplies itself, so writing the files is
 *     the whole job (asserted by tests/version.test.ts).
 *   - **No re-registration on upgrade.** Pi loads a local package *from its path,
 *     without copying* (Pi's docs/packages.md), so rewriting the managed directory
 *     is enough for the next agent start to pick it up.
 *
 * Two behaviours of `pi install <path>`, confirmed against an isolated
 * `PI_CODING_AGENT_DIR` rather than assumed:
 *
 *   - It records the path **relative to the settings file**, so the managed
 *     directory appears as `"../../.my-pizza-team/pi-extension"` rather than an
 *     absolute path. Anything comparing registrations must therefore *resolve*
 *     entries first (P2-4, P2-6) — string matching would miss it.
 *   - It dedupes by resolved path, including across spellings (a trailing slash
 *     does not add a second entry), so re-registering is already idempotent.
 *
 * Only what Pi needs at runtime is embedded — the manifest and `src/`. Notably not
 * `node_modules/` (455M of devDependencies for type-checking) nor `tests/`.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";

/** Files and directories that make up a usable extension package. */
export const EXTENSION_PAYLOAD = ["package.json", "src"] as const;

/**
 * Where the extension's source lives, in precedence order:
 *
 *   1. `MPT_PI_EXTENSION` — an explicit override, for development and tests.
 *   2. `<cwd>/harnesses/pi` — running from a checkout (`deno task`).
 *   3. Alongside the binary — `deno compile --include` keeps included files at
 *      their original relative paths, resolved from `Deno.mainModule`.
 *
 * Null when none of them has a `package.json`, which is what `doctor` reports
 * rather than a confusing failure later.
 */
export function resolveExtensionSourceDir(): string | null {
  const candidates: string[] = [];

  const override = Deno.env.get("MPT_PI_EXTENSION");
  if (override) candidates.push(override);

  candidates.push(path.join(Deno.cwd(), "harnesses", "pi"));

  try {
    const mainDir = path.dirname(path.fromFileUrl(Deno.mainModule));
    candidates.push(path.join(mainDir, "harnesses", "pi"));
    candidates.push(path.join(mainDir, "..", "harnesses", "pi"));
  } catch {
    // Deno.mainModule isn't a file URL (unusual); the other candidates stand.
  }

  for (const dir of candidates) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
  }
  return null;
}

/**
 * The managed directory the extension is written to.
 *
 * Deliberately one stable path per machine rather than one per team: Pi identifies
 * a local package by its *resolved absolute path*, so a per-team directory would
 * mint a separate package identity for every team — multiplying the double-load
 * problem `mpt setup` has to prevent (P2-4). The extension is per-machine tooling;
 * the team directory is team data.
 */
export function managedExtensionDir(): string {
  const home = Deno.env.get("MPT_HOME") ?? Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return path.join(home, ".my-pizza-team", "pi-extension");
}

/** The extension version recorded in a package directory, or null if unreadable. */
export function readExtensionVersion(dir: string): string | null {
  try {
    const manifest = JSON.parse(Deno.readTextFileSync(path.join(dir, "package.json")));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/** Recursively copy `from` → `to`, replacing whatever is at `to`. */
function replaceTree(from: string, to: string): void {
  if (existsSync(to)) Deno.removeSync(to, { recursive: true });
  Deno.mkdirSync(path.dirname(to), { recursive: true });
  copyTree(from, to);
}

function copyTree(from: string, to: string): void {
  const stat = Deno.statSync(from);
  if (stat.isFile) {
    Deno.mkdirSync(path.dirname(to), { recursive: true });
    Deno.writeFileSync(to, Deno.readFileSync(from));
    return;
  }
  Deno.mkdirSync(to, { recursive: true });
  for (const entry of Deno.readDirSync(from)) {
    copyTree(path.join(from, entry.name), path.join(to, entry.name));
  }
}

/**
 * Write the bundled extension into `targetDir`, replacing any previous contents.
 *
 * Replaces rather than merges on purpose: a file that a newer version deleted must
 * not survive, or Pi would keep loading it.
 */
export function writeExtension(sourceDir: string, targetDir: string): { version: string | null } {
  for (const item of EXTENSION_PAYLOAD) {
    const from = path.join(sourceDir, item);
    if (!existsSync(from)) throw new Error(`bundled extension is missing ${item} (looked in ${sourceDir})`);
  }

  // Stage beside the target, then swap, so an interrupted write can't leave a
  // half-populated directory that Pi would happily try to load.
  const staging = `${targetDir}.staging-${crypto.randomUUID().slice(0, 8)}`;
  try {
    Deno.mkdirSync(staging, { recursive: true });
    for (const item of EXTENSION_PAYLOAD) {
      copyTree(path.join(sourceDir, item), path.join(staging, item));
    }
    replaceTree(staging, targetDir);
  } finally {
    if (existsSync(staging)) Deno.removeSync(staging, { recursive: true });
  }

  return { version: readExtensionVersion(targetDir) };
}
