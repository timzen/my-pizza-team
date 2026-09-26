/**
 * tests/extension.test.ts — Locating and writing out the bundled Pi extension.
 *
 * `mpt setup` installs the extension by writing files rather than shelling out to
 * a package manager, which is only safe because of two facts established in
 * docs/BATTERIES_INCLUDED.md §7: the extension declares no runtime dependencies,
 * and Pi loads a local package from its path without copying. These tests cover
 * the mechanics; tests/version.test.ts guards the no-dependencies premise.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { existsSync } from "@std/fs";
import {
  EXTENSION_PAYLOAD,
  managedExtensionDir,
  readExtensionVersion,
  resolveExtensionSourceDir,
  writeExtension,
} from "../cli/extension.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix: `mpt-${prefix}-` });
}

/** A minimal stand-in for the bundled extension. */
function fakeSource(version = "1.2.3"): string {
  const dir = tempDir("ext-src");
  Deno.writeTextFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-pizza-team", version }));
  Deno.mkdirSync(path.join(dir, "src", "runtime"), { recursive: true });
  Deno.writeTextFileSync(path.join(dir, "src", "index.ts"), "// entry\n");
  Deno.writeTextFileSync(path.join(dir, "src", "runtime", "client.ts"), "// client\n");
  return dir;
}

Deno.test("the real extension is found from a checkout", () => {
  // The repo root is the cwd for `deno task test`, so the harnesses/pi candidate
  // should win — and it must be a real package, not just an existing directory.
  const found = resolveExtensionSourceDir();
  assertEquals(found !== null, true, "expected to resolve harnesses/pi from the checkout");
  assertEquals(existsSync(path.join(found!, "package.json")), true);
  assertEquals(existsSync(path.join(found!, "src", "index.ts")), true);
});

Deno.test("MPT_PI_EXTENSION overrides the search", () => {
  const src = fakeSource();
  const previous = Deno.env.get("MPT_PI_EXTENSION");
  try {
    Deno.env.set("MPT_PI_EXTENSION", src);
    assertEquals(resolveExtensionSourceDir(), src);
  } finally {
    if (previous === undefined) Deno.env.delete("MPT_PI_EXTENSION");
    else Deno.env.set("MPT_PI_EXTENSION", previous);
    Deno.removeSync(src, { recursive: true });
  }
});

Deno.test("an override pointing at a non-package is ignored, not trusted", () => {
  // Otherwise a stale env var would silently shadow the real extension.
  const empty = tempDir("ext-empty");
  const previous = Deno.env.get("MPT_PI_EXTENSION");
  try {
    Deno.env.set("MPT_PI_EXTENSION", empty);
    const found = resolveExtensionSourceDir();
    assertEquals(found === empty, false, "a directory without package.json must not resolve");
  } finally {
    if (previous === undefined) Deno.env.delete("MPT_PI_EXTENSION");
    else Deno.env.set("MPT_PI_EXTENSION", previous);
    Deno.removeSync(empty, { recursive: true });
  }
});

Deno.test("the managed directory is one stable path per machine", () => {
  // Per-team would mint a package identity per team, since Pi identifies a local
  // package by resolved absolute path — multiplying the double-load problem P2-4
  // exists to prevent.
  const home = tempDir("ext-home");
  const previous = Deno.env.get("MPT_HOME");
  try {
    Deno.env.set("MPT_HOME", home);
    const dir = managedExtensionDir();
    assertEquals(dir, path.join(home, ".my-pizza-team", "pi-extension"));
    assertEquals(managedExtensionDir(), dir, "must not vary between calls");
  } finally {
    if (previous === undefined) Deno.env.delete("MPT_HOME");
    else Deno.env.set("MPT_HOME", previous);
    Deno.removeSync(home, { recursive: true });
  }
});

Deno.test("writing produces a package Pi can load, and reports its version", () => {
  const src = fakeSource("0.17.2");
  const target = path.join(tempDir("ext-target"), "pi-extension");
  try {
    const { version } = writeExtension(src, target);
    assertEquals(version, "0.17.2");
    for (const item of EXTENSION_PAYLOAD) {
      assertEquals(existsSync(path.join(target, item)), true, `${item} should be written`);
    }
    // Nested files come along, not just the top level.
    assertEquals(existsSync(path.join(target, "src", "runtime", "client.ts")), true);
    assertStringIncludes(Deno.readTextFileSync(path.join(target, "src", "index.ts")), "entry");
  } finally {
    Deno.removeSync(src, { recursive: true });
    Deno.removeSync(path.dirname(target), { recursive: true });
  }
});

Deno.test("writing is idempotent and drops files a newer version removed", () => {
  // Merging would leave a deleted module on disk, and Pi would happily load it.
  const src = fakeSource();
  const target = path.join(tempDir("ext-target"), "pi-extension");
  try {
    writeExtension(src, target);
    const stale = path.join(target, "src", "removed-in-a-later-version.ts");
    Deno.writeTextFileSync(stale, "// should not survive\n");

    writeExtension(src, target);
    assertEquals(existsSync(stale), false, "a stale file must not survive a rewrite");
    assertEquals(existsSync(path.join(target, "src", "index.ts")), true);
  } finally {
    Deno.removeSync(src, { recursive: true });
    Deno.removeSync(path.dirname(target), { recursive: true });
  }
});

Deno.test("an incomplete source is refused before anything is replaced", () => {
  const src = fakeSource();
  Deno.removeSync(path.join(src, "src"), { recursive: true });
  const target = path.join(tempDir("ext-target"), "pi-extension");
  try {
    Deno.mkdirSync(target, { recursive: true });
    Deno.writeTextFileSync(path.join(target, "package.json"), JSON.stringify({ version: "0.1.0" }));

    assertThrows(() => writeExtension(src, target), Error, "missing src");
    // The previously-working install is still there.
    assertEquals(readExtensionVersion(target), "0.1.0");
  } finally {
    Deno.removeSync(src, { recursive: true });
    Deno.removeSync(path.dirname(target), { recursive: true });
  }
});

Deno.test("readExtensionVersion is null rather than throwing on junk", () => {
  const dir = tempDir("ext-junk");
  try {
    assertEquals(readExtensionVersion(dir), null, "no manifest");
    Deno.writeTextFileSync(path.join(dir, "package.json"), "{ not json");
    assertEquals(readExtensionVersion(dir), null, "unparseable manifest");
    Deno.writeTextFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    assertEquals(readExtensionVersion(dir), null, "manifest without a version");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
