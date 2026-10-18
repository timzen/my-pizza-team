/**
 * tests/build-embeds.test.ts — every way of shipping `mpt` carries the Pi extension.
 *
 * `mpt setup` installs the extension by writing out the copy shipped with mpt, so a
 * build without it breaks setup for every user. The list of shipped files once lived
 * in three places — deno.json's compile task, scripts/build.sh, and an inline
 * `deno compile` in the release workflow — and when the extension was added, the
 * release copy was missed: the next release would have shipped a binary whose
 * `mpt setup` fails with "the bundled Pi extension could not be located".
 *
 * mpt now ships as an npm package: package.json "files" is the one list, and the
 * release workflow smoke-tests the packed tarball before publishing. This guards
 * both, plus any `deno compile` left behind until Deno is removed.
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

function candidateFiles(): string[] {
  const files = [path.join(ROOT, "deno.json")].filter((f) => fs.existsSync(f));
  for (const dir of ["scripts", ".github/workflows"]) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isFile()) files.push(path.join(ROOT, dir, entry.name));
    }
  }
  return files;
}

test("the npm package ships the UI and the Pi extension", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files: string[] = pkg.files ?? [];
  const missing = REQUIRED.filter((f) => !files.includes(f));
  assertEquals(missing, [], "a package without these ships an mpt whose `mpt setup` cannot work");
});

test("any remaining `deno compile` embeds the UI and the Pi extension", () => {
  const missing: string[] = [];
  for (const file of candidateFiles().filter((f) => code(f).includes("deno compile"))) {
    const text = code(file);
    for (const include of REQUIRED) {
      if (!text.includes(`--include ${include}`)) missing.push(`${path.relative(ROOT, file)} lacks --include ${include}`);
    }
  }
  assertEquals(missing, []);
});

test("the release workflow smoke-tests the packed package before publishing it", () => {
  const release = code(path.join(ROOT, ".github/workflows/release.yml"));
  assertEquals(release.includes("deno"), false, "release.yml should have no Deno steps");
  const pack = release.indexOf("npm pack");
  const check = release.indexOf("write the bundled Pi extension");
  const publish = release.indexOf("npm publish");
  assertEquals(pack >= 0 && check > pack && publish > check, true,
    "expected `npm pack`, then the `mpt setup --dry-run` extension check, then `npm publish`");
});
