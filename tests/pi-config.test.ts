/**
 * tests/pi-config.test.ts — Reading Pi's configuration.
 *
 * The subtle part, and the reason this is isolated and tested: `pi install <path>`
 * records a local package **relative to the settings file**, so the managed
 * extension appears as `"../../.my-pizza-team/pi-extension"`. Anything that compares
 * registrations must resolve them first — string matching would miss every
 * conflict, which is precisely the double-load hazard P2-4 exists to prevent
 * (duplicate tools and commands, two directive pollers, two heartbeats per agent).
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  EXTENSION_PACKAGE_NAME,
  findExtensionRegistrations,
  hasPackage,
  isProjectTrusted,
  packageSource,
  readPiSettings,
  resolveLocalPackage,
} from "../cli/pi-config.ts";

/** A throwaway Pi agent dir plus helpers to populate it. */
function fixture() {
  const root = Deno.makeTempDirSync({ prefix: "mpt-piconf-" });
  const agentDir = path.join(root, ".pi", "agent");
  Deno.mkdirSync(agentDir, { recursive: true });

  return {
    root,
    agentDir,
    /** Write settings.json with the given packages plus some unrelated user config. */
    settings(packages: Array<string | Record<string, unknown>>, extra: Record<string, unknown> = {}) {
      Deno.writeTextFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages, theme: "dark", defaultModel: "some-model", ...extra }, null, 2),
      );
    },
    trust(map: Record<string, boolean>) {
      Deno.writeTextFileSync(path.join(agentDir, "trust.json"), JSON.stringify(map, null, 2));
    },
    /** Create a package directory with a manifest. */
    pkg(relative: string, name = EXTENSION_PACKAGE_NAME) {
      const dir = path.join(root, relative);
      Deno.mkdirSync(dir, { recursive: true });
      Deno.writeTextFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.17.2" }));
      return dir;
    },
    cleanup() {
      try { Deno.removeSync(root, { recursive: true }); } catch { /* */ }
    },
  };
}

// ─── Settings reading ────────────────────────────────────────────────

Deno.test("a missing settings file reads as empty rather than throwing", () => {
  const f = fixture();
  try {
    const settings = readPiSettings(f.agentDir);
    assertEquals(settings.exists, false);
    assertEquals(settings.packages, []);
  } finally { f.cleanup(); }
});

Deno.test("unparseable settings are reported as existing, not silently empty", () => {
  // The distinction matters: overwriting a file we failed to parse would destroy
  // configuration we cannot read, so setup must be able to tell "absent" from
  // "present but broken".
  const f = fixture();
  try {
    Deno.writeTextFileSync(path.join(f.agentDir, "settings.json"), "{ not json");
    const settings = readPiSettings(f.agentDir);
    assertEquals(settings.exists, true);
    assertEquals(settings.packages, []);
  } finally { f.cleanup(); }
});

Deno.test("unrelated user settings are retained for round-tripping", () => {
  const f = fixture();
  try {
    f.settings(["npm:something"]);
    const settings = readPiSettings(f.agentDir);
    assertEquals(settings.raw.theme, "dark");
    assertEquals(settings.raw.defaultModel, "some-model");
  } finally { f.cleanup(); }
});

// ─── Entry resolution ────────────────────────────────────────────────

Deno.test("relative entries resolve from the settings directory, absolute ones stand", () => {
  const f = fixture();
  try {
    assertEquals(
      resolveLocalPackage("../../.my-pizza-team/pi-extension", f.agentDir),
      path.join(f.root, ".my-pizza-team", "pi-extension"),
    );
    assertEquals(resolveLocalPackage("/abs/path/ext", f.agentDir), path.resolve("/abs/path/ext"));
  } finally { f.cleanup(); }
});

Deno.test("npm, git, and URL sources are not treated as paths", () => {
  const f = fixture();
  try {
    for (const source of [
      "npm:@gotgenes/pi-permission-system",
      "git:github.com/x/y@v1",
      "https://github.com/x/y",
      "ssh://git.amazon.com/pkg/Thing",
    ]) {
      assertEquals(resolveLocalPackage(source, f.agentDir), null, source);
    }
  } finally { f.cleanup(); }
});

Deno.test("the object entry form is understood too", () => {
  // Pi allows { source, extensions: [...] } to narrow what loads.
  assertEquals(packageSource({ source: "./ext", extensions: ["a.ts"] }), "./ext");
  assertEquals(packageSource("./ext"), "./ext");
  assertEquals(packageSource({ notSource: 1 }), "");
});

// ─── Finding our own registrations ───────────────────────────────────

Deno.test("the managed directory is recognised through a relative entry", () => {
  // The case that string matching would miss.
  const f = fixture();
  try {
    const managedDir = f.pkg(path.join(".my-pizza-team", "pi-extension"));
    f.settings(["../../.my-pizza-team/pi-extension", "npm:pi-powerline-footer"]);

    const found = findExtensionRegistrations(readPiSettings(f.agentDir), { managedDir, agentDir: f.agentDir });
    assertEquals(found.length, 1);
    assertEquals(found[0]!.kind, "managed");
    assertEquals(found[0]!.resolvedPath, path.resolve(managedDir));
  } finally { f.cleanup(); }
});

