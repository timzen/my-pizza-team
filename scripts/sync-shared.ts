#!/usr/bin/env node
/**
 * scripts/sync-shared.ts — Generate the Pi extension's shared definitions.
 *
 * The daemon and the extension need the same definitions, in two files:
 *
 *   - harnesses/pi/src/shared/types.ts — a handful of values from shared/types.ts
 *     (team directory names, the default daemon URL, the default tmux session,
 *     and the built-in harness templates the leader falls back to when it
 *     realizes spawns itself), rendered from the imported module.
 *   - harnesses/pi/src/shared/agent-protocol.ts — shared/agent-protocol.ts copied
 *     verbatim: PROTOCOL_VERSION, the feature toggles, and the agent routes'
 *     reply types. Copied whole rather than rendered because it is mostly types,
 *     which don't exist at runtime; the source has no imports so the copy is
 *     self-contained (checked here).
 *   - harnesses/pi/src/runtime/*.ts — the root runtime/ modules (DaemonClient,
 *     the transcript mirror, pairing, bubbles, usage, session stats) copied
 *     verbatim under a banner. runtime/ is harness-agnostic protocol code that
 *     agent/ and cli/ import too, so it lives at the root rather than inside the
 *     extension; the extension gets its own copy. The only cross-directory import
 *     a runtime module may make is `../shared/agent-protocol.ts`, which resolves
 *     to shared/agent-protocol.ts at the root and to the generated copy above in
 *     the extension — the same specifier works in both places (checked here).
 *
 * Two hand-maintained copies is exactly the duplication docs/DESIGN.md "One
 * Protocol, One Version" warns about, and the copies had drifted: the extension
 * declared `WorkflowConfig.states` as `string[]` while the daemon had moved to
 * `WorkflowState[]`, and shared/protocol.ts still listed an inbox `chat` flag
 * the daemon stopped sending.
 *
 * Importing the root `shared/` directly isn't an option: the extension is a
 * self-contained package that `mpt setup` writes to a managed directory outside
 * this repo (P2-3), so a relative import would escape it. Generating keeps one
 * source of truth *and* a self-contained package.
 *
 *   npm run sync-shared              # write
 *   npm run sync-shared -- --check   # verify only; non-zero exit on drift
 */

import * as fs from "node:fs";
import { isMainModule } from "../shared/main-module.ts";

const ROOT = new URL("../", import.meta.url);
export const SOURCE = new URL("shared/types.ts", ROOT);
export const TARGET = new URL("harnesses/pi/src/shared/types.ts", ROOT);
export const PROTOCOL_SOURCE = new URL("shared/agent-protocol.ts", ROOT);
export const PROTOCOL_TARGET = new URL("harnesses/pi/src/shared/agent-protocol.ts", ROOT);
export const RUNTIME_SOURCE_DIR = new URL("runtime/", ROOT);
export const RUNTIME_TARGET_DIR = new URL("harnesses/pi/src/runtime/", ROOT);

/**
 * Constants the extension needs, with the type each is declared as in the generated
 * file. Add here and they appear there. Values must be JSON (strings, or plain
 * objects of them).
 */
const EXPORTED: Record<string, string> = {
  TEAM_DIR: "string",
  LEGACY_TEAM_DIR: "string",
  PRE_CUTOFF_UPGRADE_MESSAGE: "string",
  DEFAULT_DAEMON_URL: "string",
  DEFAULT_TMUX_SESSION: "string",
  LEADER_WINDOW: "string",
  DEFAULT_HARNESS_TEMPLATES: "Record<string, { teammate: string; leader?: string }>",
};

/**
 * Render the generated module from the root module's values.
 *
 * Takes the imported module rather than its source text, so an object like the
 * harness templates is copied as its real value, not parsed out with a regex.
 * Exported so tests use this exact function rather than shelling out — a test that
 * reimplemented the rendering could disagree with the generator, which is the
 * failure mode this whole task exists to remove.
 */
export function render(shared: Record<string, unknown>): string {
  const values = Object.entries(EXPORTED).map(([name, type]) => {
    const value = shared[name];
    if (value === undefined) throw new Error(`shared/types.ts exports no "${name}"`);
    return [name, type, value] as const;
  });

  return `// GENERATED FILE — do not edit.
//
// Written by scripts/sync-shared.ts from the repo root's shared/types.ts, which is
// the single definition of these values. Edit them there and run
// \`npm run sync-shared\`; \`npm test\` fails if the two drift
// (docs/DESIGN.md "One Protocol, One Version", P1c-7).
//
// Generated rather than imported because the extension is a self-contained
// package: \`mpt setup\` writes it to a managed directory outside this repo, so a
// relative import into shared/ would not resolve there.

${values.map(([name, type, value]) => `export const ${name}: ${type} = ${JSON.stringify(value, null, 2)};`).join("\n")}
`;
}

/**
 * Render the extension's copy of shared/agent-protocol.ts: a generated-file banner,
 * then the source verbatim.
 *
 * Throws if the source imports anything: the copy lives where shared/ doesn't, so
 * an import would not resolve there (and runtime/client.ts relies on the copy
 * loading standalone under Node). Exported for the drift tests, like `render`.
 */
