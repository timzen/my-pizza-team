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

/**
 * Constants the extension needs, with the type each is declared as in the generated
 * file. Add here and they appear there. Values must be JSON (strings, or plain
 * objects of them).
 */
const EXPORTED: Record<string, string> = {
  TEAM_DIR: "string",
  LEGACY_TEAM_DIR: "string",
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

/** Every generated file: where it goes and what it must contain. */
export async function generatedFiles(): Promise<Array<{ target: URL; content: string }>> {
  return [
    { target: TARGET, content: render(await import(SOURCE.href)) },
    { target: PROTOCOL_TARGET, content: renderAgentProtocol(fs.readFileSync(PROTOCOL_SOURCE, "utf8")) },
  ];
}

/** A target's path relative to the repo root, for messages. */
function rel(url: URL): string {
  return url.href.slice(ROOT.href.length);
}

if (isMainModule(import.meta.url)) {
  const check = process.argv.slice(2).includes("--check");
  let stale = false;
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
  if (stale) process.exit(1);
}
