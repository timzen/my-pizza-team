/**
 * tests/build-embeds.test.ts — every way of shipping `mpt` carries the Pi extension.
 *
 * `mpt setup` installs the extension by writing out the copy shipped with mpt, so a
 * build without it breaks setup for every user. The list of shipped files once lived
 * in three places, and when the extension was added the release copy was missed:
 * the next release would have shipped an mpt whose `mpt setup` fails with "the
 * bundled Pi extension could not be located".
 *
 * mpt ships as an npm package: package.json "files" is the one list, and the
 * release workflow smoke-tests the packed tarball before publishing. This guards
 * both.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["ui/dist/", "harnesses/pi/package.json", "harnesses/pi/src/"];

/** A file's text without comment lines, so prose *about* a command doesn't count. */
function code(file: string): string {
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
}

test("the npm package ships the UI and the Pi extension", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files: string[] = pkg.files ?? [];
  const missing = REQUIRED.filter((f) => !files.includes(f));
  assertEquals(missing, [], "a package without these ships an mpt whose `mpt setup` cannot work");
});

test("the release workflow smoke-tests the packed package before publishing it", () => {
  const release = code(path.join(ROOT, ".github/workflows/release.yml"));
  const pack = release.indexOf("npm pack");
  const check = release.indexOf("write the bundled Pi extension");
  const publish = release.indexOf("npm publish");
  assertEquals(pack >= 0 && check > pack && publish > check, true,
    "expected `npm pack`, then the `mpt setup --dry-run` extension check, then `npm publish`");
});

test("no packaged module imports a package.json (tsc would copy it into dist/)", () => {
  // A JSON import makes tsc emit dist/package.json, named my-pizza-team, which
  // shared/paths.ts packageRoot() would take for the package root — and every asset
  // lookup (ui/dist, the Pi extension) would then miss. Use packageVersion() instead.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (rel.endsWith(".ts") && /from\s+["'][^"']*package\.json["']/.test(code(path.join(ROOT, rel)))) offenders.push(rel);
    }
  };
  for (const dir of ["agent", "cli", "daemon", "shared"]) walk(dir);
  if (/from\s+["'][^"']*package\.json["']/.test(code(path.join(ROOT, "main.ts")))) offenders.push("main.ts");
  assertEquals(offenders, []);
});
