/**
 * tests/paths.test.ts — Finding mpt's own files from source and from the npm package.
 *
 * shared/paths.ts is what lets one asset lookup serve both a checkout
 * (`node cli/main.ts`) and the installed package (`.../my-pizza-team/dist/...`).
 * The source layout is this repo; the package layout is simulated by copying
 * paths.ts into a scratch `<root>/dist/shared/` beside a my-pizza-team manifest.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertEquals } from "./_assert.ts";
import { cliEntryScript, isRunningFromSource, packageRoot, piExtensionDir, uiDistDir } from "../shared/paths.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("from source, the package root is the checkout", () => {
  assertEquals(packageRoot(), REPO);
  assertEquals(isRunningFromSource(), true);
  assertEquals(cliEntryScript(), path.join(REPO, "cli", "main.ts"));
  assertEquals(uiDistDir(), path.join(REPO, "ui", "dist"));
  assertEquals(piExtensionDir(), path.join(REPO, "harnesses", "pi"));
  assertEquals(fs.existsSync(path.join(piExtensionDir(), "package.json")), true);
});

test("from the compiled package, the root is above dist/ and the entry is dist/main.js", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-paths-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "my-pizza-team", type: "module" }));
    // A package.json with another name on the way up must be walked past, as
    // harnesses/pi/ and ui/ are from source.
    fs.mkdirSync(path.join(root, "dist", "shared"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "package.json"), JSON.stringify({ name: "not-it", type: "module" }));
    const copy = path.join(root, "dist", "shared", "paths.ts");
    fs.copyFileSync(path.join(REPO, "shared", "paths.ts"), copy);

    const mod = await import(pathToFileURL(copy).href) as typeof import("../shared/paths.ts");
    const real = fs.realpathSync(root);
    assertEquals(fs.realpathSync(mod.packageRoot()), real);
    assertEquals(mod.isRunningFromSource(), false);
    assertEquals(mod.cliEntryScript(), path.join(mod.packageRoot(), "dist", "main.js"));
    assertEquals(mod.uiDistDir(), path.join(mod.packageRoot(), "ui", "dist"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
