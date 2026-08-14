// Smoke test for the permission-system integration (permissions.ts)
// Run with: node tests/permissions.test.mjs
//
// Verifies the autonomous permission model: dynamic yoloMode toggling plus
// the ppt-autonomous authorizer chain link that auto-allows fail-closed asks
// (e.g. pi-permission-system v24's bash indirection-wrapper floor, which
// clamps even yolo-rewritten allows back to `ask` for timeout/nohup/sudo/...).

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "../src/permissions.ts"),
  "utf-8"
);
const indexSrc = fs.readFileSync(
  path.join(import.meta.dirname, "../src/index.ts"),
  "utf-8"
);
const leaderSrc = fs.readFileSync(
  path.join(import.meta.dirname, "../src/leader.ts"),
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

console.log("Permission-system integration:");

// ─── yoloMode toggling (existing model) ──────────────────────────

test("writes yoloMode true when autonomous, false when pairing", () => {
  assert.ok(src.includes("yoloMode: true"));
  assert.ok(src.includes("yoloMode: false"));
});

// ─── Authorizer chain link ───────────────────────────────────────

test("exports the ppt-autonomous link name", () => {
  assert.ok(src.includes('AUTONOMOUS_AUTHORIZER = "ppt-autonomous"'));
});

test("resolves the service via the Symbol.for globalThis slot (no hard dependency)", () => {
  assert.ok(src.includes('Symbol.for("@gotgenes/pi-permission-system:service")'));
  // Graceful degradation when the permission system isn't installed.
  assert.ok(src.includes("if (!service?.registerAuthorizer) return"));
});

test("link allows when autonomous and defers when pairing", () => {
  const authorize = src.slice(src.indexOf("service.registerAuthorizer"));
  const allowIdx = authorize.indexOf('{ kind: "allow" }');
  const deferIdx = authorize.indexOf('{ kind: "defer" }');
  assert.ok(allowIdx > -1 && deferIdx > -1 && allowIdx < deferIdx);
  assert.ok(authorize.includes("getIsAutonomous()"));
});

test("link writes a review-log audit entry on auto-allow", () => {
  assert.ok(src.includes('"ppt.autonomous_auto_allow"'));
});

test("re-registers on permissions:ready (survives /reload) and tries immediately", () => {
  assert.ok(src.includes('"permissions:ready"'));
  // An immediate attempt outside the event handler.
  assert.ok(src.match(/permissions:ready", register\);\s*\n\s*register\(\)/));
});

// ─── Config activation ───────────────────────────────────────────

test("both config variants name the link in authorizerChain", () => {
  const matches = src.match(/authorizerChain: \[AUTONOMOUS_AUTHORIZER\]/g) || [];
  assert.strictEqual(matches.length, 2, `expected 2 authorizerChain entries, got ${matches.length}`);
});

test("leader's spawn-time config also names the link", () => {
  assert.ok(leaderSrc.includes('authorizerChain: ["ppt-autonomous"]'));
});

test("teammate setup registers the authorizer wired to loop autonomy", () => {
  assert.ok(indexSrc.includes("registerAutonomousAuthorizer(pi, () => loop.isAutonomous)"));
});


// ─── Chat agent (leader) ─────────────────────────────────────────
//
// The leader answers the chat, so a web-driven run has nobody at the terminal to
// answer a permission prompt — an `ask` hangs the conversation invisibly.

test("registerChatAgentPermissions keys off who drove the run", () => {
  assert.ok(src.includes("export function registerChatAgentPermissions"));
  // interactive = human present (their rules); anything else = remote (yolo).
  assert.ok(src.includes('apply(event.source !== "interactive")'));
});

test("chat agent yolo only flips yoloMode + the chain link (never authors a permission map)", () => {
  const fn = src.slice(src.indexOf("export function setYoloMode"), src.length);
  assert.ok(fn.includes("config.yoloMode = yolo"));
  assert.ok(fn.includes("AUTONOMOUS_AUTHORIZER"));
  // The leader runs in the user's real project: don't stomp their rules.
  assert.ok(!fn.includes('"rm -rf *"'));
  assert.ok(!fn.includes('permission:'));
  assert.ok(fn.includes("JSON.parse(raw)"), "must merge into the existing config");
});

test("chat agent restores the config file on shutdown", () => {
  // Otherwise a plain `pi` in that directory later would silently be in yolo.
  assert.ok(src.includes("const original = readFileOrNull(configPath)"));
  assert.ok(src.includes('pi.on("session_shutdown"'));
  assert.ok(src.includes("fs.rmSync(configPath, { force: true })"));
});

test("leader wires the chat-agent permissions and the authorizer link", () => {
  const leaderSrc = fs.readFileSync(path.join(import.meta.dirname, "../src/leader.ts"), "utf-8");
  assert.ok(leaderSrc.includes("registerChatAgentPermissions(pi, cwd)"));
  assert.ok(leaderSrc.includes("registerAutonomousAuthorizer(pi, chatPermissions.isRemoteDriven)"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
