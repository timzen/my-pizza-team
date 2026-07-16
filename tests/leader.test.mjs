// Smoke test for leader role
// Run with: node tests/leader.test.mjs
//
// Verifies the leader source implements spawn polling, multi-harness
// tmux management, and proper daemon API integration.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
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

console.log("Leader role source checks:");

// ─── Exports and structure ───────────────────────────────────────

test("exports setupLeader function", () => {
  assert.ok(src.includes("export async function setupLeader("));
});

test("imports DaemonClient", () => {
  assert.ok(src.includes('import type { DaemonClient }'));
});

test("imports registerLeaderTools", () => {
  assert.ok(src.includes('import { registerLeaderTools }'));
});

// ─── Daemon registration ─────────────────────────────────────────

test("registers with daemon on startup", () => {
  assert.ok(src.includes('client.register({ name: "leader", capabilities: { directory: cwd } })'));
});

test("deregisters on session_shutdown", () => {
  assert.ok(src.includes("client.deregister()"));
});

test("gets host config from daemon", () => {
  assert.ok(src.includes("client.getHostConfig()"));
});

test("gets daemon config for harness templates", () => {
  assert.ok(src.includes("client.getConfig()"));
});

// ─── Spawn request polling ───────────────────────────────────────

test("polls the single leader-directive queue every 5s", () => {
  assert.ok(src.includes("SPAWN_POLL_INTERVAL_MS = 5000"));
  assert.ok(src.includes("client.getLeaderDirectives()"));
});

test("completes directives after realizing them", () => {
  assert.ok(src.includes("client.completeLeaderDirective(directive.id)"));
  assert.ok(src.includes("dispatchDirective("));
});

test("generates unique names for spawned agents", () => {
  assert.ok(src.includes("generateName(activeNames)"));
});

// ─── Multi-harness support ───────────────────────────────────────

test("has default harness templates for pi, claude-code, codex", () => {
  assert.ok(src.includes('"pi"'));
  assert.ok(src.includes('"claude-code"'));
  assert.ok(src.includes('codex:'));
});

test("pi template uses --ppt-worker --ppt-daemon --ppt-name", () => {
  assert.ok(src.includes("pi --ppt-worker --ppt-daemon={url} --ppt-name={name}"));
});

test("claude-code template uses mpt-claude-runner", () => {
  assert.ok(src.includes("mpt-claude-runner --name={name} --daemon={url} --cwd={cwd}"));
});

test("codex template uses mpt-codex-runner", () => {
  assert.ok(src.includes("mpt-codex-runner --name={name} --daemon={url} --cwd={cwd}"));
});

test("spawnAgent resolves template placeholders", () => {
  assert.ok(src.includes(".replace(/\\{name\\}/g,"));
  assert.ok(src.includes(".replace(/\\{url\\}/g,"));
  assert.ok(src.includes(".replace(/\\{cwd\\}/g,"));
  assert.ok(src.includes(".replace(/\\{workArgs\\}/g,"));
});

test("spawn directive with storyId spawns an assigned-story teammate", () => {
  assert.ok(src.includes("--ppt-work-mode=assigned-story --ppt-story="));
  assert.ok(src.includes("storyId: params.storyId"));
});

test("loads custom harness templates from daemon config", () => {
  assert.ok(src.includes("daemonConfig.harnessCommands"));
});

// ─── tmux management ─────────────────────────────────────────────

test("has ensureSession function", () => {
  assert.ok(src.includes("function ensureSession("));
});

test("has spawnAgent function", () => {
  assert.ok(src.includes("function spawnAgent("));
});

test("has dismissAgent function", () => {
  assert.ok(src.includes("function dismissAgent("));
});

test("has listWindows function", () => {
  assert.ok(src.includes("function listWindows("));
});

test("spawnAgent skips creating a window when one with the name already exists", () => {
  // Guards against retried spawn directives piling up duplicate tmux windows,
  // since tmux does not enforce unique window names.
  assert.ok(src.includes("listWindows(session, execSync).includes(name)"));
});

test("has ensurePermissiveConfig function", () => {
  assert.ok(src.includes("function ensurePermissiveConfig("));
});

test("only sets up permission config for pi harness", () => {
  assert.ok(src.includes('if (harness === "pi")'));
  assert.ok(src.includes("ensurePermissiveConfig(agentCwd)"));
});

test("dismissAgent sends Ctrl+C then exit", () => {
  assert.ok(src.includes("C-c"));
  assert.ok(src.includes("'exit' Enter"));
});

// ─── Slash commands ──────────────────────────────────────────────

test("registers /ppt-spawn command", () => {
  assert.ok(src.includes('"ppt-spawn"'));
});

test("registers /ppt-dismiss command", () => {
  assert.ok(src.includes('"ppt-dismiss"'));
});

test("registers /ppt-hop command", () => {
  assert.ok(src.includes('"ppt-hop"'));
});

test("registers /ppt-status command", () => {
  assert.ok(src.includes('"ppt-status"'));
});

test("registers /ppt-browse command", () => {
  assert.ok(src.includes('"ppt-browse"'));
});

test("/ppt-status fetches from daemon", () => {
  assert.ok(src.includes("client.getStatus()"));
});

test("/ppt-status shows tmux windows", () => {
  assert.ok(src.includes("listWindows(tmuxSession"));
});

// ─── Widget ──────────────────────────────────────────────────────

test("updates widget periodically", () => {
  assert.ok(src.includes("WIDGET_UPDATE_INTERVAL_MS"));
  assert.ok(src.includes("setWidget"));
});

test("widget shows task progress", () => {
  assert.ok(src.includes("tasks done"));
});

test("widget shows inbox count", () => {
  assert.ok(src.includes("inbox"));
});

// ─── Shell safety ────────────────────────────────────────────────

test("has shellSafe function", () => {
  assert.ok(src.includes("function shellSafe("));
});

test("shellSafe removes dangerous characters", () => {
  assert.ok(src.includes("[^a-zA-Z0-9._~/:@-]"));
});

// ─── No server-side deps ─────────────────────────────────────────

test("does not import better-sqlite3 or hono", () => {
  assert.ok(!src.includes("better-sqlite3"));
  assert.ok(!src.includes("hono"));
});

test("does not import Store", () => {
  assert.ok(!src.includes("Store"));
});

test("delivers reset-session intent as Pi's /new keystrokes", () => {
  assert.ok(src.includes("deliverAgentCommand"));
  assert.ok(src.includes('"reset-session": "/new"'));
  assert.ok(src.includes("client.getLeaderDirectives()"));
  assert.ok(src.includes("client.completeLeaderDirective("));
});

test("passes tmux session/window to spawned agents", () => {
  assert.ok(src.includes("--ppt-tmux-session={session} --ppt-tmux-window={window}"));
  assert.ok(src.includes(".replace(/\\{window\\}/g,"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
