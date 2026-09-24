// Behavioral tests for shared-directory permission leases
// Run with: node --experimental-strip-types tests/permission-leases.test.mjs
//
// Every Pi agent in a directory shares one permission-system config file. The
// leader and pool teammates share the leader's directory, so each agent leases
// the directory and the config is composed from the live leases (see
// src/permissions.ts). These exercise real files in a temp dir.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DirectoryPermissions, prepareSpawnConfig, composeConfig } from "../src/permissions.ts";

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

const CONFIG = ".pi/extensions/pi-permission-system/config.json";
const LEASES = ".pi/extensions/pi-permission-system/ppt-leases.json";
/** A pid that's certainly not running. */
const DEAD_PID = 2 ** 22 + 12345;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppt-lease-")); }
function readConfig(dir) {
  const f = path.join(dir, CONFIG);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : null;
}
function writeConfig(dir, obj) {
  fs.mkdirSync(path.dirname(path.join(dir, CONFIG)), { recursive: true });
  fs.writeFileSync(path.join(dir, CONFIG), JSON.stringify(obj));
}
const lease = (dir, role, pid) => new DirectoryPermissions(dir, role, { reassertMs: 0, pid });

console.log("Permission leases:");

test("a lone teammate writes the permissive config, and removes it on release", () => {
  const dir = tmp();
  const t = lease(dir, "teammate");
  t.acquire(true);
  assert.strictEqual(readConfig(dir).yoloMode, true);
  assert.strictEqual(readConfig(dir).permission.external_directory, "allow");
  t.release();
  assert.strictEqual(readConfig(dir), null);
  assert.ok(!fs.existsSync(path.join(dir, LEASES)));
});

test("THE BUG: the leader leaving no longer deletes the teammates' config", () => {
  const dir = tmp();
  const leader = lease(dir, "leader");
  leader.acquire(false); // leader first, finds no config
  const t = lease(dir, "teammate");
  t.acquire(true);
  leader.release();
  assert.strictEqual(readConfig(dir)?.yoloMode, true);
  t.release();
  assert.strictEqual(readConfig(dir), null); // last one out restores "no file"
});

test("THE BUG: typing in the leader's pane no longer un-yolos autonomous teammates", () => {
  const dir = tmp();
  const leader = lease(dir, "leader");
  const t = lease(dir, "teammate");
  leader.acquire(true);
  t.acquire(true);
  leader.setYolo(false); // interactive input in the leader's pane
  assert.strictEqual(readConfig(dir).yoloMode, true);
});

test("one teammate pairing doesn't un-yolo an autonomous sibling; both pairing does", () => {
  const dir = tmp();
  const a = lease(dir, "teammate");
  const b = lease(dir, "teammate");
  a.acquire(true);
  b.acquire(true);
  a.setYolo(false);
  assert.strictEqual(readConfig(dir).yoloMode, true);
  b.setYolo(false);
  assert.strictEqual(readConfig(dir).yoloMode, false);
  assert.strictEqual(readConfig(dir).permission.external_directory, "ask"); // pairing rules
});

test("a leader-only directory keeps the user's rules and gets them back verbatim", () => {
  const dir = tmp();
  const userConfig = { permission: { bash: { "git push *": "ask" } }, debugLog: true };
  writeConfig(dir, userConfig);
  const raw = fs.readFileSync(path.join(dir, CONFIG), "utf-8");
  const leader = lease(dir, "leader");
  leader.acquire(true);
  const during = readConfig(dir);
  assert.strictEqual(during.yoloMode, true);
  assert.deepStrictEqual(during.permission, userConfig.permission); // merged, not replaced
  assert.ok(during.authorizerChain.includes("ppt-autonomous"));
  leader.release();
  assert.strictEqual(fs.readFileSync(path.join(dir, CONFIG), "utf-8"), raw);
});

test("dead leases are pruned (a crashed agent can't pin yolo on)", () => {
  const dir = tmp();
  const ghost = lease(dir, "teammate", DEAD_PID);
  ghost.acquire(true);
  const leader = lease(dir, "leader");
  leader.acquire(false);
  assert.strictEqual(readConfig(dir).yoloMode, false); // ghost pruned → leader-only
  assert.strictEqual(readConfig(dir).permission, undefined); // no teammate map
});

test("self-heal: re-asserting rewrites a config deleted underneath (demo reset)", () => {
  const dir = tmp();
  const t = new DirectoryPermissions(dir, "teammate", { reassertMs: 0 });
  t.acquire(true);
  fs.rmSync(path.join(dir, ".pi"), { recursive: true, force: true });
  t.setYolo(false); t.setYolo(true); // any sync re-asserts
  assert.strictEqual(readConfig(dir)?.yoloMode, true);
});

test("spawn-time config is recorded as ppt-authored (removed, not preserved, at the end)", () => {
  const dir = tmp();
  prepareSpawnConfig(dir);
  assert.strictEqual(readConfig(dir).yoloMode, true);
  const t = lease(dir, "teammate");
  t.acquire(true);
  t.release();
  assert.strictEqual(readConfig(dir), null);
});

test("spawn-time config leaves an existing config alone", () => {
  const dir = tmp();
  writeConfig(dir, { debugLog: true });
  prepareSpawnConfig(dir);
  assert.deepStrictEqual(readConfig(dir), { debugLog: true });
});

test("composeConfig: nothing live → restore (null)", () => {
  assert.strictEqual(composeConfig({ original: null, leases: {} }, []), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
