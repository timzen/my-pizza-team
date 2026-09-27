/**
 * tests/setup.test.ts — `mpt setup`'s planning and settings mutation.
 *
 * The planner is where the double-load hazard is either prevented or not. Pi
 * identifies a local package by resolved path, so two registrations are two packages
 * and the extension loads **twice**: duplicate tools and commands, two directive
 * pollers, two heartbeats per agent (docs/DESIGN.md DESIGN.md "One Protocol, One Version"). None of that
 * announces itself, so the rules are asserted rather than assumed.
 *
 * The mutation tests exist for a different reason: this edits the *user's* Pi
 * configuration. Dropping someone's `defaultModel` while installing an extension
 * would be unforgivable, so round-tripping is tested explicitly.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { existsSync } from "@std/fs";
import type { ExtensionRegistration, RegistrationKind } from "../cli/pi-config.ts";
import { isProjectTrusted, readPiSettings, resolveLocalPackage } from "../cli/pi-config.ts";
import {
  type Action,
  applyPackageChanges,
  isNoOp,
  manifestPath,
  planSetup,
  readManifest,
  type SetupPlan,
  trustProject,
  writeManifest,
  writePiSettingsFile,
} from "../cli/setup.ts";

const MANAGED = "/home/u/.my-pizza-team/pi-extension";

function reg(kind: RegistrationKind, resolvedPath: string, source = resolvedPath): ExtensionRegistration {
  return { entry: source, source, resolvedPath, kind };
}

function plan(over: Partial<Parameters<typeof planSetup>[0]> = {}): SetupPlan {
  return planSetup({
    registrations: [],
    managedDir: MANAGED,
    settingsReadable: true,
    bundledExtensionAvailable: true,
    teamDirConfigured: true,
    projectTrusted: true,
    teamDir: "/work/p/.my-pizza-team",
    projectDir: "/work/p",
    ...over,
  });
}

const kinds = (p: SetupPlan) => p.actions.map((a) => a.kind);
const unregistered = (p: SetupPlan) =>
  p.actions.filter((a): a is Extract<Action, { kind: "unregister" }> => a.kind === "unregister");

// ─── Blockers ────────────────────────────────────────────────────────

Deno.test("unparseable Pi settings block setup rather than being overwritten", () => {
  const p = plan({ settingsReadable: false });
  assertEquals(p.blockers.length, 1);
  assertStringIncludes(p.blockers[0]!, "will not overwrite");
});

Deno.test("a missing bundled extension blocks setup", () => {
  // Writing nothing and registering a path would leave Pi pointed at an empty dir.
  const p = plan({ bundledExtensionAvailable: false });
  assertEquals(p.blockers.length, 1);
  assertStringIncludes(p.blockers[0]!, "MPT_PI_EXTENSION");
});

// ─── First run ───────────────────────────────────────────────────────

Deno.test("a fresh machine writes, registers, creates the team dir, and trusts the project", () => {
  const p = plan({ teamDirConfigured: false, projectTrusted: false });
  assertEquals(kinds(p), ["write-extension", "register-extension", "create-team-dir", "trust-project"]);
  assertEquals(p.blockers, []);
});

Deno.test("an already-correct machine still rewrites the extension but re-registers nothing", () => {
  // Rewriting is how an upgrade takes effect — Pi loads from the path without
  // copying, so writing the directory *is* the upgrade.
  const p = plan({ registrations: [reg("managed", MANAGED, "../../.my-pizza-team/pi-extension")] });
  assertEquals(kinds(p), ["write-extension"]);
  assertEquals(p.respected, [`already registered at ${MANAGED}`]);
});

// ─── Conflict resolution (P2-4) ──────────────────────────────────────

Deno.test("managed + dev registered together: the dev checkout wins and managed is unregistered", () => {
  // Replacing a checkout someone is editing would make their changes stop taking
  // effect with no indication why. Setup steps aside instead — but it must still
  // remove its own entry, or Pi loads the extension twice.
  const p = plan({
    registrations: [reg("managed", MANAGED), reg("dev", "/code/mpt/harnesses/pi")],
  });
  assertEquals(kinds(p), ["unregister"]);
  assertEquals(unregistered(p)[0]!.resolvedPath, MANAGED);
  assertStringIncludes(unregistered(p)[0]!.because, "development checkout is registered");
  assertStringIncludes(p.respected.join(" "), "/code/mpt/harnesses/pi");
});

Deno.test("a dev checkout alone leaves the registration completely untouched", () => {
  const p = plan({ registrations: [reg("dev", "/code/mpt/harnesses/pi")] });
  assertEquals(kinds(p), [], "nothing to do — and notably no write-extension");
  assertStringIncludes(p.respected.join(" "), "left untouched on disk");
  assertEquals(isNoOp(p), true);
});

Deno.test("a legacy standalone checkout is unregistered and replaced by the managed copy", () => {
  // Tim's actual machine: the pre-merge repo is archived, and the extension now
  // ships inside mpt.
  const p = plan({ registrations: [reg("legacy", "/Users/t/mpt-dev/pi-pizza-team")] });
  assertEquals(kinds(p), ["unregister", "write-extension", "register-extension"]);
  assertStringIncludes(unregistered(p)[0]!.because, "archived");
});

Deno.test("a registration pointing at a deleted directory is unregistered", () => {
  const p = plan({ registrations: [reg("missing", "/gone/pi-extension")] });
  assertEquals(kinds(p), ["unregister", "write-extension", "register-extension"]);
  assertStringIncludes(unregistered(p)[0]!.because, "no longer exists");
});

Deno.test("several stale registrations are all removed, leaving exactly one", () => {
  // The invariant that matters: after setup, exactly one of our registrations.
  const p = plan({
    registrations: [
      reg("legacy", "/Users/t/mpt-dev/pi-pizza-team"),
      reg("missing", "/gone/pi-extension"),
      reg("managed", MANAGED),
    ],
  });
  assertEquals(unregistered(p).map((a) => a.resolvedPath).sort(), ["/Users/t/mpt-dev/pi-pizza-team", "/gone/pi-extension"]);
  assertEquals(kinds(p).filter((k) => k === "register-extension"), [], "managed is already registered");
  assertEquals(kinds(p).includes("write-extension"), true);
});

Deno.test("every unregister carries a reason, so the change is explainable", () => {
  for (const kind of ["legacy", "missing", "managed"] as RegistrationKind[]) {
    const registrations = kind === "managed"
      ? [reg("managed", MANAGED), reg("dev", "/code/mpt/harnesses/pi")]
      : [reg(kind, "/somewhere/else")];
    for (const action of unregistered(plan({ registrations }))) {
      assertEquals(action.because.length > 0, true, `${kind} unregister has no reason`);
    }
  }
});

// ─── Settings mutation ───────────────────────────────────────────────

function agentFixture() {
  const root = Deno.makeTempDirSync({ prefix: "mpt-setup-" });
  const agentDir = path.join(root, ".pi", "agent");
  Deno.mkdirSync(agentDir, { recursive: true });
  return { root, agentDir, cleanup: () => { try { Deno.removeSync(root, { recursive: true }); } catch { /* */ } } };
}

