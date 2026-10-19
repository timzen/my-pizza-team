/**
 * tests/doctor.test.ts — `mpt doctor`'s checklist logic.
 *
 * DESIGN.md "Setup Is One Command" section's complaint is that no setup step checks the others, so a missing piece
 * surfaces later as a symptom rather than an error. The value of doctor is therefore
 * entirely in *which* status it assigns and *what fix* it names, so that is what
 * these cover — `evaluate` is pure, so every branch is reachable without Pi, a
 * daemon, or a real home directory.
 *
 * Two calibrations are asserted deliberately, because getting them wrong would make
 * the tool worse than nothing:
 *
 *   - An untested Pi version *warns*; it does not fail. There is no extension-API
 *     version to negotiate (DESIGN.md "One Protocol, One Version"), so blocking would be a guess dressed as a
 *     requirement.
 *   - Only genuine breakage sets the exit code. If warnings failed the run, the exit
 *     code would mean "you have a normal setup" and nobody would read it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import {
  type Check,
  compareVersions,
  type DoctorFacts,
  evaluate,
  findLegacyBinaries,
  type NodeFacts,
  nodeChecks,
  PERMISSION_SYSTEM_PACKAGE,
  report,
  TESTED_PI_VERSION,
} from "../cli/doctor.ts";

/** A fully healthy system; each test perturbs one fact. */
function healthy(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    piVersion: TESTED_PI_VERSION,
    tmuxPresent: true,
    daemonVersion: "0.17.2",
    bundledExtensionVersion: "0.17.2",
    registrations: [{
      entry: "../../.my-pizza-team/pi-extension",
      source: "../../.my-pizza-team/pi-extension",
      resolvedPath: "/home/u/.my-pizza-team/pi-extension",
      kind: "managed",
    }],
    managedDir: "/home/u/.my-pizza-team/pi-extension",
    managedDirVersion: "0.17.2",
    permissionSystemInstalled: true,
    settingsPath: "/home/u/.pi/agent/settings.json",
    settingsReadable: true,
    teamDir: "/work/project/.my-pizza-team",
    teamDirPresent: true,
    teamDirExists: true,
    projectTrusted: true,
    daemonRunning: true,
    leaderConnected: true,
    spawning: { canSpawn: true },
    serviceInstalled: true,
    ...over,
  };
}

