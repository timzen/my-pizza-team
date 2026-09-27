/**
 * tests/e2e/cli-lifecycle.test.ts — `mpt setup`, `doctor`, and `uninstall`, end to end (P5-2).
 *
 * During Phase 2 each of these was verified by hand in a throwaway sandbox: a machine
 * seeded like Tim's (with a legacy registration), dry-run, apply, idempotence, the
 * dev-checkout step-aside, and the uninstall round-trip. They found real bugs and left
 * no test behind. This is those runs, repeatable.
 *
 * Every case asserts the **resulting state** — the settings file and the directories —
 * not merely the exit code. An exit code of 0 is exactly what a command that did the
 * wrong thing quietly also returns.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { sandbox, type Sandbox } from "./_sandbox.ts";

const REPO = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..", "..");
const DEV_CHECKOUT = path.join(REPO, "harnesses", "pi");

/** The user settings a real machine has, which setup must never disturb. */
const USER_SETTINGS = {
  defaultModel: "global.anthropic.claude-opus-5",
  theme: "dark",
  lastChangelogVersion: "0.87.1",
};

const managedDir = (sb: Sandbox) => path.join(sb.home, ".my-pizza-team", "pi-extension");
const packages = (sb: Sandbox) => (sb.readPiSettings().packages ?? []) as string[];

/** A pre-merge standalone checkout, as Tim's machine has registered. */
function legacyCheckout(sb: Sandbox): string {
  const dir = path.join(sb.root, "mpt-dev", "pi-pizza-team");
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-pizza-team", version: "0.2.0" }));
  return dir;
}

function assertUserSettingsPreserved(sb: Sandbox): void {
  const s = sb.readPiSettings();
  for (const [key, value] of Object.entries(USER_SETTINGS)) {
    assertEquals(s[key], value, `the user's ${key} must survive`);
  }
}

// ─── setup ───────────────────────────────────────────────────────────

Deno.test("setup on a fresh machine: writes, registers, prepares the team, trusts the folder", async () => {
  await using sb = await sandbox("fresh");
  sb.writePiSettings({ packages: ["npm:pi-powerline-footer"], ...USER_SETTINGS });

  const result = await sb.mpt("setup");
  assertEquals(result.code, 0, result.output);

  // The extension is really on disk, not just claimed.
  assertEquals(existsSync(path.join(managedDir(sb), "package.json")), true);
  assertEquals(existsSync(path.join(managedDir(sb), "src", "runtime", "client.ts")), true);
  // Registered the way Pi itself would record it.
  assertEquals(packages(sb).includes("../../.my-pizza-team/pi-extension"), true, JSON.stringify(packages(sb)));
  assertEquals(packages(sb).includes("npm:pi-powerline-footer"), true, "other packages survive");
  assertUserSettingsPreserved(sb);
  // Team directory and trust.
  assertEquals(existsSync(path.join(sb.teamDir, "config.json")), true);
  const trust = JSON.parse(Deno.readTextFileSync(path.join(sb.piAgentDir, "trust.json")));
  assertEquals(trust[sb.projectDir], true);
});

Deno.test("setup replaces a legacy standalone registration — Tim's machine", async () => {
  await using sb = await sandbox("legacy");
  const legacy = legacyCheckout(sb);
  sb.writePiSettings({ packages: [legacy, "npm:@gotgenes/pi-permission-system"], ...USER_SETTINGS });

  const result = await sb.mpt("setup");
  assertEquals(result.code, 0, result.output);
  assertStringIncludes(result.output, "archived");

  assertEquals(packages(sb).includes(legacy), false, "the archived repo must be unregistered");
  assertEquals(packages(sb).includes("../../.my-pizza-team/pi-extension"), true);
  assertEquals(packages(sb).includes("npm:@gotgenes/pi-permission-system"), true);
  assertEquals(existsSync(legacy), true, "the legacy checkout itself is left on disk");
  assertUserSettingsPreserved(sb);
});

