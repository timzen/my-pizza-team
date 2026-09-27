/**
 * tests/doctor-coherence.test.ts — `mpt doctor`'s checks agree with each other (P5-4).
 *
 * The per-check tests in tests/doctor.test.ts are each correct. They missed a real bug
 * anyway: doctor printed "no leader connected — **nothing will spawn teammates**"
 * directly above "Spawning: daemon-driven", moments after the daemon had spawned one.
 * Two individually-correct checks disagreed, and no test looked at more than one
 * check at a time.
 *
 * So this enumerates *every* combination of the facts that interact, and asserts
 * properties of the whole checklist rather than any single entry. It is pure — no
 * daemon, no Pi — so exhaustive enumeration is cheap.
 */

import { assertEquals } from "@std/assert";
import { type Check, type DoctorFacts, evaluate, report, TESTED_PI_VERSION } from "../cli/doctor.ts";

/** The facts that interact with each other, each over the values that matter. */
const DIMENSIONS = {
  piVersion: [null, "0.50.0", TESTED_PI_VERSION, "99.0.0"],
  tmuxPresent: [true, false],
  daemonRunning: [true, false],
  leaderConnected: [true, false, null],
  spawning: [
    null,
    { canSpawn: true },
    { canSpawn: false, reason: "tmux is not on this process's PATH", fix: "install tmux" },
  ],
  registrationKind: [null, "managed", "dev", "legacy", "missing", "double"],
  permissionSystemInstalled: [true, false],
  projectTrusted: [true, false],
  teamDirState: ["configured", "present", "absent"],
} as const;

type Combo = { [K in keyof typeof DIMENSIONS]: (typeof DIMENSIONS)[K][number] };

function* combinations(): Generator<Combo> {
  const keys = Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>;
  const walk = function* (i: number, acc: Partial<Combo>): Generator<Combo> {
    if (i === keys.length) {
      yield acc as Combo;
      return;
    }
    for (const v of DIMENSIONS[keys[i]!]) yield* walk(i + 1, { ...acc, [keys[i]!]: v });
  };
  yield* walk(0, {});
}

/** Build facts from a combination. Some combinations are unreachable; they are skipped. */
function toFacts(c: Combo): DoctorFacts | null {
  // A leader can only be reported connected or not by a running daemon.
  if (!c.daemonRunning && c.leaderConnected !== null) return null;
  if (c.daemonRunning && c.leaderConnected === null) return null;
  if (!c.daemonRunning && c.spawning !== null) return null;

  const reg = (kind: string, p: string) => ({ entry: p, source: p, resolvedPath: p, kind: kind as never });
  const registrations = c.registrationKind === null
    ? []
    : c.registrationKind === "double"
    ? [reg("managed", "/h/.my-pizza-team/pi-extension"), reg("dev", "/code/harnesses/pi")]
    : [reg(c.registrationKind, `/somewhere/${c.registrationKind}`)];

  return {
    piVersion: c.piVersion,
    tmuxPresent: c.tmuxPresent,
    daemonVersion: "0.17.2",
    bundledExtensionVersion: "0.17.2",
    registrations,
    managedDir: "/h/.my-pizza-team/pi-extension",
    managedDirVersion: c.registrationKind === "managed" ? "0.17.2" : null,
    permissionSystemInstalled: c.permissionSystemInstalled,
    settingsPath: "/h/.pi/agent/settings.json",
    settingsReadable: true,
    teamDir: "/w/p/.my-pizza-team",
    teamDirPresent: c.teamDirState !== "absent",
    teamDirExists: c.teamDirState === "configured",
    projectTrusted: c.projectTrusted,
    daemonRunning: c.daemonRunning,
    leaderConnected: c.leaderConnected,
    spawning: c.spawning as DoctorFacts["spawning"],
    serviceInstalled: true,
    githubTokenSet: true,
  };
}

function allChecklists(): Array<{ combo: Combo; checks: Check[] }> {
  const out: Array<{ combo: Combo; checks: Check[] }> = [];
  for (const combo of combinations()) {
    const facts = toFacts(combo);
    if (facts) out.push({ combo, checks: evaluate(facts) });
  }
  return out;
}

const CHECKLISTS = allChecklists();
const describe = (c: Combo) => JSON.stringify(c);

Deno.test("the enumeration is large enough to mean something", () => {
  // A property that holds over three cases proves little; guard against the space
  // quietly collapsing (e.g. a toFacts filter rejecting almost everything).
  assertEquals(CHECKLISTS.length > 1000, true, `only ${CHECKLISTS.length} reachable combinations`);
});

// ─── Properties ──────────────────────────────────────────────────────

Deno.test("no two checks contradict each other about spawning", () => {
  // The bug that motivated this file.
  for (const { combo, checks } of CHECKLISTS) {
    const spawning = checks.find((c) => c.name === "Spawning");
    const leader = checks.find((c) => c.name === "Leader");
    if (!spawning || !leader) continue;

    const daemonSpawns = spawning.status === "ok" && spawning.detail.includes("daemon-driven");
    const claimsNothingSpawns = leader.detail.includes("nothing will spawn");
    assertEquals(
      daemonSpawns && claimsNothingSpawns,
      false,
      `doctor says both "daemon-driven" and "nothing will spawn": ${describe(combo)}`,
    );
  }
});

Deno.test("a leader check never appears without a running daemon to report it", () => {
  // Two symptoms of one cause is the noise DESIGN.md "Setup Is One Command" complains about.
  for (const { combo, checks } of CHECKLISTS) {
    if (combo.daemonRunning) continue;
    const named = checks.map((c) => c.name);
    assertEquals(named.includes("Leader"), false, `leader reported with the daemon down: ${describe(combo)}`);
    assertEquals(named.includes("Spawning"), false, `spawning reported with the daemon down: ${describe(combo)}`);
  }
});

Deno.test("every non-ok check names a fix, in every combination", () => {
  // A problem without a next step is noise — DESIGN.md "Setup Is One Command" section's whole complaint.
  for (const { combo, checks } of CHECKLISTS) {
    for (const c of checks) {
      if (c.status === "ok") continue;
      assertEquals(Boolean(c.fix && c.fix.length > 0), true, `${c.name} (${c.status}) has no fix: ${describe(combo)}`);
    }
  }
});

Deno.test("each check appears at most once", () => {
  // Two "Extension" lines would be two answers to one question.
  for (const { combo, checks } of CHECKLISTS) {
    const names = checks.map((c) => c.name);
    assertEquals(names.length, new Set(names).size, `duplicate check names ${names}: ${describe(combo)}`);
  }
});

Deno.test("the exit code follows failures and only failures", () => {
  const original = console.log;
  console.log = () => {};
  try {
    for (const { combo, checks } of CHECKLISTS) {
      const failed = checks.some((c) => c.status === "fail");
      assertEquals(report(checks), failed ? 1 : 0, `exit code wrong: ${describe(combo)}`);
    }
  } finally {
    console.log = original;
  }
});

Deno.test("a double registration always fails, whatever else is true", () => {
  // The double load is silent in practice, so it must never be downgraded.
  for (const { combo, checks } of CHECKLISTS) {
    if (combo.registrationKind !== "double") continue;
    assertEquals(checks.find((c) => c.name === "Extension")?.status, "fail", describe(combo));
  }
});

Deno.test("an older-than-tested Pi warns and never fails", () => {
  // There is no extension-API version to negotiate, so blocking would be a guess.
  for (const { combo, checks } of CHECKLISTS) {
    if (combo.piVersion !== "0.50.0") continue;
    assertEquals(checks.find((c) => c.name === "Pi")?.status, "warn", describe(combo));
  }
});
