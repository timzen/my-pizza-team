/**
 * tests/e2e/sandbox.test.ts — the sandbox harness does what it promises (P5-1).
 *
 * Everything else in tests/e2e/ trusts this harness to keep tests away from real
 * configuration, so its promises are tested directly rather than assumed:
 *
 *   - the real Pi settings and trust file are never touched;
 *   - tmux runs on a private server the user's real one cannot see;
 *   - teardown happens even when the test body throws.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../_assert.ts";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { hasTmux, sandbox, sandboxLeftovers } from "./_sandbox.ts";

const REAL_PI_SETTINGS = path.join(process.env["HOME"] ?? "", ".pi", "agent", "settings.json");

/** A fingerprint of the user's real Pi settings, so we can prove nothing changed. */
function realSettingsFingerprint(): string {
  try {
    return fs.readFileSync(REAL_PI_SETTINGS, "utf8");
  } catch {
    return "<absent>";
  }
}

test("the CLI runs, and sees the sandbox rather than the real home", async () => {
  await using sb = await sandbox("home");
  const result = await sb.mpt("--version");
  assertEquals(result.code, 0);
  assertStringIncludes(result.output, "mpt v");
  // The environment the CLI got is the sandbox's.
  assertEquals(sb.env.HOME, sb.home);
  assertEquals(sb.env.PI_CODING_AGENT_DIR, sb.piAgentDir);
});

test("a setup inside the sandbox leaves the real Pi settings untouched", async () => {
  // The rule this whole phase depends on, asserted rather than trusted.
  const before = realSettingsFingerprint();
  {
    await using sb = await sandbox("isolation");
    sb.writePiSettings({ packages: ["npm:something"], theme: "dark" });
    const result = await sb.mpt("setup");
    assertEquals(result.code, 0, result.output);
    // It *did* write — into the sandbox.
    assertStringIncludes(JSON.stringify(sb.readPiSettings()), "pi-extension");
  }
  assertEquals(realSettingsFingerprint(), before, "the user's real ~/.pi/agent/settings.json changed");
});

test("tmux in the sandbox is a private server the real one cannot see", { skip: !hasTmux() }, async () => {
  await using sb = await sandbox("tmux");
  const made = await sb.tmux("new-session", "-d", "-s", sb.session);
  assertEquals(made.code, 0, made.output);

  // Visible to the sandbox's server...
  assertStringIncludes((await sb.tmux("list-sessions")).stdout, sb.session);

  // ...and not to the real one. Queried without TMUX_TMPDIR, i.e. the default server.
  const real = spawnSync("tmux", ["list-sessions"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assertEquals(
    real.stdout.includes(sb.session),
    false,
    "a sandbox session leaked onto the user's real tmux server",
  );
});

test("teardown kills the sandbox's tmux server and leaves the real one running", { skip: !hasTmux() }, async () => {
  // Count the real server's sessions before and after: the sandbox's kill-server
  // must reach only its own.
  const countReal = () => {
    const out = spawnSync("tmux", ["list-sessions"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.stdout.split("\n").filter(Boolean).length;
  };
  const before = countReal();
  let tmuxDir = "";
  {
    await using sb = await sandbox("teardown");
    tmuxDir = sb.tmuxDir;
    await sb.tmux("new-session", "-d", "-s", sb.session);
  }
  assertEquals(existsSync(tmuxDir), false, "the private socket directory should be gone");
  assertEquals(countReal(), before, "teardown touched the user's real tmux server");
});

test("teardown happens even when the test body throws", async () => {
  // P5-1's acceptance check: a failing test must still leave nothing behind.
  let leftovers: string[] = [];
  let root = "";
  await assertRejects(async () => {
    await using sb = await sandbox("throws");
    root = sb.root;
    leftovers = [sb.root, sb.tmuxDir];
    fs.writeFileSync(path.join(sb.projectDir, "evidence.txt"), "x");
    if (hasTmux()) await sb.tmux("new-session", "-d", "-s", sb.session);
    throw new Error("simulated assertion failure");
  }, Error, "simulated assertion failure");

  assertEquals(root.length > 0, true);
  assertEquals(sandboxLeftovers({ root: leftovers[0]!, tmuxDir: leftovers[1]! }), [], "temp directories survived a failing test");
});

test("each sandbox gets its own port and session, so they can run side by side", async () => {
  await using a = await sandbox("pa");
  await using b = await sandbox("pb");
  assertEquals(a.port === b.port, false);
  assertEquals(a.session === b.session, false);
  assertEquals(a.root === b.root, false);
});
