/**
 * tests/version.test.ts — The daemon and the Pi extension carry one version.
 *
 * Before the monorepo merge these shipped separately and drifted (daemon 0.17.2,
 * extension 0.2.0) with nothing noticing — the failure mode docs/DESIGN.md
 * DESIGN.md "One Protocol, One Version" describes. `deno.json` is now the single source and
 * `harnesses/pi/package.json` is a generated copy (scripts/sync-version.ts); this
 * test is what makes "generated" enforceable rather than aspirational.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assertEquals, assertMatch } from "./_assert.ts";

const root = new URL("../", import.meta.url);
const read = async (p: string) => JSON.parse(await fs.promises.readFile(new URL(p, root), "utf8"));

test("the extension manifest matches deno.json's version", async () => {
  const { version: daemonVersion } = await read("deno.json");
  const { version: extVersion } = await read("harnesses/pi/package.json");

  assertMatch(daemonVersion, /^\d+\.\d+\.\d+$/, "deno.json version should be semver");
  assertEquals(
    extVersion,
    daemonVersion,
    "harnesses/pi/package.json is out of step — run `deno task sync-version`",
  );
});

test("the root npm package and its lockfile match deno.json's version", async () => {
  // The Node build (package.json / package-lock.json) is another generated copy.
  const { version } = await read("deno.json");
  const pkg = await read("package.json");
  const lock = await read("package-lock.json");
  const fix = "out of step — run `deno task sync-version`";
  assertEquals(pkg.version, version, `package.json is ${fix}`);
  assertEquals(lock.version, version, `package-lock.json is ${fix}`);
  assertEquals(lock.packages?.[""]?.version, version, `package-lock.json packages[""] is ${fix}`);
});

test("the extension's generated shared constants are in step", async () => {
  // harnesses/pi/src/shared/types.ts is generated from shared/types.ts. Using the
  // generator's own `render()` rather than reimplementing it here is the point: a
  // test that rendered independently could disagree with the generator, which is
  // the drift this task exists to remove.
  const { render, SOURCE, TARGET } = await import("../scripts/sync-shared.ts");
  const expected = render(await import(SOURCE.href));
  assertEquals(
    await fs.promises.readFile(TARGET, "utf8"),
    expected,
    "harnesses/pi/src/shared/types.ts is stale — run `deno task sync-shared`",
  );
});

test("the extension declares no runtime dependencies", async () => {
  // P2-1 embeds the extension in the binary and writes it out at setup time with
  // no `npm install` step. That only works while Pi supplies everything the
  // extension imports, so a real `dependencies` entry would silently break setup.
  const pkg = await read("harnesses/pi/package.json");
  assertEquals(
    Object.keys(pkg.dependencies ?? {}),
    [],
    "a runtime dependency would break `mpt setup`'s install-free extension write (P2-1)",
  );
});
