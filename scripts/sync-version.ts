#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * scripts/sync-version.ts — Propagate the single version to every npm manifest.
 *
 * `deno.json` holds the one version for this repo (see cli/main.ts, which imports
 * it as the binary's version). The npm manifests carry copies: the Pi extension's
 * `package.json` (Pi discovers packages that way) and the root `package.json` /
 * `package-lock.json` (the Node build). A copy is exactly what drifted before the
 * merge (daemon 0.17.2 vs extension 0.2.0), with nothing noticing.
 * docs/DESIGN.md "One Protocol, One Version".
 *
 * Package manifests are rewritten one version line at a time so their formatting
 * and comment keys survive untouched. The lockfile carries the version twice (top
 * level and `packages[""]`) and is pure npm-written JSON, so it is re-serialised
 * the way npm writes it.
 *
 *   deno task sync-version          # write
 *   deno task sync-version --check  # verify only; non-zero exit on drift
 */

const ROOT = new URL("../", import.meta.url);
/** Package manifests whose top-level "version" line is a copy of deno.json's. */
const MANIFESTS = ["harnesses/pi/package.json", "package.json"];
/** npm lockfiles whose root package version is a copy of deno.json's. */
const LOCKFILES = ["package-lock.json"];

const denoConfig = JSON.parse(await Deno.readTextFile(new URL("deno.json", ROOT)));
const version: string = denoConfig.version;
if (!version) {
  console.error("error: deno.json has no version");
  Deno.exit(1);
}

const check = Deno.args.includes("--check");
let drifted = false;

/** Report one file's state; write `updated` unless in --check mode. */
async function reconcile(rel: string, current: string, updated: () => string): Promise<void> {
  if (current === version) {
    console.log(`✓ ${rel} is at ${version}`);
    return;
  }
  if (check) {
    console.error(`✗ version drift: deno.json is ${version}, ${rel} is ${current}`);
    drifted = true;
    return;
  }
  await Deno.writeTextFile(new URL(rel, ROOT), updated());
  console.log(`✓ ${rel} ${current} → ${version}`);
}

// Anchor on the top-level "version" key. The manifests are small and machine-
// written, so the first match is the package's own version.
const VERSION_LINE = /^(\s*"version"\s*:\s*")([^"]*)(")/m;

for (const rel of MANIFESTS) {
  const manifest = await Deno.readTextFile(new URL(rel, ROOT));
  const found = manifest.match(VERSION_LINE);
  if (!found) {
    console.error(`error: no "version" field in ${rel}`);
    Deno.exit(1);
  }
  await reconcile(rel, found[2] ?? "", () => manifest.replace(VERSION_LINE, `$1${version}$3`));
}

for (const rel of LOCKFILES) {
  const lock = JSON.parse(await Deno.readTextFile(new URL(rel, ROOT)));
  const rootPkg = lock.packages?.[""];
  // Both copies must match; report the first one that doesn't.
  const current = lock.version !== version ? lock.version : rootPkg?.version ?? version;
  await reconcile(rel, current, () => {
    lock.version = version;
    if (rootPkg) rootPkg.version = version;
    return JSON.stringify(lock, null, 2) + "\n";
  });
}

if (drifted) {
  console.error("  fix with: deno task sync-version");
  Deno.exit(1);
}