Deno.test("unrelated settings survive a package change", () => {
  const f = agentFixture();
  try {
    Deno.writeTextFileSync(
      path.join(f.agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:keep-me", "/old/pi-pizza-team"],
        defaultModel: "anthropic/claude",
        theme: "dark",
        lastChangelogVersion: "0.87.1",
      }),
    );

    const before = readPiSettings(f.agentDir);
    const { raw, removed, added } = applyPackageChanges(before, {
      remove: ["/old/pi-pizza-team"],
      addLocalPath: path.join(f.root, ".my-pizza-team", "pi-extension"),
      agentDir: f.agentDir,
    });
    writePiSettingsFile(f.agentDir, raw);

    const after = readPiSettings(f.agentDir);
    assertEquals(after.raw.defaultModel, "anthropic/claude", "a user's model choice must survive");
    assertEquals(after.raw.theme, "dark");
    assertEquals(after.raw.lastChangelogVersion, "0.87.1");
    assertEquals(after.packages.includes("npm:keep-me"), true, "other packages must survive");
    assertEquals(after.packages.includes("/old/pi-pizza-team"), false);
    assertEquals(removed, ["/old/pi-pizza-team"]);
    assertEquals(added.length, 1);
  } finally { f.cleanup(); }
});

Deno.test("the added entry is relative to the settings file, matching Pi's own convention", () => {
  // Pi rewrites local paths this way itself, so recording them the same keeps the
  // file stable and the entry portable if the home directory moves.
  const f = agentFixture();
  try {
    Deno.writeTextFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    const managed = path.join(f.root, ".my-pizza-team", "pi-extension");
    const { raw, added } = applyPackageChanges(readPiSettings(f.agentDir), {
      remove: [],
      addLocalPath: managed,
      agentDir: f.agentDir,
    });
    assertEquals(added, ["../../.my-pizza-team/pi-extension"]);
    writePiSettingsFile(f.agentDir, raw);

    // And it resolves back to the directory we meant.
    assertEquals(resolveLocalPackage(added[0]!, f.agentDir), path.resolve(managed));
  } finally { f.cleanup(); }
});

