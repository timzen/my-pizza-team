/**
 * shared/paths.ts — Where mpt's own files are: the package root, the UI build, the
 * bundled Pi extension, and the CLI entry script.
 *
 * mpt runs two ways, and every asset lookup must work in both:
 *
 *   - **From source** — `node cli/main.ts` in a checkout. Node strips the types
 *     itself; this module is `<root>/shared/paths.ts`.
 *   - **From the npm package** — `npm i -g my-pizza-team`, which ships compiled JS
 *     (Node won't type-strip under node_modules). This module is
 *     `<root>/dist/shared/paths.js`, with `<root>` being e.g.
 *     `<prefix>/lib/node_modules/my-pizza-team`.
 *
 * Either way the assets sit at the same place relative to the package root —
 * `ui/dist/`, `harnesses/pi/` — so the one thing to find is that root.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The `name` in the root package.json; how the walk below knows it has arrived. */
const PACKAGE_NAME = "my-pizza-team";

/** This module's own file. */
const HERE_FILE = fileURLToPath(import.meta.url);

let cachedRoot: string | undefined;

/**
 * The package root: the nearest directory above this module whose package.json is
 * named my-pizza-team. Matching the name rather than taking the first package.json
 * matters from source, where harnesses/pi/ and ui/ have package.jsons of their own.
 *
 * Throws if there is none — the code was copied out of its package, and every
 * asset lookup would fail anyway.
 */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(HERE_FILE);
  for (;;) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (manifest?.name === PACKAGE_NAME) return (cachedRoot = dir);
    } catch { /* no (readable) package.json here; keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot find the ${PACKAGE_NAME} package root above ${HERE_FILE}`);
    dir = parent;
  }
}

/**
 * Running the `.ts` sources rather than the compiled package?
 *
 * The rule: compiled iff this module lives under `<packageRoot>/dist/` (the
 * tsconfig.build.json output, which is what the npm package runs). A checkout
 * that happens to have a built dist/ still counts as source when started as
 * `node cli/main.ts`, because then this module is `<root>/shared/paths.ts`.
 */
export function isRunningFromSource(): boolean {
  const rel = path.relative(path.join(packageRoot(), "dist"), HERE_FILE);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/**
 * The script that runs the mpt CLI with plain `node <script>`: `<root>/cli/main.ts`
 * from source, the package's bin `<root>/dist/main.js` when compiled.
 */
export function cliEntryScript(): string {
  const root = packageRoot();
  return isRunningFromSource() ? path.join(root, "cli", "main.ts") : path.join(root, "dist", "main.js");
}

/** The built web UI, `<root>/ui/dist` (it may not exist in a checkout that never ran `npm run build`). */
export function uiDistDir(): string {
  return path.join(packageRoot(), "ui", "dist");
}

/** The bundled Pi extension's source, `<root>/harnesses/pi` (manifest + src/). */
export function piExtensionDir(): string {
  return path.join(packageRoot(), "harnesses", "pi");
}
