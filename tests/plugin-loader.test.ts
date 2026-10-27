/**
 * tests/plugin-loader.test.ts — Loading plugin packages' Work Sources
 * (daemon/plugins/loader.ts). See docs/DESIGN.md "Plugin packages".
 *
 * Every plugin here is a throwaway local-path package in a temp dir with a
 * plain `.js` entry, so nothing is installed. Covers: a plugin that loads and
 * syncs (its `config` as `ctx.options()`); object vs factory default exports;
 * each failure — bad apiVersion, missing manifest, throwing import, throwing
 * factory, duplicate identity, duplicate source id, not installed, an entry
 * outside the package, a hanging import — logged and skipped while the rest
 * load; `my-pizza-team/plugin` resolving to the host's copy (even over a
 * plugin's own); the install layout; the daemon starting with a broken plugin and
 * reporting it on `GET /api/work-sources`; and install-on-start (a missing npm
 * package installed through a fake runner, a failing one isolated and reported).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { createApp } from "../daemon/app.ts";
import { loadPlugins, packageInstallDir } from "../daemon/plugins/loader.ts";
import { SOURCE_ID_PATTERN } from "../daemon/sources/registry.ts";
import { WORK_SOURCE_API_VERSION } from "../daemon/sources/types.ts";
import { parsePackageSpec, type PackageSpec } from "../daemon/plugins/spec.ts";
import type { PackageEntry } from "../shared/types.ts";
import type { WorkSourcesResponse } from "../shared/protocol.ts";

/** A plugin source module whose default export is an external source object with this id. */
const objectSource = (id: string, apiVersion = 1) => `
export default {
  id: ${JSON.stringify(id)}, label: "Demo ${id}", apiVersion: ${apiVersion},
  syncEveryMs: () => null,
  async sync(ctx) {
    return [{ externalId: "one", title: "One", goal: "greeting: " + String(ctx.options().greeting ?? "none"), revision: "r1" }];
  },
};
`;

