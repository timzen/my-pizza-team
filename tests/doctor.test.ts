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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type Check,
  compareVersions,
  type DoctorFacts,
  evaluate,
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
    githubTokenSet: true,
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

Deno.test("a healthy system reports no problems and no warnings", () => {
  const checks = evaluate(healthy());
  assertEquals(statuses(checks).has("fail"), false, JSON.stringify(checks.filter((c) => c.status === "fail")));
  assertEquals(statuses(checks).has("warn"), false, JSON.stringify(checks.filter((c) => c.status === "warn")));
});

Deno.test("every non-ok check names a fix — a problem without a next step is noise", () => {
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

Deno.test("a missing Pi fails; an older-than-tested Pi only warns", () => {
  assertEquals(find(evaluate(healthy({ piVersion: null })), "Pi").status, "fail");

  const older = find(evaluate(healthy({ piVersion: "0.50.0" })), "Pi");
  assertEquals(older.status, "warn", "an untested Pi must not block — there is no API version to negotiate");
  assertStringIncludes(older.detail, TESTED_PI_VERSION);
});

Deno.test("a newer Pi than tested is fine, not a warning", () => {
  // Warning on every Pi release would train people to ignore the output.
  assertEquals(find(evaluate(healthy({ piVersion: "99.0.0" })), "Pi").status, "ok");
});

Deno.test("missing tmux fails — teammates have nowhere to run", () => {
  assertEquals(find(evaluate(healthy({ tmuxPresent: false })), "tmux").status, "fail");
});

// ─── Extension registration ──────────────────────────────────────────

Deno.test("two registrations fail, and the detail explains the double load", () => {
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

Deno.test("no registration fails", () => {
  assertEquals(find(evaluate(healthy({ registrations: [] })), "Extension").status, "fail");
});

Deno.test("a dev checkout is fine and setup promises to leave it alone", () => {
  const check = find(
    evaluate(healthy({
      registrations: [{ entry: "d", source: "d", resolvedPath: "/code/mpt/harnesses/pi", kind: "dev" }],
    })),
    "Extension",
  );
  assertEquals(check.status, "ok");
  assertStringIncludes(check.detail, "leave it alone");
});

Deno.test("a pre-merge standalone checkout warns and says the repo is archived", () => {
  const check = find(
    evaluate(healthy({
      registrations: [{ entry: "l", source: "l", resolvedPath: "/code/pi-pizza-team", kind: "legacy" }],
    })),
    "Extension",
  );
  assertEquals(check.status, "warn");
  assertStringIncludes(check.detail, "archived");
});

Deno.test("a registration pointing at a deleted directory fails", () => {
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

Deno.test("an older installed extension warns, and the fix includes restarting agents", () => {
  // Restarting is the part people forget: rewriting the directory changes nothing
  // for an agent already running.
  const check = find(evaluate(healthy({ managedDirVersion: "0.16.0" })), "Extension version");
  assertEquals(check.status, "warn");
  assertStringIncludes(check.fix!, "restart");
});

Deno.test("no version skew check when the extension isn't installed yet", () => {
  // Nothing to compare, and the registration check already covers it.
  const checks = evaluate(healthy({ managedDirVersion: null, registrations: [] }));
  assertEquals(checks.some((c) => c.name === "Extension version"), false);
});

// ─── Optional and advisory ───────────────────────────────────────────

Deno.test("a missing permission system warns with the reason autonomy breaks", () => {
  const check = find(evaluate(healthy({ permissionSystemInstalled: false })), "Permission system");
  assertEquals(check.status, "warn");
  assertStringIncludes(check.detail, "permission prompts");
  assertStringIncludes(check.fix!, PERMISSION_SYSTEM_PACKAGE);
});

Deno.test("an unconfigured-but-present team directory says so precisely", () => {
  // A directory holding only a database is half-initialised, not absent.
  const check = find(evaluate(healthy({ teamDirExists: false, teamDirPresent: true })), "Team directory");
  assertEquals(check.status, "warn");
  assertStringIncludes(check.detail, "no config.json");
  assertStringIncludes(check.fix!, "without touching existing data");
});

Deno.test("an untrusted project fails — agents block on the trust prompt", () => {
  const check = find(evaluate(healthy({ projectTrusted: false })), "Project trust");
  assertEquals(check.status, "fail");
});

Deno.test("a stopped daemon warns, and the leader check is skipped", () => {
  // Reporting "no leader" while the daemon is down would be a second symptom of one
  // cause, which is the noise DESIGN.md "Setup Is One Command" complains about.
  const checks = evaluate(healthy({ daemonRunning: false, leaderConnected: null }));
  assertEquals(find(checks, "Daemon").status, "warn");
  assertEquals(checks.some((c) => c.name === "Leader"), false);
});

Deno.test("what a missing leader costs depends on who spawns", () => {
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

Deno.test("the spawning path is reported, and a daemon that can't reach tmux warns", () => {
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

Deno.test("no spawning check when the daemon isn't running to report it", () => {
  const checks = evaluate(healthy({ daemonRunning: false, leaderConnected: null, spawning: null }));
  assertEquals(checks.some((c) => c.name === "Spawning"), false);
});

Deno.test("an uninstalled service and an unset token are not problems", () => {
  // Both are genuinely optional; flagging them would dilute the real findings.
  const checks = evaluate(healthy({ serviceInstalled: false, githubTokenSet: false }));
  assertEquals(find(checks, "Service").status, "ok");
  assertEquals(find(checks, "GITHUB_TOKEN").status, "ok");
});

Deno.test("unparseable Pi settings fail and promise not to overwrite them", () => {
  const check = find(evaluate(healthy({ settingsReadable: false })), "Pi settings");
  assertEquals(check.status, "fail");
  assertStringIncludes(check.fix!, "will not overwrite");
});

// ─── Exit code ───────────────────────────────────────────────────────

Deno.test("only failures set a non-zero exit code", () => {
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

Deno.test("compareVersions orders releases and tolerates junk", () => {
  assertEquals(compareVersions("1.2.3", "1.2.3"), 0);
  assertEquals(compareVersions("0.87.1", "0.87.2")! < 0, true);
  assertEquals(compareVersions("0.100.0", "0.87.1")! > 0, true, "numeric, not lexicographic");
  assertEquals(compareVersions("1.2", "1.2.0"), 0, "missing components are zero");
  assertEquals(compareVersions("v1.2.3", "1.2.3"), 0, "a leading v is tolerated");
  assertEquals(compareVersions("not-a-version", "1.0.0"), null);
});
