/**
 * tests/version.test.ts — The daemon and the Pi extension carry one version.
 *
 * Before the monorepo merge these shipped separately and drifted (daemon 0.17.2,
 * extension 0.2.0) with nothing noticing — the failure mode BATTERIES_INCLUDED.md
 * §1.2 describes. `deno.json` is now the single source and
 * `harnesses/pi/package.json` is a generated copy (scripts/sync-version.ts); this
 * test is what makes "generated" enforceable rather than aspirational.
 */

import { assertEquals, assertMatch } from "@std/assert";

const root = new URL("../", import.meta.url);
const read = async (p: string) => JSON.parse(await Deno.readTextFile(new URL(p, root)));

Deno.test("the extension manifest matches deno.json's version", async () => {
  const { version: daemonVersion } = await read("deno.json");
  const { version: extVersion } = await read("harnesses/pi/package.json");

  assertMatch(daemonVersion, /^\d+\.\d+\.\d+$/, "deno.json version should be semver");
  assertEquals(
    extVersion,
    daemonVersion,
    "harnesses/pi/package.json is out of step — run `deno task sync-version`",
  );
});

Deno.test("the extension declares no runtime dependencies", async () => {
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