export function renderAgentProtocol(source: string): string {
  // A static import, a re-export (`export … from`), or a dynamic import().
  const imports = source.match(/^\s*(import\b.*|export\s.*\bfrom\s+["'].*)$/m) ?? source.match(/\bimport\s*\(.*/);
  if (imports) {
    throw new Error(`shared/agent-protocol.ts must be self-contained, but it imports: ${imports[0].trim()}`);
  }
  return `// GENERATED FILE — do not edit.
//
// Copied verbatim by scripts/sync-shared.ts from the repo root's
// shared/agent-protocol.ts, the single definition of the agent protocol. Edit it
// there and run \`npm run sync-shared\`; \`npm run check\` and the test suites fail
// if the two drift (docs/DESIGN.md "One Protocol, One Version").
//
// Copied rather than imported because the extension is a self-contained package:
// \`mpt setup\` writes it to a managed directory outside this repo.

${source}`;
}

/**
 * Relative specifiers a runtime/ module may import: a sibling (`./x.js` / `./x.ts`),
 * or the agent protocol by the one path that resolves in both places.
 */
const RUNTIME_ALLOWED_IMPORT = /^(\.\/[\w-]+\.(js|ts)|\.\.\/shared\/agent-protocol\.ts)$/;

/**
 * Render the extension's copy of one root runtime/ module: a generated-file
 * banner, then the source verbatim.
 *
 * Throws if the module imports anything other than a sibling or
 * `../shared/agent-protocol.ts` — any other path (an npm package, or another
 * root shared/ module) would not resolve, or would resolve to something
 * different, inside the extension. Exported for the drift tests, like `render`.
 */
export function renderRuntimeModule(name: string, source: string): string {
  const specifiers = [
    ...[...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]!),
    ...[...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!),
  ];
  const bad = specifiers.find((s) => !RUNTIME_ALLOWED_IMPORT.test(s));
  if (bad !== undefined) {
    throw new Error(`runtime/${name} may import only siblings and ../shared/agent-protocol.ts, but it imports: ${bad}`);
  }
  return `// GENERATED FILE — do not edit.
//
// Copied verbatim by scripts/sync-shared.ts from the repo root's runtime/${name},
// the single definition of this harness-agnostic module (agent/ and cli/ import
// it from there). Edit it there and run \`npm run sync-shared\`; \`npm run check\`
// and the test suites fail if the two drift.
//
// Copied rather than imported because the extension is a self-contained package:
// \`mpt setup\` writes it to a managed directory outside this repo.

${source}`;
}

/** The root runtime/ modules, by file name, sorted. */
function runtimeModuleNames(): string[] {
  return fs.readdirSync(RUNTIME_SOURCE_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name)
    .sort();
}

/** Every generated file: where it goes and what it must contain. */
export async function generatedFiles(): Promise<Array<{ target: URL; content: string }>> {
  return [
    { target: TARGET, content: render(await import(SOURCE.href)) },
    { target: PROTOCOL_TARGET, content: renderAgentProtocol(fs.readFileSync(PROTOCOL_SOURCE, "utf8")) },
    ...runtimeModuleNames().map((name) => ({
      target: new URL(name, RUNTIME_TARGET_DIR),
      content: renderRuntimeModule(name, fs.readFileSync(new URL(name, RUNTIME_SOURCE_DIR), "utf8")),
    })),
  ];
}

/**
 * Files in the extension's runtime/ copy with no root runtime/ source — left
 * behind when a module is removed or renamed at the root. The script deletes them
 * (or, with --check, reports them), so the copy never carries a module the root
 * no longer has.
 */
export function staleFiles(): URL[] {
  if (!fs.existsSync(RUNTIME_TARGET_DIR)) return [];
  const sources = new Set(runtimeModuleNames());
  return fs.readdirSync(RUNTIME_TARGET_DIR)
    .filter((name) => !sources.has(name))
    .sort()
    .map((name) => new URL(name, RUNTIME_TARGET_DIR));
}

/** A target's path relative to the repo root, for messages. */
function rel(url: URL): string {
  return url.href.slice(ROOT.href.length);
}

if (isMainModule(import.meta.url)) {
  const check = process.argv.slice(2).includes("--check");
  let stale = false;
  if (!check) fs.mkdirSync(RUNTIME_TARGET_DIR, { recursive: true });
  for (const { target, content } of await generatedFiles()) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (current === content) {
      console.log(`✓ ${rel(target)} is in step`);
    } else if (check) {
      console.error(`✗ ${rel(target)} is out of step with shared/\n  fix with: npm run sync-shared`);
      stale = true;
    } else {
      fs.writeFileSync(target, content);
      console.log(`✓ regenerated ${rel(target)}`);
    }
  }
  for (const target of staleFiles()) {
    if (check) {
      console.error(`✗ ${rel(target)} has no source in runtime/\n  fix with: npm run sync-shared`);
      stale = true;
    } else {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`✓ removed ${rel(target)}`);
    }
  }
  if (stale) process.exit(1);
}
