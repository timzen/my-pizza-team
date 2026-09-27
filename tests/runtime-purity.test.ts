/**
 * tests/runtime-purity.test.ts — harnesses/pi/src/runtime/ stays harness-agnostic.
 *
 * `runtime/` holds the modules that implement the daemon *protocol* rather than
 * anything about Pi: the HTTP client, the transcript mirror, bubble splitting,
 * pairing, and usage summarisation. Nothing in it may import Pi, a dependency, or
 * a runtime builtin.
 *
 * Two reasons this is worth enforcing rather than trusting:
 *
 *   1. **It keeps the seam honest.** The split between "protocol" and "what only
 *      Pi can do" is the boundary docs/DESIGN.md "The Daemon Is the Supervisor" rests on. Left
 *      unchecked, a single convenient import quietly erases it.
 *   2. **It keeps these modules testable.** They load standalone under Node's type
 *      stripping *because* they have no relative value imports — Node resolves
 *      './x.js' literally, while only Pi's loader remaps it to './x.ts'. A
 *      type-only import is erased; a value import is not. That is how adding one
 *      import to client.ts broke the behavioural suite during P1b, and why
 *      tests/../client-behavior.test.mjs can exercise real HTTP at all.
 *
 * P1c-9. Note this is narrower than the plan first described: there is no
 * top-level `agent-runtime/` shared between harnesses, because no second harness
 * would import it — DESIGN.md "The Daemon Is the Supervisor" moves the supervisor into the daemon precisely so a
 * non-Pi teammate needs no in-process code.
 */

import { assertEquals } from "@std/assert";

const RUNTIME_DIR = new URL("../harnesses/pi/src/runtime/", import.meta.url);

/** Every `import ... from "<specifier>"`, with whether it was type-only. */
function imports(source: string): Array<{ specifier: string; typeOnly: boolean }> {
  const out: Array<{ specifier: string; typeOnly: boolean }> = [];
  for (const m of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
    out.push({ specifier: m[2]!, typeOnly: Boolean(m[1]) });
  }
  // Dynamic imports are runtime imports too.
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push({ specifier: m[1]!, typeOnly: false });
  }
  return out;
}

async function runtimeModules(): Promise<Array<{ name: string; source: string }>> {
  const files: Array<{ name: string; source: string }> = [];
  for await (const entry of Deno.readDir(RUNTIME_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push({ name: entry.name, source: await Deno.readTextFile(new URL(entry.name, RUNTIME_DIR)) });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

Deno.test("runtime/ is populated (a passing check on an empty directory proves nothing)", async () => {
  const modules = await runtimeModules();
  assertEquals(modules.length >= 5, true, `expected the runtime modules, found ${modules.length}`);
});

Deno.test("runtime/ imports no dependency and no runtime builtin", async () => {
  const offenders: string[] = [];
  for (const { name, source } of await runtimeModules()) {
    for (const { specifier } of imports(source)) {
      const isRelative = specifier.startsWith(".");
      if (!isRelative) offenders.push(`${name} → ${specifier}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "runtime/ must import nothing external — no Pi, no npm package, no node:/jsr: builtin.\n" +
      `  offenders: ${offenders.join(", ")}`,
  );
});

Deno.test("runtime/ has no relative *value* imports — only type-only ones", async () => {
  // This is the property that keeps these modules loadable under plain Node, and
  // therefore testable. A type-only import is erased at runtime; a value import
  // makes Node resolve a './x.js' path that does not exist on disk.
  const offenders: string[] = [];
  for (const { name, source } of await runtimeModules()) {
    for (const { specifier, typeOnly } of imports(source)) {
      if (specifier.startsWith(".") && !typeOnly) offenders.push(`${name} → ${specifier}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "a relative value import breaks standalone loading under Node's type stripping " +
      "(only Pi's loader remaps .js → .ts), which is what makes runtime/ testable.\n" +
      `  offenders: ${offenders.join(", ")}`,
  );
});

Deno.test("runtime/ never mentions the Pi extension API", async () => {
  // Cheap belt-and-braces: a Pi type arriving via some path the import scan misses
  // would still show up as this identifier.
  const offenders: string[] = [];
  for (const { name, source } of await runtimeModules()) {
    if (source.includes("ExtensionAPI") || source.includes("pi-coding-agent")) offenders.push(name);
  }
  assertEquals(offenders, [], `runtime/ must not reference Pi: ${offenders.join(", ")}`);
});