Deno.test("adding the same path twice does not duplicate the entry", () => {
  const f = agentFixture();
  try {
    const managed = path.join(f.root, ".my-pizza-team", "pi-extension");
    Deno.writeTextFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    for (let i = 0; i < 2; i++) {
      const { raw } = applyPackageChanges(readPiSettings(f.agentDir), {
        remove: [],
        addLocalPath: managed,
        agentDir: f.agentDir,
      });
      writePiSettingsFile(f.agentDir, raw);
    }
    assertEquals(readPiSettings(f.agentDir).packages.length, 1);
  } finally { f.cleanup(); }
});

Deno.test("settings are written atomically, leaving no temp file behind", () => {
  const f = agentFixture();
  try {
    writePiSettingsFile(f.agentDir, { packages: ["npm:x"] });
    const leftovers = [...Deno.readDirSync(f.agentDir)].map((e) => e.name).filter((n) => n.includes("mpt-tmp"));
    assertEquals(leftovers, []);
    assertEquals(readPiSettings(f.agentDir).packages, ["npm:x"]);
  } finally { f.cleanup(); }
});

// ─── Trust ───────────────────────────────────────────────────────────

Deno.test("trusting a project preserves existing trust entries", () => {
  const f = agentFixture();
  try {
    Deno.writeTextFileSync(
      path.join(f.agentDir, "trust.json"),
      JSON.stringify({ "/somewhere/else": true, "/revoked": false }),
    );
    trustProject(f.agentDir, "/work/project");

    assertEquals(isProjectTrusted("/work/project", f.agentDir), true);
    assertEquals(isProjectTrusted("/somewhere/else", f.agentDir), true, "existing trust must survive");
    assertEquals(isProjectTrusted("/revoked", f.agentDir), false, "a revocation must not be flipped");
  } finally { f.cleanup(); }
});

Deno.test("trusting works with no trust file yet", () => {
  const f = agentFixture();
  try {
    trustProject(f.agentDir, "/work/project");
    assertEquals(isProjectTrusted("/work/project", f.agentDir), true);
  } finally { f.cleanup(); }
});

// ─── Manifest ────────────────────────────────────────────────────────

Deno.test("the manifest round-trips, and is null rather than throwing on junk", () => {
  // Uninstall relies on this to undo exactly what setup did — guessing at someone
  // else's settings file is how you delete a registration they added themselves.
  const f = agentFixture();
  try {
    const file = manifestPath(f.root);
    assertEquals(readManifest(file), null, "absent");

    writeManifest(file, {
      at: "2026-01-01T00:00:00.000Z",
      version: "0.17.2",
      agentDir: f.agentDir,
      addedPackages: ["../../.my-pizza-team/pi-extension"],
      removedPackages: ["/old/pi-pizza-team"],
      managedDir: path.join(f.root, ".my-pizza-team", "pi-extension"),
      trustedProjects: ["/work/project"],
    });
    assertEquals(existsSync(file), true);

    const read = readManifest(file)!;
    assertEquals(read.addedPackages, ["../../.my-pizza-team/pi-extension"]);
    assertEquals(read.removedPackages, ["/old/pi-pizza-team"]);
    assertEquals(read.trustedProjects, ["/work/project"]);

    Deno.writeTextFileSync(file, "{ not json");
    assertEquals(readManifest(file), null, "unparseable");
  } finally { f.cleanup(); }
});