Deno.test("a dev checkout is recognised as ours but distinct from the managed dir", () => {
  const f = fixture();
  try {
    const managedDir = path.join(f.root, ".my-pizza-team", "pi-extension");
    const devDir = f.pkg(path.join("code", "my-pizza-team", "harnesses", "pi"));
    f.settings([devDir]);

    const found = findExtensionRegistrations(readPiSettings(f.agentDir), { managedDir, agentDir: f.agentDir });
    assertEquals(found.length, 1);
    assertEquals(found[0]!.kind, "dev");
  } finally { f.cleanup(); }
});

Deno.test("both registered at once is what setup must detect — two entries, two identities", () => {
  // Registering both loads the extension twice: duplicate tools and commands, two
  // directive pollers, two heartbeats per agent.
  const f = fixture();
  try {
    const managedDir = f.pkg(path.join(".my-pizza-team", "pi-extension"));
    const devDir = f.pkg(path.join("code", "my-pizza-team", "harnesses", "pi"));
    f.settings(["../../.my-pizza-team/pi-extension", devDir]);

    const found = findExtensionRegistrations(readPiSettings(f.agentDir), { managedDir, agentDir: f.agentDir });
    assertEquals(found.map((r) => r.kind).sort(), ["dev", "managed"]);
  } finally { f.cleanup(); }
});

Deno.test("an entry pointing at a deleted directory is flagged as missing", () => {
  // The pre-1a `pi-pizza-team` path is exactly this: identified by path shape,
  // since a deleted directory has no manifest to read.
  const f = fixture();
  try {
    const managedDir = path.join(f.root, ".my-pizza-team", "pi-extension");
    f.settings([path.join(f.root, "gone", "pi-pizza-team")]);

    const found = findExtensionRegistrations(readPiSettings(f.agentDir), { managedDir, agentDir: f.agentDir });
    assertEquals(found.length, 1);
    assertEquals(found[0]!.kind, "missing");
  } finally { f.cleanup(); }
});

Deno.test("a pre-merge standalone checkout is told apart from a monorepo one", () => {
  // Both manifests say `pi-pizza-team`, so only the path distinguishes them. Worth
  // separating because the standalone repo is archived and the advice differs.
  const f = fixture();
  try {
    const managedDir = path.join(f.root, ".my-pizza-team", "pi-extension");
    const legacyDir = f.pkg(path.join("mpt-dev", "pi-pizza-team"));
    f.settings([legacyDir]);

    const found = findExtensionRegistrations(readPiSettings(f.agentDir), { managedDir, agentDir: f.agentDir });
    assertEquals(found.length, 1);
    assertEquals(found[0]!.kind, "legacy");
  } finally { f.cleanup(); }
});

Deno.test("somebody else's local package is left alone", () => {
  const f = fixture();
  try {
    const managedDir = path.join(f.root, ".my-pizza-team", "pi-extension");
    f.pkg("other-ext", "someone-elses-extension");
    f.settings([path.join(f.root, "other-ext")]);

    assertEquals(
      findExtensionRegistrations(readPiSettings(f.agentDir), { managedDir, agentDir: f.agentDir }),
      [],
      "only our own registrations may be touched",
    );
  } finally { f.cleanup(); }
});

// ─── Supporting checks ───────────────────────────────────────────────

Deno.test("hasPackage matches an npm source with or without a version", () => {
  const f = fixture();
  try {
    f.settings(["npm:@gotgenes/pi-permission-system@24.0.0", "npm:other"]);
    const settings = readPiSettings(f.agentDir);
    assertEquals(hasPackage(settings, "npm:@gotgenes/pi-permission-system"), true);
    assertEquals(hasPackage(settings, "npm:missing"), false);
  } finally { f.cleanup(); }
});

Deno.test("trust covers a folder and its descendants, and nothing else", () => {
  // Pi blocks startup in an untrusted folder, and a spawned teammate inherits the
  // problem — so doctor needs this exactly right.
  const f = fixture();
  try {
    const projects = path.join(f.root, "projects");
    f.trust({ [projects]: true, [path.join(f.root, "revoked")]: false });

    assertEquals(isProjectTrusted(projects, f.agentDir), true);
    assertEquals(isProjectTrusted(path.join(projects, "nested", "repo"), f.agentDir), true);
    assertEquals(isProjectTrusted(path.join(f.root, "revoked"), f.agentDir), false, "explicit false is not trust");
    assertEquals(isProjectTrusted(path.join(f.root, "elsewhere"), f.agentDir), false);
    // A sibling sharing a name prefix must not count as a descendant.
    assertEquals(isProjectTrusted(`${projects}-other`, f.agentDir), false);
  } finally { f.cleanup(); }
});

Deno.test("no trust file means nothing is trusted", () => {
  const f = fixture();
  try {
    assertEquals(isProjectTrusted(f.root, f.agentDir), false);
  } finally { f.cleanup(); }
});
