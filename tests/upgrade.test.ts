/**
 * tests/upgrade.test.ts — `mpt upgrade` (cli/upgrade.ts).
 *
 * The flow is driven end to end with its side effects stubbed (UpgradeDeps): the
 * registry fetch, the npm child processes, the file checks, the extension refresh
 * and the service restart. Nothing touches the network or a real npm.
 */

import { describe, test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import {
  isNewerVersion,
  isPermissionError,
  latestManifestUrl,
  resolveNpm,
  runUpgrade,
  type RunResult,
  type UpgradeDeps,
} from "../cli/upgrade.ts";

describe("helpers", () => {
  test("isNewerVersion", () => {
    assert(isNewerVersion("1.2.4", "1.2.3"));
    assert(isNewerVersion("v2.0.0", "1.9.9"));
    assert(!isNewerVersion("1.2.3", "1.2.3"));
    assert(!isNewerVersion("1.2.2", "1.2.3"));
  });

  test("latestManifestUrl tolerates a trailing slash", () => {
    assertEquals(latestManifestUrl("https://registry.npmjs.org/"), "https://registry.npmjs.org/my-pizza-team/latest");
    assertEquals(latestManifestUrl("https://npm.corp/api/\n"), "https://npm.corp/api/my-pizza-team/latest");
  });

  test("resolveNpm: npm next to node, with that node first on PATH", () => {
    const npm = resolveNpm("/opt/homebrew/bin/node", (p) => p === "/opt/homebrew/bin/npm", { PATH: "/usr/bin" })!;
    assertEquals(npm.cmd, "/opt/homebrew/bin/npm");
    assertEquals(npm.args, []);
    assertEquals(npm.env["PATH"], "/opt/homebrew/bin:/usr/bin");
  });

  test("resolveNpm: falls back to node + lib/node_modules/npm/bin/npm-cli.js", () => {
    const cli = "/x/lib/node_modules/npm/bin/npm-cli.js";
    const npm = resolveNpm("/x/bin/node", (p) => p === cli, {})!;
    assertEquals(npm.cmd, "/x/bin/node");
    assertEquals(npm.args, [cli]);
  });

  test("resolveNpm: null when neither exists", () => {
    assertEquals(resolveNpm("/x/bin/node", () => false, {}), null);
  });

  test("isPermissionError", () => {
    assert(isPermissionError("npm error code EACCES"));
    assert(isPermissionError("Error: EPERM: operation not permitted"));
    assert(!isPermissionError("npm error code E404"));
  });
});

const NODE = "/opt/homebrew/bin/node";
const NPM = "/opt/homebrew/bin/npm";
const ROOT = "/opt/homebrew/lib/node_modules";
const ENTRY = `${ROOT}/my-pizza-team/dist/main.js`;

/** A stubbed upgrade world. `npm` maps a joined argv to its result. */
function world(over: Partial<UpgradeDeps> & { latest?: string; npm?: Record<string, Partial<RunResult>>; files?: string[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const fetched: string[] = [];
  const refreshed: string[][] = [];
  const restarted: Array<[string, string, string]> = [];
  const files = new Set(over.files ?? [NPM, ENTRY]);
  const npm: Record<string, Partial<RunResult>> = {
    "config get registry": { stdout: "https://registry.npmjs.org/\n" },
    "root -g": { stdout: `${ROOT}\n` },
    ...over.npm,
  };
  let ensured = 0;
  const d: UpgradeDeps = {
    currentVersion: "1.0.0",
    fromSource: false,
    packageRoot: `${ROOT}/my-pizza-team`,
    ensureNode: async () => { ensured++; return { path: NODE }; },
    checkNode: () => NODE,
    fetch: async (url) => {
      fetched.push(url);
      return new Response(JSON.stringify({ version: over.latest ?? "1.1.0" }), { status: 200 });
    },
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env });
      const key = args.join(" ");
      const match = Object.entries(npm).find(([k]) => key === k || key.startsWith(k));
      return { code: 0, stdout: "", stderr: "", ...(match?.[1] ?? {}) };
    },
    exists: (p) => files.has(p),
    sameFile: (a, b) => a === b,
    refreshExtension: (inv) => { refreshed.push(inv); },
    restartService: async (v, e, n) => { restarted.push([v, e, n]); },
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ...over,
  };
  return { d, out, err, calls, fetched, refreshed, restarted, ensured: () => ensured };
}

