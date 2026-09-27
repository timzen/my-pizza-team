#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * scripts/sync-shared.ts — Generate the Pi extension's shared constants.
 *
 * The daemon and the extension need the same handful of values (team directory
 * names, the default daemon URL). Two hand-maintained copies is exactly the
 * duplication docs/DESIGN.md "One Protocol, One Version" warns about, and the copies had already
 * drifted: the extension declared `WorkflowConfig.states` as `string[]` while the
 * daemon had moved to `WorkflowState[]`.
 *
 * Importing the root `shared/` directly isn't an option: the extension is a
 * self-contained package that `mpt setup` writes to a managed directory outside
 * this repo (P2-3), so a relative import would escape it. Generating keeps one
 * source of truth *and* a self-contained package.
 *
 *   deno task sync-shared          # write
 *   deno task sync-shared --check  # verify only; non-zero exit on drift
 */

const ROOT = new URL("../", import.meta.url);
export const SOURCE = new URL("shared/types.ts", ROOT);
export const TARGET = new URL("harnesses/pi/src/shared/types.ts", ROOT);

/** Constants the extension needs. Add here and they appear in the generated file. */
const EXPORTED = ["TEAM_DIR", "LEGACY_TEAM_DIR", "DEFAULT_DAEMON_URL"] as const;

/**
 * Render the generated module from the root's source text.
 *
 * Exported so tests use this exact function rather than shelling out — a test that
 * reimplemented the rendering could disagree with the generator, which is the
 * failure mode this whole task exists to remove.
 */
export function render(source: string): string {
  const values = EXPORTED.map((name) => {
    const m = source.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`));
    if (!m) throw new Error(`shared/types.ts has no string constant "${name}"`);
    return [name, m[1]!] as const;
  });

  return `// GENERATED FILE — do not edit.
//
// Written by scripts/sync-shared.ts from the repo root's shared/types.ts, which is
// the single definition of these values. Edit them there and run
// \`deno task sync-shared\`; \`deno task test\` fails if the two drift
// (docs/DESIGN.md "One Protocol, One Version", P1c-7).
//
// Generated rather than imported because the extension is a self-contained
// package: \`mpt setup\` writes it to a managed directory outside this repo, so a
// relative import into shared/ would not resolve there.

${values.map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join("\n")}
`;
}

if (import.meta.main) {
  const generated = render(await Deno.readTextFile(SOURCE));
  const current = await Deno.readTextFile(TARGET).catch(() => "");

  if (current === generated) {
    console.log(`✓ harnesses/pi/src/shared/types.ts is in step (${EXPORTED.length} constants)`);
  } else if (Deno.args.includes("--check")) {
    console.error(
      "✗ harnesses/pi/src/shared/types.ts is out of step with shared/types.ts\n" +
        "  fix with: deno task sync-shared",
    );
    Deno.exit(1);
  } else {
    await Deno.writeTextFile(TARGET, generated);
    console.log(`✓ regenerated harnesses/pi/src/shared/types.ts (${EXPORTED.length} constants)`);
  }
}
