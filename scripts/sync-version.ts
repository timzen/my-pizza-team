#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * scripts/sync-version.ts — Propagate the single version to the Pi extension.
 *
 * `deno.json` holds the one version for this repo (see cli/main.ts, which imports
 * it as the binary's version). The extension needs its own `package.json` because
 * Pi discovers packages that way, so its `version` field is a copy — and a copy is
 * exactly what drifted before the merge (daemon 0.17.2 vs extension 0.2.0), with
 * nothing noticing. BATTERIES_INCLUDED.md P1a-3.
 *
 * Rewrites only the version line so the file's formatting and comment keys survive
 * untouched.
 *
 *   deno task sync-version          # write
 *   deno task sync-version --check  # verify only; non-zero exit on drift
 */

const ROOT = new URL("../", import.meta.url);
const EXT_MANIFEST = new URL("harnesses/pi/package.json", ROOT);

const denoConfig = JSON.parse(await Deno.readTextFile(new URL("deno.json", ROOT)));
const version: string = denoConfig.version;
if (!version) {
  console.error("error: deno.json has no version");
  Deno.exit(1);
}

const manifest = await Deno.readTextFile(EXT_MANIFEST);

// Anchor on the top-level "version" key. The manifest is small and machine-
// written, so the first match is the package's own version.
const VERSION_LINE = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
const found = manifest.match(VERSION_LINE);
if (!found) {
  console.error(`error: no "version" field in ${EXT_MANIFEST.pathname}`);
  Deno.exit(1);
}

const current = found[2];
const check = Deno.args.includes("--check");

if (current === version) {
  console.log(`✓ harnesses/pi/package.json is at ${version}`);
  Deno.exit(0);
}

if (check) {
  console.error(
    `✗ version drift: deno.json is ${version}, harnesses/pi/package.json is ${current}\n` +
      `  fix with: deno task sync-version`,
  );
  Deno.exit(1);
}

await Deno.writeTextFile(EXT_MANIFEST, manifest.replace(VERSION_LINE, `$1${version}$3`));
console.log(`✓ harnesses/pi/package.json ${current} → ${version}`);
