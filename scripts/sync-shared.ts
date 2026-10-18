#!/usr/bin/env node
/**
 * scripts/sync-shared.ts — Generate the Pi extension's shared constants.
 *
 * The daemon and the extension need the same handful of values (team directory
 * names, the default daemon URL, the default tmux session, and the built-in harness
 * templates the leader falls back to when it realizes spawns itself). Two hand-maintained copies is exactly the
 * duplication docs/DESIGN.md "One Protocol, One Version" warns about, and the copies had already
 * drifted: the extension declared `WorkflowConfig.states` as `string[]` while the
 * daemon had moved to `WorkflowState[]`.
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

if (isMainModule(import.meta.url)) {
  const generated = render(await import(SOURCE.href));
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : "";

  if (current === generated) {
    console.log(`✓ harnesses/pi/src/shared/types.ts is in step (${Object.keys(EXPORTED).length} constants)`);
  } else if (process.argv.slice(2).includes("--check")) {
    console.error(
      "✗ harnesses/pi/src/shared/types.ts is out of step with shared/types.ts\n" +
        "  fix with: npm run sync-shared",
    );
    process.exit(1);
  } else {
    fs.writeFileSync(TARGET, generated);
    console.log(`✓ regenerated harnesses/pi/src/shared/types.ts (${Object.keys(EXPORTED).length} constants)`);
  }
}
