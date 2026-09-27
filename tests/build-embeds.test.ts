/**
 * tests/build-embeds.test.ts — every way of building `mpt` embeds the Pi extension.
 *
 * `mpt setup` installs the extension by writing out the copy carried inside the
 * binary, so a binary built without it breaks setup for every user. The list of
 * embedded files once lived in three places — deno.json's compile task,
 * scripts/build.sh, and an inline `deno compile` in the release workflow — and when the
 * extension was added, the release copy was missed. The next release would have shipped
 * a binary whose `mpt setup` fails with "the bundled Pi extension could not be located".
 *
 * The release now builds through scripts/build.sh. This guards the places that remain,
 * and any new one: any file that runs `deno compile` must embed the extension.
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const REQUIRED = ["ui/dist/", "harnesses/pi/package.json", "harnesses/pi/src/"];

/** A file's text without comment lines, so prose *about* `deno compile` doesn't count. */
function code(file: string): string {
  return Deno.readTextFileSync(file)
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
}

function candidateFiles(): string[] {
  const files = [path.join(ROOT, "deno.json")];
  for (const dir of ["scripts", ".github/workflows"]) {
    for (const entry of Deno.readDirSync(path.join(ROOT, dir))) {
      if (entry.isFile) files.push(path.join(ROOT, dir, entry.name));
    }
  }
  return files;
}

Deno.test("every file that runs `deno compile` embeds the UI and the Pi extension", () => {
  const compilers = candidateFiles().filter((f) => code(f).includes("deno compile"));
  assertEquals(compilers.length >= 2, true, `expected deno.json and build.sh at least; found ${compilers.join(", ")}`);

  const missing: string[] = [];
  for (const file of compilers) {
    const text = code(file);
    for (const include of REQUIRED) {
      if (!text.includes(`--include ${include}`)) missing.push(`${path.relative(ROOT, file)} lacks --include ${include}`);
    }
  }
  assertEquals(missing, [], "a build that omits these ships a binary whose `mpt setup` cannot work");
});

Deno.test("the release workflow builds through scripts/build.sh, not its own compile", () => {
  // One definition of what goes into the binary. A second copy is how the bug happened.
  const release = code(path.join(ROOT, ".github/workflows/release.yml"));
  assertEquals(release.includes("deno compile"), false, "release.yml should not carry its own deno compile");
  assertEquals(release.includes("./scripts/build.sh"), true);
});
