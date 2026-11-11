// Behavioral tests: the teammate flag and its deprecated alias
// Run with: node --experimental-strip-types tests/teammate-flag.test.mjs
//
// `--ppt-teammate` starts a teammate; the old `--ppt-worker` still does (so a
// team's customized spawn template keeps working), with a deprecation warning
// shown once per run — DEPRECATED(worker→teammate): remove in
// remove-worker-aliases. See src/teammate-flag.ts and src/index.ts.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  LEGACY_TEAMMATE_FLAG_WARNING, readTeammateFlag, registerTeammateFlags,
} from "../src/teammate-flag.ts";

let passed = 0;
let failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}: ${e.message}`); failed++; }
}

/** A fake Pi whose flags are `values` (registered flags default to false). */
function fakePi(values = {}) {
  const registered = {};
  return {
    registered,
    registerFlag: (name, opts) => { registered[name] = opts; },
    getFlag: (name) => (name in values ? values[name] : registered[name]?.default),
  };
}

console.log("Teammate flag:");

test("registers --ppt-teammate and the deprecated --ppt-worker, both boolean, default off", () => {
  const pi = fakePi();
  registerTeammateFlags(pi);
  assert.deepStrictEqual(Object.keys(pi.registered).sort(), ["ppt-teammate", "ppt-worker"]);
  for (const opts of Object.values(pi.registered)) assert.deepStrictEqual([opts.type, opts.default], ["boolean", false]);
  assert.ok(pi.registered["ppt-worker"].description.includes("--ppt-teammate"));
});

test("no flag → not a teammate, no warning", () => {
  const pi = fakePi();
  registerTeammateFlags(pi);
  assert.deepStrictEqual(readTeammateFlag(pi), { teammate: false, deprecation: null });
});

test("--ppt-teammate → a teammate, no warning", () => {
  assert.deepStrictEqual(readTeammateFlag(fakePi({ "ppt-teammate": true })), { teammate: true, deprecation: null });
  assert.deepStrictEqual(readTeammateFlag(fakePi({ "ppt-teammate": true, "ppt-worker": true })), { teammate: true, deprecation: null });
});

test("--ppt-worker still starts a teammate, warning once per run", () => {
  const first = readTeammateFlag(fakePi({ "ppt-worker": true }));
  assert.deepStrictEqual(first, { teammate: true, deprecation: LEGACY_TEAMMATE_FLAG_WARNING });
  assert.strictEqual(LEGACY_TEAMMATE_FLAG_WARNING, "[ppt] '--ppt-worker' is deprecated; use '--ppt-teammate'");
  assert.deepStrictEqual(readTeammateFlag(fakePi({ "ppt-worker": true })), { teammate: true, deprecation: null });
});

test("index.ts starts the teammate role from readTeammateFlag and shows the deprecation", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf-8");
  assert.ok(src.includes("registerTeammateFlags(pi)"));
  assert.ok(src.includes("readTeammateFlag(pi)"));
  assert.ok(src.includes("if (isTeammate) {"));
  assert.ok(src.includes('ctx.ui.notify(deprecation, "warning")'));
  assert.ok(!src.includes('getFlag("ppt-worker")'), "the alias is read in teammate-flag.ts only");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