Deno.test("setup steps aside for a registered dev checkout, touching nothing of it", async () => {
  // Replacing a checkout someone is editing would make their edits stop taking effect.
  await using sb = await sandbox("dev");
  sb.writePiSettings({ packages: [DEV_CHECKOUT], ...USER_SETTINGS });
  const before = JSON.stringify(sb.readPiSettings().packages);

  const result = await sb.mpt("setup");
  assertEquals(result.code, 0, result.output);
  assertStringIncludes(result.output, "development checkout");

  assertEquals(JSON.stringify(sb.readPiSettings().packages), before, "the package list must be unchanged");
  assertEquals(existsSync(managedDir(sb)), false, "no managed copy should be written");
});

Deno.test("setup with both managed and dev registered removes its own, avoiding a double load", async () => {
  // Both registered means Pi loads the extension twice: duplicate tools, two directive
  // pollers, two heartbeats per agent.
  await using sb = await sandbox("both");
  sb.writePiSettings({ packages: [DEV_CHECKOUT], ...USER_SETTINGS });
  await sb.mpt("setup"); // step aside: nothing registered by us
  // Simulate a stale managed entry alongside the dev one.
  const s = sb.readPiSettings();
  s.packages = [...(s.packages as string[]), "../../.my-pizza-team/pi-extension"];
  sb.writePiSettings(s);
  Deno.mkdirSync(managedDir(sb), { recursive: true });
  Deno.writeTextFileSync(path.join(managedDir(sb), "package.json"), JSON.stringify({ name: "pi-pizza-team", version: "0.1.0" }));

  const result = await sb.mpt("setup");
  assertEquals(result.code, 0, result.output);
  assertEquals(packages(sb), [DEV_CHECKOUT], "exactly one registration — the dev checkout");
});

Deno.test("setup is idempotent: a second run changes no registration", async () => {
  await using sb = await sandbox("idem");
  sb.writePiSettings({ packages: [], ...USER_SETTINGS });
  await sb.mpt("setup");
  const first = JSON.stringify(packages(sb));

  const again = await sb.mpt("setup");
  assertEquals(again.code, 0, again.output);
  assertEquals(JSON.stringify(packages(sb)), first);
  assertEquals(packages(sb).filter((p) => p.includes("pi-extension")).length, 1);
});

Deno.test("setup --dry-run changes nothing at all", async () => {
  await using sb = await sandbox("dry");
  const legacy = legacyCheckout(sb);
  sb.writePiSettings({ packages: [legacy], ...USER_SETTINGS });
  const before = Deno.readTextFileSync(path.join(sb.piAgentDir, "settings.json"));

  const result = await sb.mpt("setup", "--dry-run");
  assertEquals(result.code, 0, result.output);
  assertStringIncludes(result.output, "Nothing was changed");
  assertStringIncludes(result.output, legacy, "the plan still names what it would do");

  assertEquals(Deno.readTextFileSync(path.join(sb.piAgentDir, "settings.json")), before, "settings changed");
  assertEquals(existsSync(managedDir(sb)), false);
  assertEquals(existsSync(sb.teamDir), false);
  assertEquals(existsSync(path.join(sb.piAgentDir, "trust.json")), false);
});

Deno.test("setup refuses to overwrite Pi settings it cannot parse", async () => {
  await using sb = await sandbox("corrupt");
  const corrupt = "{ this is not json";
  Deno.writeTextFileSync(path.join(sb.piAgentDir, "settings.json"), corrupt);

  const result = await sb.mpt("setup");
  assertEquals(result.code === 0, false, "must fail rather than overwrite");
  assertStringIncludes(result.output, "will not overwrite");
  assertEquals(Deno.readTextFileSync(path.join(sb.piAgentDir, "settings.json")), corrupt, "the file must be untouched");
});

Deno.test("setup never overwrites an existing team config", async () => {
  // A half-initialised team directory may already hold real data.
  await using sb = await sandbox("teamcfg");
  sb.writePiSettings({ packages: [] });
  Deno.mkdirSync(sb.teamDir, { recursive: true });
  Deno.writeTextFileSync(path.join(sb.teamDir, "state.db"), "existing data");

  await sb.mpt("setup");
  assertEquals(Deno.readTextFileSync(path.join(sb.teamDir, "state.db")), "existing data");
  assertEquals(existsSync(path.join(sb.teamDir, "config.json")), true, "config is written when absent");

  Deno.writeTextFileSync(path.join(sb.teamDir, "config.json"), JSON.stringify({ tmuxSession: "mine" }));
  await sb.mpt("setup");
  assertEquals(JSON.parse(Deno.readTextFileSync(path.join(sb.teamDir, "config.json"))).tmuxSession, "mine");
});

