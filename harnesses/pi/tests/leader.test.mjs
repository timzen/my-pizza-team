// Smoke test for leader role
// Run with: node tests/leader.test.mjs
//
// Verifies the leader source registers with the daemon, drives its slash
// commands through the daemon, and never touches tmux itself.

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

test("imports DaemonClient (type-only)", () => {
  assert.match(src, /import (type \{ DaemonClient \}|\{[^}]*\btype DaemonClient\b[^}]*\}) from "\.\/runtime\/client\.js"/);
});

test("imports registerLeaderTools", () => {
  assert.ok(src.includes('import { registerLeaderTools }'));
});

// ─── Daemon registration ─────────────────────────────────────────

test("registers with daemon on startup, reporting its terminal location as opaque metadata", () => {
  // The metadata is how the daemon addresses the leader's window. The leader only
  // relays it; it never reads it back (it doesn't touch the terminal).
  assert.ok(src.includes('name: "leader"'));
  assert.ok(src.includes("readTerminalMetadata(pi)"));
});

test("deregisters on session_shutdown", () => {
  assert.ok(src.includes("client.deregister()"));
});

// Regression: the leader once resolved its config only once at startup; a daemon
// that was down at that moment stayed unknown. Registration must be retryable.
test("registration is a retryable function", () => {
  assert.ok(src.includes("async function registerWithDaemon()"));
  assert.ok(src.includes("registered = true"));
});