describe("runUpgrade", () => {
  test("from source: points at git pull and exits non-zero", async () => {
    const w = world({ fromSource: true });
    assertEquals(await runUpgrade([], w.d), 1);
    assertStringIncludes(w.err.join("\n"), "git pull");
    assertEquals(w.calls.length, 0);
  });

  test("--check: reports, installs nothing, never prompts", async () => {
    const w = world();
    assertEquals(await runUpgrade(["--check"], w.d), 0);
    assertStringIncludes(w.out.join("\n"), "v1.0.0 → v1.1.0");
    assertEquals(w.fetched, ["https://registry.npmjs.org/my-pizza-team/latest"]);
    assertEquals(w.calls.map((c) => c.args.join(" ")), ["config get registry"]);
    assertEquals(w.ensured(), 0);
  });

  test("honors npm's configured registry", async () => {
    const w = world({ npm: { "config get registry": { stdout: "https://npm.corp/\n" } } });
    await runUpgrade(["--check"], w.d);
    assertEquals(w.fetched, ["https://npm.corp/my-pizza-team/latest"]);
  });

  test("already up to date", async () => {
    const w = world({ latest: "1.0.0" });
    assertEquals(await runUpgrade([], w.d), 0);
    assertStringIncludes(w.out.join("\n"), "Already up to date");
    assert(!w.calls.some((c) => c.args.includes("install")));
  });

  test("registry failure exits non-zero", async () => {
    const w = world({ fetch: async () => new Response("nope", { status: 503 }) });
    assertEquals(await runUpgrade([], w.d), 1);
    assertStringIncludes(w.err.join("\n"), "HTTP 503");
  });

  test("happy path: installs with the configured Node's npm, refreshes the extension from the new copy, restarts", async () => {
    const w = world();
    assertEquals(await runUpgrade([], w.d), 0);
    assertEquals(w.ensured(), 1);
    const install = w.calls.find((c) => c.args[0] === "install")!;
    assertEquals(install.cmd, NPM);
    assertEquals(install.args, ["install", "-g", "my-pizza-team@1.1.0"]);
    assert(install.env!["PATH"]!.startsWith("/opt/homebrew/bin"));
    assertEquals(w.refreshed, [[NODE, ENTRY]]);
    assertEquals(w.restarted, [["1.1.0", ENTRY, NODE]]);
  });

  test("says so when this mpt isn't the copy that npm manages", async () => {
    const w = world({ packageRoot: "/elsewhere/my-pizza-team" });
    assertEquals(await runUpgrade([], w.d), 0);
    assertStringIncludes(w.out.join("\n"), "Upgrading the copy the service uses instead");
  });

  test("no npm next to the configured Node: clear failure", async () => {
    const w = world({ files: [] });
    assertEquals(await runUpgrade([], w.d), 1);
    assertStringIncludes(w.err.join("\n"), "Could not find the npm");
    assertEquals(w.fetched, []);
  });

  test("permission error prints the exact rerun command", async () => {
    const w = world({ npm: { "install": { code: 243, stderr: "npm error code EACCES\n" } } });
    assertEquals(await runUpgrade([], w.d), 1);
    const text = w.err.join("\n");
    assertStringIncludes(text, `sudo env "PATH=/opt/homebrew/bin:$PATH" ${NPM} install -g my-pizza-team@1.1.0`);
    assertStringIncludes(text, "prefix");
    assertEquals(w.restarted, []);
  });

  test("other install failures exit non-zero without restarting", async () => {
    const w = world({ npm: { "install": { code: 1, stderr: "E404" } } });
    assertEquals(await runUpgrade([], w.d), 1);
    assertEquals(w.refreshed, []);
    assertEquals(w.restarted, []);
  });

  test("a missing new entry is reported", async () => {
    const w = world({ files: [NPM] });
    assertEquals(await runUpgrade([], w.d), 1);
    assertStringIncludes(w.err.join("\n"), "missing");
  });
});
