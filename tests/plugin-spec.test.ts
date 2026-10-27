/**
 * tests/plugin-spec.test.ts — Plugin package specs (daemon/plugins/spec.ts) and
 * per-source settings (`SourceContext.options()`).
 * See TODO.md "Work Sources as plugins — package loading".
 *
 * Covers: every spec form (npm with/without scope and version, git shorthand,
 * https and ssh URLs with and without refs, local paths: absolute, ./, ../, ~/),
 * identities (equivalent declarations collapse), bad input as a returned error,
 * `parsePackageEntries` (object form, config, dedupe, non-array), and that a
 * registered source sees its `options` through its context (built-ins get `{}`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { type PackageSpec, parsePackageEntries, parsePackageSpec } from "../daemon/plugins/spec.ts";
import { Store } from "../daemon/store.ts";
import type { SourceContext, WorkSource } from "../daemon/sources/types.ts";

const TEAM = "/teams/alpha";

/** Parse, asserting it's valid. */
function ok(raw: string): PackageSpec {
  const r = parsePackageSpec(raw, TEAM);
  if (!r.ok) throw new Error(`expected ${raw} to parse: ${r.error}`);
  return r.spec;
}

/** Parse, asserting it's rejected; returns the error. */
function bad(raw: string): string {
  const r = parsePackageSpec(raw, TEAM);
  if (r.ok) throw new Error(`expected ${raw} to be rejected, got ${JSON.stringify(r.spec)}`);
  return r.error;
}

test("npm specs: name, scope, version; identity is the name", () => {
  assertEquals(ok("npm:mpt-jira"), { kind: "npm", raw: "npm:mpt-jira", name: "mpt-jira", identity: "mpt-jira" });
  assertEquals(ok("npm:mpt-jira@1.2.0"), { kind: "npm", raw: "npm:mpt-jira@1.2.0", name: "mpt-jira", version: "1.2.0", identity: "mpt-jira" });
  const scoped = ok("npm:@acme/mpt-jira@^2");
  assertEquals(scoped, { kind: "npm", raw: "npm:@acme/mpt-jira@^2", name: "@acme/mpt-jira", version: "^2", identity: "@acme/mpt-jira" });
  assertEquals(ok("npm:@acme/mpt-jira").identity, "@acme/mpt-jira");
});

test("npm specs: bad names and versions are errors", () => {
  assertStringIncludes(bad("npm:"), "needs a package name");
  assertStringIncludes(bad("npm:Bad_Name"), "not a valid npm package name");
  assertStringIncludes(bad("npm:@acme"), "not a valid npm package name");
  assertStringIncludes(bad("npm:mpt-jira@"), "version");
});

test("git specs: shorthand, https, ssh, with and without a ref", () => {
  assertEquals(ok("git:github.com/acme/mpt-jira"), {
    kind: "git", raw: "git:github.com/acme/mpt-jira", url: "https://github.com/acme/mpt-jira", identity: "https://github.com/acme/mpt-jira",
  });
  const tagged = ok("git:github.com/acme/mpt-jira@v1.0.0");
  assert(tagged.kind === "git");
  assertEquals(tagged.url, "https://github.com/acme/mpt-jira");
  assertEquals(tagged.ref, "v1.0.0");

  const https = ok("https://github.com/acme/mpt-jira.git@main");
  assert(https.kind === "git");
  assertEquals(https.url, "https://github.com/acme/mpt-jira.git");
  assertEquals(https.ref, "main");
  assertEquals(https.identity, "https://github.com/acme/mpt-jira");

  // The authority's `user@` is not a ref separator.
  const ssh = ok("ssh://git@github.com/acme/mpt-jira");
  assert(ssh.kind === "git");
  assertEquals(ssh.url, "ssh://git@github.com/acme/mpt-jira");
  assertEquals(ssh.ref, undefined);
  const sshRef = ok("ssh://git@github.com/acme/mpt-jira.git@0123abc");
  assert(sshRef.kind === "git");
  assertEquals(sshRef.url, "ssh://git@github.com/acme/mpt-jira.git");
  assertEquals(sshRef.ref, "0123abc");
  assertEquals(sshRef.identity, "ssh://git@github.com/acme/mpt-jira");
});

test("git specs: identity ignores the ref and a .git suffix, so equivalent declarations match", () => {
  const ids = ["git:github.com/acme/x", "git:github.com/acme/x@v2", "https://github.com/acme/x.git", "https://github.com/acme/x/@main"]
    .map((s) => ok(s).identity);
  assertEquals(new Set(ids).size, 1);
});

test("git specs: malformed input is an error", () => {
  assertStringIncludes(bad("git:github.com"), "<host>/<path>");
  assertStringIncludes(bad("git://github.com/acme/x"), "no slashes before the host");
  assertStringIncludes(bad("git:github.com/acme/x@"), "ref after @ is empty");
  assertStringIncludes(bad("git:github.com/acme/x@-upload-pack=evil"), "not a valid git ref");
  assertStringIncludes(bad("https://github.com"), "host and a repository path");
  assertStringIncludes(bad("https:///acme/x"), "host and a repository path");
  assertStringIncludes(bad("ssh://git@github.com/"), "repository path");
});