/** Write a local plugin package at `<root>/<name>`: a package.json (with `mpt`, unless null) and its files. */
function writePlugin(root: string, name: string, mpt: unknown, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const pkg: Record<string, unknown> = { name, version: "1.0.0", type: "module" };
  if (mpt !== null) pkg.mpt = mpt;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

interface Env {
  teamDir: string;
  store: Store;
  logs: string[];
}

function setup(): Env {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugin-loader-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  return { teamDir, store: new Store(teamDir, TEST_CONFIG), logs: [] };
}

function cleanup({ store, teamDir }: Env): void {
  store.close();
  try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Load `packages` into the env's store, collecting log lines. */
function load(env: Env, packages: PackageEntry[], timeoutMs?: number) {
  return loadPlugins(env.store, { packages }, env.teamDir, { log: (m) => env.logs.push(m), timeoutMs });
}

const spec = (raw: string, teamDir = "/teams/alpha"): PackageSpec => {
  const r = parsePackageSpec(raw, teamDir);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
};

test("a local plugin with a .js entry loads, gets its config as ctx.options(), and syncs", async () => {
  const env = setup();
  try {
    writePlugin(env.teamDir, "demo", { sources: ["./dist/index.js"], futureKind: ["ignored"] }, { "dist/index.js": objectSource("demo") });
    const statuses = await load(env, [{ source: "./demo", config: { greeting: "hello" } }]);
    assertEquals(statuses, [{ identity: path.join(env.teamDir, "demo"), spec: "./demo", state: "loaded", sources: ["demo"] }]);
    assertEquals(env.store.listExternalSources().map((e) => e.source.id), ["demo"]);
    assertStringIncludes(env.logs[0] ?? "", "loaded");

    const outcome = await env.store.syncWorkSource("demo");
    assert(outcome.ok, JSON.stringify(outcome));
    const mirrored = env.store.getWorkDefs().filter((d) => d.parent?.kind === "external" && d.parent.source === "demo");
    assertEquals(mirrored.length, 1);
    assertEquals(mirrored[0]!.goal, "greeting: hello");
  } finally {
    cleanup(env);
  }
});

test("a factory default export gets (options, { teamDir }); async factories and several entries work", async () => {
  const env = setup();
  try {
    writePlugin(env.teamDir, "multi", { sources: ["./a.js", "./b.js"] }, {
      "a.js": `
        export default (options, { teamDir }) => ({
          id: "fact-a", label: options.label + "@" + teamDir, apiVersion: 1, tick() {},
        });`,
      "b.js": `export default async (options) => { await Promise.resolve(); return { id: "fact-b", apiVersion: 1 }; };`,
    });
    const statuses = await load(env, [{ source: "./multi", config: { label: "L" } }]);
    assertEquals(statuses[0]?.state, "loaded");
    assertEquals(statuses[0]?.sources, ["fact-a", "fact-b"]);
    const a = env.store.listWorkSources().find((e) => e.source.id === "fact-a")!;
    assertEquals(a.source.label, `L@${env.teamDir}`);
    assertEquals(a.ctx.options(), { label: "L" });
  } finally {
    cleanup(env);
  }
});

test("a plugin's `my-pizza-team/plugin` import resolves to the host's copy, even over its own", async () => {
  const env = setup();
  const g = globalThis as { __mptHostSurface?: Record<string, unknown>; __mptShadowSurface?: Record<string, unknown> };
  try {
    // Installs nothing: only the daemon's resolve hook can answer the specifier.
    const entry = (slot: string, id: string) => `
      import * as host from "my-pizza-team/plugin";
      import { WORK_SOURCE_API_VERSION } from "my-pizza-team/plugin";
      globalThis.${slot} = host;
      export default { id: ${JSON.stringify(id)}, apiVersion: WORK_SOURCE_API_VERSION };`;
    writePlugin(env.teamDir, "hosted", { sources: ["./dist/index.js"] }, { "dist/index.js": entry("__mptHostSurface", "hosted") });
    // A plugin that did install its own (stale) copy still gets the host's.
    writePlugin(env.teamDir, "shadowed", { sources: ["./index.js"] }, {
      "index.js": entry("__mptShadowSurface", "shadowed"),
      "node_modules/my-pizza-team/package.json": JSON.stringify({
        name: "my-pizza-team", type: "module", exports: { "./plugin": "./plugin.js" },
      }),
      "node_modules/my-pizza-team/plugin.js": `export const WORK_SOURCE_API_VERSION = 99; export const SOURCE_ID_PATTERN = /stale/;`,
    });

    const statuses = await load(env, ["./hosted", "./shadowed"]);
    assertEquals(statuses.map((s) => [s.state, s.error]), [["loaded", undefined], ["loaded", undefined]]);
    for (const surface of [g.__mptHostSurface, g.__mptShadowSurface]) {
      assertEquals(surface?.WORK_SOURCE_API_VERSION, WORK_SOURCE_API_VERSION);
      // The very same module instance as the daemon's, not a second copy.
      assert(surface?.SOURCE_ID_PATTERN === SOURCE_ID_PATTERN, "the host's SOURCE_ID_PATTERN object");
    }
  } finally {
    delete g.__mptHostSurface;
    delete g.__mptShadowSurface;
    cleanup(env);
  }
});

test("each broken plugin is logged and skipped; the good one still loads", async () => {
  const env = setup();
  try {
    writePlugin(env.teamDir, "good", { sources: ["./index.js"] }, { "index.js": objectSource("good") });
    writePlugin(env.teamDir, "badapi", { sources: ["./index.js"] }, { "index.js": objectSource("badapi", 99) });
    writePlugin(env.teamDir, "nomanifest", null, { "index.js": objectSource("nomanifest") });
    writePlugin(env.teamDir, "throws", { sources: ["./index.js"] }, { "index.js": `throw new Error("boom at import");` });
    writePlugin(env.teamDir, "factorythrows", { sources: ["./index.js"] }, { "index.js": `export default () => { throw new Error("no token"); };` });
    writePlugin(env.teamDir, "nodefault", { sources: ["./index.js"] }, { "index.js": `export const x = 1;` });
    writePlugin(env.teamDir, "notsource", { sources: ["./index.js"] }, { "index.js": `export default 42;` });
    writePlugin(env.teamDir, "shadow", { sources: ["./index.js"] }, { "index.js": `export default { id: "task", apiVersion: 1 };` });
    writePlugin(env.teamDir, "badid", { sources: ["./index.js"] }, { "index.js": objectSource("Bad_Id") });
    writePlugin(env.teamDir, "escape", { sources: ["../good/index.js"] }, {});
    writePlugin(env.teamDir, "missingentry", { sources: ["./dist/index.js"] }, {});
    writePlugin(env.teamDir, "badsources", { sources: "./index.js" }, {});
    writePlugin(env.teamDir, "partial", { sources: ["./ok.js", "./dup.js"] }, {
      "ok.js": objectSource("partial-ok"),
      "dup.js": objectSource("good"), // the "good" package already took this id
    });

    const statuses = await load(env, [
      "./good", "./badapi", "./nomanifest", "./throws", "./factorythrows", "./nodefault", "./notsource",
      "./shadow", "./badid", "./escape", "./missingentry", "./badsources", "./partial", "./does-not-exist",
      "npm:mpt-not-installed", `${env.teamDir}/good`, "nonsense",
    ]);
    const by = new Map(statuses.map((s) => [s.spec, s]));
    const err = (s: string) => by.get(s)?.error ?? "";

    assertEquals(by.get("./good")?.state, "loaded");
    for (const s of statuses) if (s.spec !== "./good") assertEquals(s.state, "error", s.spec);
    assertStringIncludes(err("./badapi"), "apiVersion 99");
    assertStringIncludes(err("./nomanifest"), "no \"mpt\" manifest");
    assertStringIncludes(err("./throws"), "boom at import");
    assertStringIncludes(err("./factorythrows"), "no token");
    assertStringIncludes(err("./nodefault"), "no default export");
    assertStringIncludes(err("./notsource"), "not a WorkSource");
    assertStringIncludes(err("./shadow"), "already registered");
    assertStringIncludes(err("./badid"), "must match");
    assertStringIncludes(err("./escape"), "outside the package");
    assertStringIncludes(err("./missingentry"), "is the package built?");
    assertStringIncludes(err("./badsources"), "must be an array");
    assertStringIncludes(err("./does-not-exist"), "does not exist");
    assertStringIncludes(err("npm:mpt-not-installed"), "mpt plugins add npm:mpt-not-installed");
    // The same package declared twice: the later declaration is the error, the first is untouched.
    assertStringIncludes(err(`${env.teamDir}/good`), "Duplicate package");
    assertEquals(by.get(`${env.teamDir}/good`)?.identity, path.join(env.teamDir, "good"));
    assertEquals(by.get("nonsense")?.identity, null);
    // A partly failed package keeps what registered, and says which entry failed.
    assertEquals(by.get("./partial")?.sources, ["partial-ok"]);
    assertStringIncludes(err("./partial"), "./dup.js: Work source \"good\" is already registered");

    assertEquals(env.store.listExternalSources().map((e) => e.source.id), ["good", "partial-ok"]);
    assertEquals(env.logs.length, statuses.length);
  } finally {
    cleanup(env);
  }
});

test("a hanging import times out instead of stalling startup", async () => {
  const env = setup();
  try {
    writePlugin(env.teamDir, "hangs", { sources: ["./index.js"] }, { "index.js": `await new Promise(() => {}); export default {};` });
    const [status] = await load(env, ["./hangs"], 50);
    assertEquals(status?.state, "error");
    assertStringIncludes(status?.error ?? "", "timed out");
  } finally {
    cleanup(env);
  }
});

test("packageInstallDir: local in place; npm under packages/npm/node_modules; git under packages/git/<host>/<path>", () => {
  const team = "/teams/alpha";
  assertEquals(packageInstallDir(spec("./plugins/demo"), team), "/teams/alpha/plugins/demo");
  assertEquals(packageInstallDir(spec("npm:mpt-jira@1.2.0"), team), "/teams/alpha/packages/npm/node_modules/mpt-jira");
  assertEquals(packageInstallDir(spec("npm:@acme/mpt-jira"), team), "/teams/alpha/packages/npm/node_modules/@acme/mpt-jira");
  assertEquals(packageInstallDir(spec("git:github.com/acme/mpt-jira@v1"), team), "/teams/alpha/packages/git/github.com/acme/mpt-jira");
  assertEquals(packageInstallDir(spec("https://github.com/acme/mpt-jira.git"), team), "/teams/alpha/packages/git/github.com/acme/mpt-jira");
  assertEquals(packageInstallDir(spec("ssh://git@gitlab.example.com/team/sub/repo@main"), team), "/teams/alpha/packages/git/gitlab.example.com/team/sub/repo");
  // A crafted URL can't leave packages/git/.
  const crafted = packageInstallDir(spec("https://evil.example/a/%2e%2e/%2e%2e/%2e%2e/etc"), team);
  assert(crafted.startsWith("/teams/alpha/packages/git/"), crafted);
});

test("the daemon starts with a broken plugin, and GET /api/work-sources reports every package", async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugin-loader-test-"));
  writePlugin(teamDir, "good", { sources: ["./index.js"] }, { "index.js": objectSource("app-good") });
  writePlugin(teamDir, "broken", { sources: ["./index.js"] }, { "index.js": `throw new Error("broken plugin");` });
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({ ...TEST_CONFIG, packages: ["./broken", "./good"] }));
  const { app, store } = await createApp(teamDir);
  try {
    assert(store);
    const res = await app.request("/api/work-sources");
    assertEquals(res.status, 200);
    const body = await res.json() as WorkSourcesResponse;
    assertEquals(body.sources.map((s) => s.id), ["app-good"]);
    assertEquals(body.plugins.map((p) => [p.spec, p.state]), [["./broken", "error"], ["./good", "loaded"]]);
    assertStringIncludes(body.plugins[0]?.error ?? "", "broken plugin");
  } finally {
    store?.close();
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("install-on-start: a configured npm package that isn't installed is installed and loads; a failing one is isolated and reported", async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugin-autoinstall-test-"));
  const config = { ...TEST_CONFIG, packages: ["npm:mpt-auto-good", "npm:mpt-auto-bad", "./local-missing"] };
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify(config));
  const before = fs.readFileSync(path.join(teamDir, "config.json"), "utf8");
  const calls: string[][] = [];
  // A fake npm: lays out the good package where `npm install --prefix` would; the bad one 404s.
  const pluginRunner = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd !== "npm" || args[0] !== "install") return { code: 0, stdout: "" };
    const name = args.at(-1)!;
    if (name === "mpt-auto-bad") return { code: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.example/mpt-auto-bad" };
    writePlugin(path.join(args[args.indexOf("--prefix") + 1]!, "node_modules"), name, { sources: ["./index.js"] }, { "index.js": objectSource("auto-good") });
    return { code: 0, stdout: "" };
  };
  const { app, store } = await createApp(teamDir, { pluginRunner });
  try {
    assert(store);
    const body = await (await app.request("/api/work-sources")).json() as WorkSourcesResponse;
    assertEquals(body.sources.map((s) => s.id), ["auto-good"]);
    assertEquals(body.plugins.map((p) => [p.spec, p.state]), [["npm:mpt-auto-good", "loaded"], ["npm:mpt-auto-bad", "error"], ["./local-missing", "error"]]);
    assertStringIncludes(body.plugins[1]?.error ?? "", "install failed");
    assertStringIncludes(body.plugins[1]?.error ?? "", "npm error 404 Not Found");
    assertStringIncludes(body.plugins[2]?.error ?? "", "does not exist");
    // One attempt per npm package (never the local path), and config.json is never written.
    assertEquals(calls.filter((c) => c[1] === "install").map((c) => c.at(-1)), ["mpt-auto-good", "mpt-auto-bad"]);
    assertEquals(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"), before);
    assertEquals(fs.existsSync(path.join(teamDir, "packages", "npm", "node_modules", "mpt-auto-bad")), false);
  } finally {
    store?.close();
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("install-on-start: an installed package is left alone (no commands run)", async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugin-autoinstall-test-"));
  writePlugin(path.join(teamDir, "packages", "npm", "node_modules"), "mpt-present", { sources: ["./index.js"] }, { "index.js": objectSource("present-src") });
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({ ...TEST_CONFIG, packages: ["npm:mpt-present"] }));
  const { store } = await createApp(teamDir, { pluginRunner: () => { throw new Error("nothing should run"); } });
  try {
    assertEquals(store?.getPluginStatuses().map((p) => p.state), ["loaded"]);
  } finally {
    store?.close();
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