// ─── doctor ──────────────────────────────────────────────────────────

Deno.test("doctor fails on real breakage and passes after setup", async () => {
  await using sb = await sandbox("doctor");
  sb.writePiSettings({ packages: [], ...USER_SETTINGS });

  const before = await sb.mpt("doctor");
  assertEquals(before.code === 0, false, "no extension registered is a real problem");
  assertStringIncludes(before.output, "mpt setup");

  await sb.mpt("setup");
  const after = await sb.mpt("doctor");
  assertEquals(after.code, 0, `doctor should pass after setup:\n${after.output}`);
  assertStringIncludes(after.output, "managed install");
});

Deno.test("doctor fails when Pi is missing, whatever the host has installed", async () => {
  // Only deterministic because the sandbox controls PATH; before that, a host with Pi
  // made this unobservable and a host without it broke the test above.
  await using sb = await sandbox("doctor-nopi", { pi: false });
  sb.writePiSettings({ packages: [] });
  await sb.mpt("setup");

  const result = await sb.mpt("doctor");
  assertEquals(result.code === 0, false);
  assertStringIncludes(result.output, "npm install -g @earendil-works/pi-coding-agent");
});

Deno.test("doctor is read-only", async () => {
  await using sb = await sandbox("doctor-ro");
  const legacy = legacyCheckout(sb);
  sb.writePiSettings({ packages: [legacy], ...USER_SETTINGS });
  const before = Deno.readTextFileSync(path.join(sb.piAgentDir, "settings.json"));

  await sb.mpt("doctor");
  assertEquals(Deno.readTextFileSync(path.join(sb.piAgentDir, "settings.json")), before);
  assertEquals(existsSync(managedDir(sb)), false);
});

// ─── uninstall ───────────────────────────────────────────────────────

Deno.test("uninstall undoes setup, keeping user settings and team data", async () => {
  await using sb = await sandbox("uninstall");
  sb.writePiSettings({ packages: ["npm:pi-powerline-footer"], ...USER_SETTINGS });
  await sb.mpt("setup");
  Deno.writeTextFileSync(path.join(sb.teamDir, "team-data.json"), "{}");

  const result = await sb.mpt("setup", "--uninstall");
  assertEquals(result.code, 0, result.output);

  assertEquals(packages(sb), ["npm:pi-powerline-footer"], "back to the original package list");
  assertUserSettingsPreserved(sb);
  assertEquals(existsSync(managedDir(sb)), false, "the managed copy is removed");
  assertEquals(existsSync(path.join(sb.teamDir, "team-data.json")), true, "team data is left alone");
});

Deno.test("uninstall names what setup removed instead of restoring it", async () => {
  // Restoring the legacy entry would re-create the broken state setup was fixing.
  await using sb = await sandbox("uninstall-legacy");
  const legacy = legacyCheckout(sb);
  sb.writePiSettings({ packages: [legacy], ...USER_SETTINGS });
  await sb.mpt("setup");

  const result = await sb.mpt("setup", "--uninstall");
  assertStringIncludes(result.output, "not restoring");
  assertStringIncludes(result.output, legacy);
  assertEquals(packages(sb).includes(legacy), false);
});

Deno.test("uninstall with nothing to undo is a no-op, not an error", async () => {
  await using sb = await sandbox("uninstall-none");
  sb.writePiSettings({ packages: ["npm:x"] });
  const before = Deno.readTextFileSync(path.join(sb.piAgentDir, "settings.json"));

  const result = await sb.mpt("setup", "--uninstall");
  assertEquals(result.code, 0);
  assertStringIncludes(result.output, "Nothing to undo");
  assertEquals(Deno.readTextFileSync(path.join(sb.piAgentDir, "settings.json")), before);
});