const find = (checks: Check[], name: string): Check => {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}: ${checks.map((x) => x.name).join(", ")}`);
  return c;
};

const statuses = (checks: Check[]) => new Set(checks.map((c) => c.status));

// ─── The healthy baseline ────────────────────────────────────────────

test("a healthy system reports no problems and no warnings", () => {
  const checks = evaluate(healthy());
  assertEquals(statuses(checks).has("fail"), false, JSON.stringify(checks.filter((c) => c.status === "fail")));
  assertEquals(statuses(checks).has("warn"), false, JSON.stringify(checks.filter((c) => c.status === "warn")));
});

test("every non-ok check names a fix — a problem without a next step is noise", () => {
  // The whole premise of DESIGN.md "Setup Is One Command" is that symptoms don't tell you what to do.
  const perturbations: Array<Partial<DoctorFacts>> = [
    { piVersion: null },
    { piVersion: "0.50.0" },
    { tmuxPresent: false },
    { settingsReadable: false },
    { registrations: [] },
    { managedDirVersion: "0.16.0" },
    { permissionSystemInstalled: false },
    { teamDirExists: false, teamDirPresent: false },
    { teamDirExists: false, teamDirPresent: true },
    { projectTrusted: false },
    { daemonRunning: false },
    { daemonRunning: true, leaderConnected: false },
  ];
  for (const over of perturbations) {
    for (const check of evaluate(healthy(over))) {
      if (check.status === "ok") continue;
      assertEquals(
        typeof check.fix === "string" && check.fix.length > 0,
        true,
        `${check.name} (${check.status}) has no fix — perturbation ${JSON.stringify(over)}`,
      );
    }
  }
});

// ─── Prerequisites ───────────────────────────────────────────────────

test("a missing Pi fails; an older-than-tested Pi only warns", () => {
  assertEquals(find(evaluate(healthy({ piVersion: null })), "Pi").status, "fail");

  const older = find(evaluate(healthy({ piVersion: "0.50.0" })), "Pi");
  assertEquals(older.status, "warn", "an untested Pi must not block — there is no API version to negotiate");
  assertStringIncludes(older.detail, TESTED_PI_VERSION);
});

test("a newer Pi than tested is fine, not a warning", () => {
  // Warning on every Pi release would train people to ignore the output.
  assertEquals(find(evaluate(healthy({ piVersion: "99.0.0" })), "Pi").status, "ok");
});

test("missing tmux fails — teammates have nowhere to run", () => {
  assertEquals(find(evaluate(healthy({ tmuxPresent: false })), "tmux").status, "fail");
});

// ─── Extension registration ──────────────────────────────────────────

test("two registrations fail, and the detail explains the double load", () => {
  // Silent in practice: duplicate tools and commands, two directive pollers, two
  // heartbeats per agent. Naming the consequence is the point.
  const checks = evaluate(healthy({
    registrations: [
      { entry: "a", source: "a", resolvedPath: "/home/u/.my-pizza-team/pi-extension", kind: "managed" },
      { entry: "b", source: "b", resolvedPath: "/code/mpt/harnesses/pi", kind: "dev" },
    ],
  }));
  const check = find(checks, "Extension");
  assertEquals(check.status, "fail");
  assertStringIncludes(check.detail, "twice");
  assertStringIncludes(check.fix!, "mpt setup");
});

test("no registration fails", () => {
  assertEquals(find(evaluate(healthy({ registrations: [] })), "Extension").status, "fail");
});

test("a dev checkout is fine and setup promises to leave it alone", () => {
  const check = find(
    evaluate(healthy({
      registrations: [{ entry: "d", source: "d", resolvedPath: "/code/mpt/harnesses/pi", kind: "dev" }],
    })),
    "Extension",
  );
  assertEquals(check.status, "ok");
  assertStringIncludes(check.detail, "leave it alone");
});

test("a pre-merge standalone checkout warns and says the repo is archived", () => {
  const check = find(
    evaluate(healthy({
      registrations: [{ entry: "l", source: "l", resolvedPath: "/code/pi-pizza-team", kind: "legacy" }],
    })),
    "Extension",
  );
  assertEquals(check.status, "warn");
  assertStringIncludes(check.detail, "archived");
});

test("a registration pointing at a deleted directory fails", () => {
  const check = find(
    evaluate(healthy({
      registrations: [{ entry: "m", source: "m", resolvedPath: "/gone/pi-extension", kind: "missing" }],
    })),
    "Extension",
  );
  assertEquals(check.status, "fail");
  assertStringIncludes(check.detail, "no longer exists");
});

// ─── Version skew ────────────────────────────────────────────────────

test("an older installed extension warns, and the fix includes restarting agents", () => {
  // Restarting is the part people forget: rewriting the directory changes nothing
  // for an agent already running.
  const check = find(evaluate(healthy({ managedDirVersion: "0.16.0" })), "Extension version");
  assertEquals(check.status, "warn");
  assertStringIncludes(check.fix!, "restart");
});

test("no version skew check when the extension isn't installed yet", () => {
  // Nothing to compare, and the registration check already covers it.
  const checks = evaluate(healthy({ managedDirVersion: null, registrations: [] }));
  assertEquals(checks.some((c) => c.name === "Extension version"), false);
});

// ─── Optional and advisory ───────────────────────────────────────────

test("a missing permission system warns with the reason autonomy breaks", () => {
  const check = find(evaluate(healthy({ permissionSystemInstalled: false })), "Permission system");
  assertEquals(check.status, "warn");
  assertStringIncludes(check.detail, "permission prompts");
  assertStringIncludes(check.fix!, PERMISSION_SYSTEM_PACKAGE);
});

test("an unconfigured-but-present team directory says so precisely", () => {
  // A directory holding only a database is half-initialised, not absent.
  const check = find(evaluate(healthy({ teamDirExists: false, teamDirPresent: true })), "Team directory");
  assertEquals(check.status, "warn");
  assertStringIncludes(check.detail, "no config.json");
  assertStringIncludes(check.fix!, "without touching existing data");
});

test("an untrusted project fails — agents block on the trust prompt", () => {
  const check = find(evaluate(healthy({ projectTrusted: false })), "Project trust");
  assertEquals(check.status, "fail");
});

test("a stopped daemon warns, and the leader check is skipped", () => {
  // Reporting "no leader" while the daemon is down would be a second symptom of one
  // cause, which is the noise DESIGN.md "Setup Is One Command" complains about.
  const checks = evaluate(healthy({ daemonRunning: false, leaderConnected: null }));
  assertEquals(find(checks, "Daemon").status, "warn");
  assertEquals(checks.some((c) => c.name === "Leader"), false);
});

test("what a missing leader costs depends on who spawns", () => {
  // Saying "nothing will spawn teammates" beside "Spawning: daemon-driven" would be
  // self-contradicting — and it was, until this was made conditional.
  const daemonSpawns = find(evaluate(healthy({ leaderConnected: false, spawning: { canSpawn: true } })), "Leader");
  assertEquals(daemonSpawns.status, "warn");
  assertStringIncludes(daemonSpawns.detail, "teammates still spawn");

  const leaderSpawns = find(
    evaluate(healthy({ leaderConnected: false, spawning: { canSpawn: false, reason: "no tmux", fix: "install tmux" } })),
    "Leader",
  );
  assertStringIncludes(leaderSpawns.detail, "nothing will spawn");
});

test("the spawning path is reported, and a daemon that can't reach tmux warns", () => {
  // Both paths work — the leader realizes directives when the daemon can't. Saying
  // which is live turns "nothing spawned" from a mystery into a fact.
  assertEquals(find(evaluate(healthy()), "Spawning").status, "ok");

  const fallback = find(
    evaluate(healthy({ spawning: { canSpawn: false, reason: "tmux is not on this process's PATH", fix: "install tmux" } })),
    "Spawning",
  );
  assertEquals(fallback.status, "warn");
  assertStringIncludes(fallback.detail, "leader-driven");
  assertStringIncludes(fallback.fix!, "tmux");
});

test("no spawning check when the daemon isn't running to report it", () => {
  const checks = evaluate(healthy({ daemonRunning: false, leaderConnected: null, spawning: null }));
  assertEquals(checks.some((c) => c.name === "Spawning"), false);
});

test("an uninstalled service is not a problem", () => {
  // Genuinely optional; flagging it would dilute the real findings.
  const checks = evaluate(healthy({ serviceInstalled: false }));
  assertEquals(find(checks, "Service").status, "ok");
});

test("unparseable Pi settings fail and promise not to overwrite them", () => {
  const check = find(evaluate(healthy({ settingsReadable: false })), "Pi settings");
  assertEquals(check.status, "fail");
  assertStringIncludes(check.fix!, "will not overwrite");
});

// ─── Exit code ───────────────────────────────────────────────────────

test("only failures set a non-zero exit code", () => {
  const original = console.log;
  console.log = () => {};
  try {
    assertEquals(report(evaluate(healthy())), 0, "healthy");
    assertEquals(report(evaluate(healthy({ permissionSystemInstalled: false }))), 0, "warnings alone must not fail");
    assertEquals(report(evaluate(healthy({ tmuxPresent: false }))), 1, "a real problem must fail");
  } finally {
    console.log = original;
  }
});

// ─── Version comparison ──────────────────────────────────────────────

test("compareVersions orders releases and tolerates junk", () => {
  assertEquals(compareVersions("1.2.3", "1.2.3"), 0);
  assertEquals(compareVersions("0.87.1", "0.87.2")! < 0, true);
  assertEquals(compareVersions("0.100.0", "0.87.1")! > 0, true, "numeric, not lexicographic");
  assertEquals(compareVersions("1.2", "1.2.0"), 0, "missing components are zero");
  assertEquals(compareVersions("v1.2.3", "1.2.3"), 0, "a leading v is tolerated");
  assertEquals(compareVersions("not-a-version", "1.0.0"), null);
});

test("experimental harnesses are reported only when opted in, and never fail doctor", () => {
  const base = healthy();
  assertEquals(evaluate(base).some((c) => c.name.includes("experimental")), false, "absent unless opted in");
  const checks = evaluate({
    ...base,
    experimentalHarnesses: { kiro: { ready: true }, claude: { ready: false, missing: "the Claude Code ACP adapter is not installed", fix: "mpt setup --harness claude" } },
  });
  const kiro = checks.find((c) => c.name === "kiro (experimental)");
  const claude = checks.find((c) => c.name === "claude (experimental)");
  assertEquals(kiro?.status, "ok");
  assertEquals(claude?.status, "warn");
  assertEquals(claude?.fix, "mpt setup --harness claude");
});

// ─── The saved Node (shared/runtime-config.ts) ───────────────────────

function nodeFacts(over: Partial<NodeFacts> = {}): NodeFacts {
  return {
    configured: { path: "/opt/homebrew/bin/node", source: "/h/.config/mpt/runtime.json", version: "24.1.0", problem: null, pinnedWarning: null },
    required: "24.0.0",
    runningNode: "/opt/homebrew/Cellar/node/24.1.0/bin/node",
    runningMatchesConfigured: true,
    service: { node: "/opt/homebrew/bin/node", entry: "/pkg/dist/main.js" },
    expectedEntry: "/pkg/dist/main.js",
    serviceEntryMatches: true,
    legacyBinaries: [],
    ...over,
  };
}

test("node: a healthy setup reports path, version and source, nothing else", () => {
  const checks = nodeChecks(nodeFacts());
  assertEquals(checks.length, 1);
  assertEquals(checks[0]!.status, "ok");
  assertStringIncludes(checks[0]!.detail, "/opt/homebrew/bin/node (v24.1.0, from /h/.config/mpt/runtime.json)");
});

test("node: evaluate includes the node checks when gathered", () => {
  assertEquals(find(evaluate(healthy({ node: nodeFacts() })), "Node").status, "ok");
});

test("node: nothing saved warns and points at setup", () => {
  const c = find(nodeChecks(nodeFacts({ configured: null })), "Node");
  assertEquals(c.status, "warn");
  assertStringIncludes(c.fix!, "mpt setup");
});

test("node: missing or too-old saved Node warns with the minimum", () => {
  const c = find(nodeChecks(nodeFacts({
    configured: { path: "/gone/node", source: "MPT_NODE", version: null, problem: "/gone/node does not exist", pinnedWarning: null },
  })), "Node");
  assertEquals(c.status, "warn");
  assertStringIncludes(c.detail, "does not exist");
  assertStringIncludes(c.detail, "MPT_NODE");
  assertStringIncludes(c.fix!, ">=24.0.0");
});

test("node: a version-pinned path warns", () => {
  const c = find(nodeChecks(nodeFacts({
    configured: { path: "/h/.nvm/versions/node/v24/bin/node", source: "--node", version: "24.0.0", problem: null, pinnedWarning: "pinned by nvm" },
  })), "Node path");
  assertEquals(c.status, "warn");
});

test("node: the service running another Node or entry warns", () => {
  const checks = nodeChecks(nodeFacts({ service: { node: "/usr/bin/node", entry: "/old/dist/main.js" }, serviceEntryMatches: false }));
  assertEquals(find(checks, "Service Node").status, "warn");
  assertStringIncludes(find(checks, "Service Node").fix!, "mpt install");
  assertStringIncludes(find(checks, "Service entry").detail, "/old/dist/main.js");
});

test("node: an old compiled-binary service warns once, even with no Node saved", () => {
  const checks = nodeChecks(nodeFacts({ configured: null, service: { node: "/usr/local/bin/mpt", entry: null }, serviceEntryMatches: false }));
  const service = checks.filter((c) => c.name.startsWith("Service"));
  assertEquals(service.length, 1);
  assertStringIncludes(service[0]!.detail, "old compiled-binary install");
  assertStringIncludes(service[0]!.fix!, "mpt install");
});

test("node: a leftover compiled mpt on PATH warns with the path to delete", () => {
  const c = find(nodeChecks(nodeFacts({ legacyBinaries: ["/usr/local/bin/mpt"] })), "Old mpt binary");
  assertEquals(c.status, "warn");
  assertStringIncludes(c.fix!, "rm /usr/local/bin/mpt");
});

test("findLegacyBinaries: a native mpt counts, a script or symlink to one doesn't", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-legacy-"));
  try {
    const native = path.join(dir, "native"), script = path.join(dir, "script");
    fs.mkdirSync(native);
    fs.mkdirSync(script);
    fs.writeFileSync(path.join(native, "mpt"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
    fs.writeFileSync(path.join(dir, "main.js"), "#!/usr/bin/env node\n");
    fs.symlinkSync(path.join(dir, "main.js"), path.join(script, "mpt"));
    const found = findLegacyBinaries([script, native, path.join(dir, "missing")].join(path.delimiter));
    assertEquals(found, [path.join(native, "mpt")]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("node: no service means no service checks", () => {
  const checks = nodeChecks(nodeFacts({ service: null }));
  assertEquals(checks.some((c) => c.name.startsWith("Service")), false);
});

test("node: this process on a different Node warns", () => {
  const c = find(nodeChecks(nodeFacts({ runningMatchesConfigured: false, runningNode: "/usr/bin/node" })), "Running Node");
  assertEquals(c.status, "warn");
  assertStringIncludes(c.detail, "/usr/bin/node");
});