test("heartbeat retries registration and re-registers when dismissed or unknown", () => {
  assert.ok(src.includes("if (res.dismissed || res.reregister)"));
  assert.ok(/if \(!registered\) \{\s*\n\s*try \{ await registerWithDaemon\(\); \}/.test(src));
});

// ─── The daemon is the only terminal owner ───────────────────────

test("no leader-directive poll: the daemon realizes spawn/dismiss, resets go to the agent", () => {
  assert.ok(!src.includes("client.getLeaderDirectives()"));
  assert.ok(!src.includes("dispatchDirective"));
  assert.ok(!src.includes("SPAWN_POLL_INTERVAL_MS"));
});

test("no tmux helpers, harness templates or keystroke delivery left in the leader", () => {
  for (const gone of [
    "function spawnAgent(", "function dismissAgent(", "function ensureSession(", "function listWindows(",
    "function teammateTemplates(", "function deliverAgentCommand(", "function shellSafe(",
    '"reset-session": "/new"', "execSync", "node:child_process", "DEFAULT_HARNESS_TEMPLATES", "DEFAULT_TMUX_SESSION",
  ]) assert.ok(!src.includes(gone), `leader.ts still has ${gone}`);
});

test("nothing spawns an assistant any more (the leader is the chat agent)", () => {
  assert.ok(!src.includes("--ppt-assistant"));
  assert.ok(!src.includes('reason === "assistant"'));
  assert.ok(!src.includes("--ppt-name=assistant"));
});

// The daemon spawns with these templates; they stay in the generated shared copy.
const shared = fs.readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8");

test("pi template uses -a --ppt-worker --ppt-daemon --ppt-name and passes the terminal location", () => {
  assert.ok(shared.includes("pi -a --ppt-worker --ppt-daemon={url} --ppt-name={name}"));
  assert.ok(shared.includes("--ppt-terminal={terminal} --ppt-terminal-session={terminalSession} --ppt-terminal-window={terminalWindow}"));
});

// The flags the template passes, and the metadata they become (src/terminal.ts):
// neutral flags, the older --ppt-tmux-* still accepted, relayed verbatim.
const terminalSrc = fs.readFileSync(path.join(import.meta.dirname, "../src/terminal.ts"), "utf-8");
test("registers the neutral --ppt-terminal* flags and keeps the older --ppt-tmux-* ones", () => {
  for (const flag of ["ppt-terminal", "ppt-terminal-session", "ppt-terminal-window", "ppt-terminal-handle", "ppt-tmux-session", "ppt-tmux-window"]) {
    assert.ok(terminalSrc.includes(`"${flag}"`), flag);
  }
  assert.ok(terminalSrc.includes("terminalMetadata({"), "builds metadata with the shared helper");
});

// ─── Slash commands ──────────────────────────────────────────────

test("registers /ppt-spawn, /ppt-dismiss, /ppt-hop and /ppt-status", () => {
  for (const name of ["ppt-spawn", "ppt-dismiss", "ppt-hop", "ppt-status"]) assert.ok(src.includes(`"${name}"`), name);
});

/** The handler body of a registered slash command. */
function command(name) {
  const start = src.indexOf(`registerCommand("${name}"`);
  assert.ok(start > -1, `no ${name}`);
  const next = src.indexOf("pi.registerCommand(", start + 1);
  return src.slice(start, next > -1 ? next : undefined);
}

test("/ppt-spawn validates the cwd, then creates a spawn directive for the daemon", () => {
  const cmd = command("ppt-spawn");
  assert.ok(cmd.includes("validateSpawnCwd(resolvedCwd)"));
  assert.ok(cmd.includes('cmdCtx.ui.notify(`Cannot spawn: ${cwdError}`'));
  assert.ok(cmd.indexOf("validateSpawnCwd(") < cmd.indexOf('client.createLeaderDirective("spawn"'));
  // A given name goes to the daemon (which realizes it); otherwise the daemon names it.
  assert.ok(cmd.includes("params.name = userProvidedName"));
  assert.ok(cmd.includes("res.directive.params?.name"));
});

test("/ppt-spawn waits for the daemon's outcome and reports a failure's reason", () => {
  const cmd = command("ppt-spawn");
  assert.ok(cmd.includes("awaitSpawn(client, res.directive.id, res.directive.status)"));
  assert.ok(cmd.includes('outcome.state === "failed"'));
  assert.ok(cmd.includes("outcome.error"));
  assert.ok(src.includes("client.getSpawnRequests()"));
});

test("validateSpawnCwd rejects missing paths and non-directories", () => {
  assert.ok(src.includes("function validateSpawnCwd("));
  assert.ok(src.includes("Working directory does not exist"));
  assert.ok(src.includes("Not a directory"));
});

test("/ppt-dismiss goes only through the daemon; an unknown name is an error", () => {
  const cmd = command("ppt-dismiss");
  assert.ok(cmd.includes("client.dismissAgent(member.id)"));
  assert.ok(cmd.includes("is not a registered teammate`, \"error\")"));
  assert.ok(cmd.includes("if (name === LEADER_WINDOW)"));
});

test("/ppt-hop asks the daemon to focus the window", () => {
  const cmd = command("ppt-hop");
  assert.ok(cmd.includes("client.focusAgent(member.id)"));
  assert.ok(cmd.includes("is not a registered teammate`, \"error\")"));
});

test("/ppt-status lists teammates from the daemon, not tmux windows", () => {
  const cmd = command("ppt-status");
  assert.ok(cmd.includes("client.getStatus()"));
  assert.ok(cmd.includes("client.listAgents()"));
  assert.ok(!cmd.includes("tmux windows"));
});

// ─── Widget ──────────────────────────────────────────────────────

test("updates widget periodically", () => {
  assert.ok(src.includes("WIDGET_UPDATE_INTERVAL_MS"));
  assert.ok(src.includes("setWidget"));
});

test("widget shows task progress", () => {
  assert.ok(src.includes("tasks done"));
});

test("widget shows task progress", () => {
  assert.ok(src.includes("tasks done"));
  assert.ok(src.includes("setWidget"));
});

// ─── No server-side deps ─────────────────────────────────────────

test("does not import better-sqlite3 or hono", () => {
  assert.ok(!src.includes("better-sqlite3"));
  assert.ok(!src.includes("hono"));
});

test("does not import Store", () => {
  assert.ok(!src.includes("Store"));
});

test("the readiness probe is the daemon's job, not the leader's", () => {
  // Moved in P3-2. While it lived here, a machine too wedged for the leader to start
  // was reported as healthy (nothing reported means ready) and work kept being
  // scheduled into it.
  assert.ok(!src.includes("runReadinessProbe"), "the leader should no longer probe");
  assert.ok(!src.includes("reportReadiness"), "nor report readiness");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
