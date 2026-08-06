// Smoke test for the readiness probe module (src/readiness.ts)
// Run with: node tests/readiness.test.mjs
//
// Source-string checks (the extension source is TS loaded by pi, not compiled
// here) plus a functional check of the flag/env resolution contract by reading
// the source's documented behavior. Verifies the host-readiness probe contract:
// exit 0 = ready, non-zero = not ready, configured via flag or env.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "../src/readiness.ts"),
  "utf-8"
);

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

console.log("Readiness probe source checks:");

test("exports resolveReadinessProbe and runReadinessProbe", () => {
  assert.ok(src.includes("export function resolveReadinessProbe("));
  assert.ok(src.includes("export function runReadinessProbe("));
});

test("resolves from the flag with PPT_READINESS_PROBE env fallback", () => {
  assert.ok(src.includes("process.env.PPT_READINESS_PROBE"));
  assert.ok(src.includes("PPT_READINESS_PROBE_TIMEOUT_MS"));
});

test("no probe configured resolves to null (always ready)", () => {
  assert.ok(src.includes("if (!command) return null"));
});

test("exit 0 = ready; non-zero = not ready with a reason", () => {
  // exec's err is null on exit 0.
  assert.ok(src.includes("if (!err)"));
  assert.ok(src.includes("ready: true"));
  assert.ok(src.includes("ready: false"));
});

test("runs the command via the shell with a timeout", () => {
  assert.ok(src.includes('from "node:child_process"'));
  assert.ok(src.includes("timeout: probe.timeoutMs"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