test("local specs: absolute, ./, ../, ~/ — resolved against the team dir", () => {
  assertEquals(ok("/opt/plugins/demo"), { kind: "local", raw: "/opt/plugins/demo", path: "/opt/plugins/demo", identity: "/opt/plugins/demo" });
  assertEquals(ok("./plugins/demo").identity, "/teams/alpha/plugins/demo");
  assertEquals(ok("../shared/demo").identity, "/teams/shared/demo");
  assertEquals(ok("~/mpt/demo").identity, path.join(os.homedir(), "mpt/demo"));
  // Equivalent paths share one identity.
  assertEquals(ok("./plugins/../plugins/demo/").identity, ok("/teams/alpha/plugins/demo").identity);
});

test("unrecognized and empty specs are errors, not throws", () => {
  assertStringIncludes(bad("mpt-jira"), "expected npm:");
  assertStringIncludes(bad("git@github.com:acme/x"), "expected npm:");
  assertStringIncludes(bad("http://example.com/acme/x"), "expected npm:");
  assertStringIncludes(bad("   "), "empty");
  assertStringIncludes(bad("mpt-jira"), "Invalid package spec \"mpt-jira\"");
  const r = parsePackageSpec(42 as unknown as string, TEAM);
  assert(!r.ok);
});

test("parsePackageEntries: strings and { source, config }; config defaults to {}", () => {
  const { packages, errors } = parsePackageEntries([
    "npm:mpt-jira@1",
    { source: "./plugins/demo", config: { dir: "items", tokenEnv: "DEMO_TOKEN" } },
    { source: "git:github.com/acme/x@v1" },
  ], TEAM);
  assertEquals(errors, []);
  assertEquals(packages.map((p) => p.spec.kind), ["npm", "local", "git"]);
  assertEquals(packages.map((p) => p.config), [{}, { dir: "items", tokenEnv: "DEMO_TOKEN" }, {}]);
  assertEquals(packages[1]?.spec.identity, "/teams/alpha/plugins/demo");
});

test("parsePackageEntries: bad entries and duplicates are reported and skipped; the rest load", () => {
  const { packages, errors, rejected } = parsePackageEntries([
    "npm:mpt-jira@1",
    "nonsense",
    { source: 7 },
    { source: "npm:ok-one", config: ["not", "an", "object"] },
    null,
    "npm:mpt-jira@2",
    "./a",
    "/teams/alpha/a",
  ], TEAM);
  assertEquals(packages.map((p) => p.spec.raw), ["npm:mpt-jira@1", "./a"]);
  assertEquals(errors.length, 6);
  assertStringIncludes(errors[0] ?? "", "\"nonsense\"");
  assertStringIncludes(errors[1] ?? "", "expected a spec string or");
  assertStringIncludes(errors[2] ?? "", "\"config\" must be an object");
  assertStringIncludes(errors[3] ?? "", "expected a spec string or");
  assertStringIncludes(errors[4] ?? "", "Duplicate package \"npm:mpt-jira@2\"");
  assertStringIncludes(errors[5] ?? "", "Duplicate package \"/teams/alpha/a\"");
  // The structured form carries what was written and, for a duplicate, the shared identity.
  assertEquals(rejected.map((r) => r.raw), ["nonsense", "{\"source\":7}", "npm:ok-one", "null", "npm:mpt-jira@2", "/teams/alpha/a"]);
  assertEquals(rejected.map((r) => r.identity), [undefined, undefined, undefined, undefined, "mpt-jira", "/teams/alpha/a"]);
  assertEquals(rejected.map((r) => r.error), errors);
});

test("parsePackageEntries: absent is empty; a non-array is one error", () => {
  assertEquals(parsePackageEntries(undefined, TEAM), { packages: [], errors: [], rejected: [] });
  const r = parsePackageEntries("npm:mpt-jira", TEAM);
  assertEquals(r.packages, []);
  assertEquals(r.errors.length, 1);
});

test("SourceContext.options(): a registered source sees its settings; built-ins get {}", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugin-spec-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, TEST_CONFIG);
  try {
    let seen: SourceContext | null = null;
    const source: WorkSource = { id: "demo", apiVersion: 1, init: (ctx) => { seen = ctx; } };
    const settings = { dir: "items", tokenEnv: "DEMO_TOKEN" };
    store.registerWorkSource(source, { options: settings });
    const ctx = seen as SourceContext | null;
    assert(ctx);
    assertEquals(ctx.options(), { dir: "items", tokenEnv: "DEMO_TOKEN" });
    // A copy, frozen: neither the caller nor the source can change what's seen later.
    settings.dir = "changed";
    assertEquals(ctx.options().dir, "items");
    assert(Object.isFrozen(ctx.options()));
    assertThrows(() => { (ctx.options() as Record<string, unknown>).dir = "x"; });

    // Without options (and for every built-in): {}.
    store.registerWorkSource({ id: "plain", apiVersion: 1 });
    assertEquals(store.listWorkSources().find((e) => e.source.id === "plain")?.ctx.options(), {});
    for (const e of store.listWorkSources().filter((e) => !["demo", "plain"].includes(e.source.id))) {
      assertEquals(e.ctx.options(), {});
    }
  } finally {
    store.close();
    fs.rmSync(teamDir, { recursive: true, force: true });
  }
});
