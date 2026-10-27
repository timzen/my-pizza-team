/**
 * tests/plugins-cli.test.ts — `mpt plugins add|list|remove|update` (cli/plugins.ts).
 * See docs/DESIGN.md "Plugin packages".
 *
 * Local-path plugins run for real (temp dirs). Git runs real `git` against a
 * local repository: the runner rewrites the spec's https URL to that repo's
 * path, so nothing touches the network. npm is stubbed — the fake records the
 * command and lays the package out where `npm install --prefix` would (a test
 * can swap it, e.g. for a registry 404). Also covers the git prepare cases
 * (prebuilt skip, runtime-deps only, build-then-missing entry), npm failure
 * messages, and install-on-start's timeout (daemon/plugins/install.ts).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { normalizeCliSpec, npmInstallArgs, type PluginRunResult, type PluginsDeps, runPluginCommand, runPlugins } from "../cli/plugins.ts";
import { packageInstallDir } from "../daemon/plugins/loader.ts";
import { DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS, installMissingPackages, pluginInstallTimeoutMs, TIMEOUT_EXIT_CODE } from "../daemon/plugins/install.ts";
import { parsePackageSpec, type NpmPackageSpec } from "../daemon/plugins/spec.ts";
import type { PluginLoadStatus } from "../shared/protocol.ts";

const SOURCE = `export default { id: "demo", label: "Demo", apiVersion: 1, syncEveryMs: () => null, async sync() { return []; } };\n`;

/** Write a plugin package at `dir` (with an `mpt` manifest unless null). */
function writePlugin(dir: string, mpt: unknown = { sources: ["./index.js"] }, extra: Record<string, unknown> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const pkg: Record<string, unknown> = { name: path.basename(dir), version: "1.0.0", type: "module", ...extra };
  if (mpt !== null) pkg.mpt = mpt;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "index.js"), SOURCE);
  return dir;
}

interface Env {
  root: string;
  teamDir: string;
  out: string[];
  calls: string[][];
  deps: PluginsDeps;
  /** Replace the fake npm for one test (e.g. to fail like a registry 404). */
  npm: { fake: (args: string[], cwd?: string) => PluginRunResult };
}

/**
 * A team dir with a config.json, and deps whose runner fakes npm and runs git
 * for real with `https://git.test/<name>` mapped to `<root>/remotes/<name>`.
 */
function setup(statuses: PluginLoadStatus[] | null = null): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugins-cli-test-"));
  const teamDir = path.join(root, "project", ".mpt");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({ tmuxSession: "keep-me" }, null, 2));
  const out: string[] = [];
  const calls: string[][] = [];
  const npm = { fake: fakeNpm };
  const deps: PluginsDeps = {
    teamDir,
    cwd: path.join(root, "project"),
    run: (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      if (cmd === "npm") return npm.fake(args, opts.cwd);
      const mapped = args.map((a) => a.startsWith("https://git.test/") ? path.join(root, "remotes", a.slice("https://git.test/".length)) : a);
      const r = spawnSync(cmd, mapped, { cwd: opts.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: r.status ?? 1, stdout: r.stdout ?? "" };
    },
    fetchStatuses: async () => statuses,
    restartHint: "mpt stop && mpt start --daemon",
    log: (l) => out.push(l),
    error: (l) => out.push(l),
  };
  return { root, teamDir, out, calls, deps, npm };
}

/** `npm install --prefix P … <name>[@v]` lays out P/node_modules/<name>; `npm run build` writes dist/. */
function fakeNpm(args: string[], cwd?: string): PluginRunResult {
  const prefixAt = args.indexOf("--prefix");
  if (args[0] === "install" && prefixAt >= 0) {
    const target = args[args.length - 1]!;
    const at = target.indexOf("@", 1);
    const name = at === -1 ? target : target.slice(0, at);
    if (name === "mpt-broken") return { code: 1, stdout: "" };
    const dir = path.join(args[prefixAt + 1]!, "node_modules", ...name.split("/"));
    writePlugin(dir, name === "not-a-plugin" ? null : undefined);
    return { code: 0, stdout: "" };
  }
  if (args[0] === "run" && args[1] === "build" && cwd) {
    fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "dist", "index.js"), SOURCE);
  }
  return { code: 0, stdout: "" };
}

function cleanup(env: Env): void {
  try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

const readConfig = (env: Env) => JSON.parse(fs.readFileSync(path.join(env.teamDir, "config.json"), "utf8")) as Record<string, unknown>;
const plugins = (env: Env, ...args: string[]) => runPlugins(args, env.deps);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A git repo at `<root>/remotes/<name>` holding a plugin, one commit on `main`. */
function makeRemote(env: Env, name: string, extra: Record<string, unknown> = {}): string {
  const { mpt = { sources: ["./index.js"] }, ...rest } = extra;
  const dir = writePlugin(path.join(env.root, "remotes", name), mpt, rest);
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "v1");
  return dir;
}

function commit(dir: string, file: string, content: string): string {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", file);
  return git(dir, "rev-parse", "HEAD");
}

test("local path: add validates and appends (resolved from cwd, other keys kept), list shows it, remove leaves it on disk", async () => {
  const env = setup();
  try {
    const pluginDir = writePlugin(path.join(env.root, "project", "my-plugin"));
    assertEquals(await plugins(env, "add", "./my-plugin"), 0);
    assertEquals(readConfig(env), { tmuxSession: "keep-me", packages: [pluginDir] });
    assertStringIncludes(env.out.join("\n"), "Restart the daemon to apply: mpt stop && mpt start --daemon");

    // Duplicate by identity (another way of writing the same path) is refused.
    env.out.length = 0;
    assertEquals(await plugins(env, "add", path.join(pluginDir, ".")), 1);
    assertStringIncludes(env.out.join("\n"), "already configured");

    env.out.length = 0;
    assertEquals(await plugins(env, "list"), 0);
    const listed = env.out.join("\n");
    assertStringIncludes(listed, "kind: local");
    assertStringIncludes(listed, `identity: ${pluginDir}`);
    assertStringIncludes(listed, "installed: yes");
    assertStringIncludes(listed, "status: unknown (daemon not running)");

    assertEquals(await plugins(env, "remove", "./my-plugin"), 0);
    assertEquals(readConfig(env), { tmuxSession: "keep-me", packages: [] });
    assert(fs.existsSync(path.join(pluginDir, "package.json")), "a local plugin is never deleted");
  } finally {
    cleanup(env);
  }
});

test("--config writes the object form; it round-trips through list and remove by identity", async () => {
  const env = setup();
  try {
    const pluginDir = writePlugin(path.join(env.root, "p"));
    assertEquals(await plugins(env, "add", pluginDir, "--config", '{"tokenEnv":"JIRA_TOKEN"}'), 0);
    assertEquals(readConfig(env).packages, [{ source: pluginDir, config: { tokenEnv: "JIRA_TOKEN" } }]);
    assertEquals(await plugins(env, "add", pluginDir, "--config=[1]"), 1);
    assertEquals(await plugins(env, "remove", pluginDir), 0);
    assertEquals(readConfig(env).packages, []);
  } finally {
    cleanup(env);
  }
});

test("add refuses a package without an mpt manifest, a missing path, a bad spec — config.json untouched", async () => {
  const env = setup();
  try {
    const before = readConfig(env);
    writePlugin(path.join(env.root, "nomanifest"), null);
    const missingEntry = writePlugin(path.join(env.root, "missingentry"), { sources: ["./dist/index.js"] });
    for (const spec of [path.join(env.root, "nomanifest"), path.join(env.root, "nope"), missingEntry, "bare-word", "npm:not-a-plugin", "npm:mpt-broken"]) {
      env.out.length = 0;
      assertEquals(await plugins(env, "add", spec), 1, spec);
      assert(env.out.some((l) => l.startsWith("❌")), `${spec}: ${env.out.join("\n")}`);
    }
    assertStringIncludes(env.out.join("\n"), "failed");
    assertEquals(readConfig(env), before);
    // A failed npm install leaves nothing behind.
    assert(!fs.existsSync(path.join(env.teamDir, "packages", "npm", "node_modules", "not-a-plugin")));
  } finally {
    cleanup(env);
  }
});

test("list reports the daemon's load status by identity, and a not-installed package", async () => {
  const statuses: PluginLoadStatus[] = [
    { identity: "mpt-jira", spec: "npm:mpt-jira@1.0.0", state: "error", error: "boom", sources: [] },
  ];
  const env = setup(statuses);
  try {
    const good = writePlugin(path.join(env.root, "good"));
    fs.writeFileSync(path.join(env.teamDir, "config.json"), JSON.stringify({ packages: ["npm:mpt-jira@1.0.0", good, "bad word"] }));
    assertEquals(await plugins(env, "list"), 0);
    const out = env.out.join("\n");
    assertStringIncludes(out, "status: error — boom");
    assertStringIncludes(out, "ref: 1.0.0");
    assertStringIncludes(out, "installed: no (expected at");
    assertStringIncludes(out, "status: not loaded");
    assertStringIncludes(out, "Invalid package spec");
  } finally {
    cleanup(env);
  }
});

test("npm: add installs into the shared prefix with --omit=peer; update skips pinned, bumps unpinned to latest; remove deletes", async () => {
  const env = setup();
  try {
    assertEquals(await plugins(env, "add", "npm:@acme/mpt-jira@1.2.0"), 0);
    assertEquals(await plugins(env, "add", "npm:mpt-asana"), 0);
    const prefix = path.join(env.teamDir, "packages", "npm");
    assertEquals(env.calls[0], ["npm", "install", "--prefix", prefix, "--omit=peer", "--no-audit", "--no-fund", "@acme/mpt-jira@1.2.0"]);
    assert(fs.existsSync(path.join(prefix, "package.json")), "the prefix is an npm project");
    assert(fs.existsSync(path.join(prefix, "node_modules", "@acme", "mpt-jira", "package.json")));
    assertEquals(readConfig(env).packages, ["npm:@acme/mpt-jira@1.2.0", "npm:mpt-asana"]);

    env.calls.length = 0;
    assertEquals(await plugins(env, "update"), 0);
    assertEquals(env.calls, [["npm", "install", "--prefix", prefix, "--omit=peer", "--no-audit", "--no-fund", "mpt-asana@latest"]]);
    assertStringIncludes(env.out.join("\n"), "pinned to 1.2.0");

    env.calls.length = 0;
    assertEquals(await plugins(env, "remove", "@acme/mpt-jira"), 0);
    assertEquals(env.calls, [["npm", "uninstall", "--prefix", prefix, "--no-audit", "--no-fund", "@acme/mpt-jira"]]);
    assert(!fs.existsSync(path.join(prefix, "node_modules", "@acme", "mpt-jira")));
    assertEquals(readConfig(env).packages, ["npm:mpt-asana"]);
    assertEquals(await plugins(env, "remove", "npm:nothing"), 1);
  } finally {
    cleanup(env);
  }
});

test("git: add clones, checks out the ref, installs and builds; update follows a branch, skips a tag; remove deletes the clone", async () => {
  const env = setup();
  try {
    const remote = makeRemote(env, "acme/demo", {
      scripts: { build: "tsc" },
      devDependencies: { typescript: "^5" },
      peerDependencies: { "my-pizza-team": "*" },
      mpt: { sources: ["./dist/index.js"] },
    });
    git(remote, "tag", "v1");
    const tagged = makeRemote(env, "acme/tagged");
    git(tagged, "tag", "v1");
    const v2 = commit(tagged, "later.txt", "after the tag");

    assertEquals(await plugins(env, "add", "https://git.test/acme/demo@main"), 0, env.out.join("\n"));
    const dir = path.join(env.teamDir, "packages", "git", "git.test", "acme", "demo");
    assert(fs.existsSync(path.join(dir, "dist", "index.js")), "built");
    const npmCalls = env.calls.filter((c) => c[0] === "npm");
    assertEquals(npmCalls, [["npm", "install", "--omit=peer", "--no-audit", "--no-fund"], ["npm", "run", "build"]]);

    assertEquals(await plugins(env, "add", "git:git.test/acme/tagged@v1"), 0, env.out.join("\n"));
    const taggedDir = path.join(env.teamDir, "packages", "git", "git.test", "acme", "tagged");
    assert(!fs.existsSync(path.join(taggedDir, "later.txt")), "checked out the tag");
    assertEquals(readConfig(env).packages, ["https://git.test/acme/demo@main", "git:git.test/acme/tagged@v1"]);

    // A new commit on the branch: update follows it; the tag stays put.
    const head = commit(remote, "new.txt", "new");
    env.out.length = 0;
    assertEquals(await plugins(env, "update"), 0, env.out.join("\n"));
    assertEquals(git(dir, "rev-parse", "HEAD"), head);
    // The previous build's dist/ is still on disk but isn't committed: not "prebuilt", so it's rebuilt.
    assertEquals(env.calls.filter((c) => c[0] === "npm" && c[1] === "run").length, 2);
    assert(git(taggedDir, "rev-parse", "HEAD") !== v2, "tag still pinned");
    assertStringIncludes(env.out.join("\n"), "pinned to v1");

    // Remove by another spelling of the same identity.
    assertEquals(await plugins(env, "remove", "git:git.test/acme/demo"), 0);
    assert(!fs.existsSync(dir), "clone deleted");
    assertEquals(readConfig(env).packages, ["git:git.test/acme/tagged@v1"]);
  } finally {
    cleanup(env);
  }
});

test("git: an add that fails validation removes the clone and writes nothing", async () => {
  const env = setup();
  try {
    const remote = makeRemote(env, "acme/plain");
    const pkg = JSON.parse(fs.readFileSync(path.join(remote, "package.json"), "utf8"));
    delete pkg.mpt;
    fs.writeFileSync(path.join(remote, "package.json"), JSON.stringify(pkg));
    commit(remote, "x.txt", "x");
    assertEquals(await plugins(env, "add", "git:git.test/acme/plain"), 1);
    assertStringIncludes(env.out.join("\n"), `no "mpt" manifest`);
    assert(!fs.existsSync(path.join(env.teamDir, "packages", "git", "git.test", "acme", "plain")));
    assertEquals(readConfig(env).packages, undefined);
  } finally {
    cleanup(env);
  }
});

test("git: prebuilt — entries committed and no runtime deps — runs no npm at all (even with a build script)", async () => {
  const env = setup();
  try {
    makeRemote(env, "acme/prebuilt", { scripts: { build: "tsc" }, devDependencies: { "@internal/only": "*" } });
    assertEquals(await plugins(env, "add", "git:git.test/acme/prebuilt"), 0, env.out.join("\n"));
    assertEquals(env.calls.filter((c) => c[0] === "npm"), []);
    assertStringIncludes(env.out.join("\n"), "skipping npm");
    assertEquals(readConfig(env).packages, ["git:git.test/acme/prebuilt"]);
  } finally {
    cleanup(env);
  }
});

test("git: prebuilt entries with runtime dependencies install only those (no dev deps, no build)", async () => {
  const env = setup();
  try {
    makeRemote(env, "acme/deps", { scripts: { build: "tsc" }, dependencies: { "left-pad": "^1" }, devDependencies: { typescript: "^5" } });
    assertEquals(await plugins(env, "add", "git:git.test/acme/deps"), 0, env.out.join("\n"));
    assertEquals(env.calls.filter((c) => c[0] === "npm"), [["npm", "install", "--omit=peer", "--omit=dev", "--no-audit", "--no-fund"]]);
  } finally {
    cleanup(env);
  }
});

test("git: a build that doesn't produce an mpt.sources entry fails clearly — clone removed, config.json untouched", async () => {
  const env = setup();
  try {
    makeRemote(env, "acme/misbuilt", { scripts: { build: "tsc" }, mpt: { sources: ["./dist/missing.js"] } });
    assertEquals(await plugins(env, "add", "git:git.test/acme/misbuilt"), 1);
    assertStringIncludes(env.out.join("\n"), "built, but ./dist/missing.js is still missing — check the package's build output / mpt.sources");
    assert(!fs.existsSync(path.join(env.teamDir, "packages", "git", "git.test", "acme", "misbuilt")), "clone removed");
    assertEquals(readConfig(env), { tmuxSession: "keep-me" });
  } finally {
    cleanup(env);
  }
});

test("git: an npm install failure shows the command, exit code, stderr tail and the contract — clone removed, config.json untouched", async () => {
  const env = setup();
  try {
    makeRemote(env, "acme/e404", { scripts: { build: "tsc" }, devDependencies: { "@amzn/brazil": "*" }, mpt: { sources: ["./dist/index.js"] } });
    env.npm.fake = (args) => args[0] === "install"
      ? { code: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@amzn%2fbrazil - Not found\n" }
      : { code: 0, stdout: "" };
    const before = fs.readFileSync(path.join(env.teamDir, "config.json"), "utf8");
    assertEquals(await plugins(env, "add", "git:git.test/acme/e404"), 1);
    const text = env.out.join("\n");
    assertStringIncludes(text, "`npm install --omit=peer --no-audit --no-fund` failed (exit 1)");
    assertStringIncludes(text, "npm error 404 Not Found - GET https://registry.npmjs.org/@amzn%2fbrazil");
    assertStringIncludes(text, "Git plugins must install and build with plain npm against your npm registry (`npm config get registry`)");
    assertStringIncludes(text, `See GUIDE.md "Distributing a plugin".`);
    assertEquals(env.calls.filter((c) => c[0] === "npm" && c[1] === "run"), [], "no build after a failed install");
    assert(!fs.existsSync(path.join(env.teamDir, "packages", "git", "git.test", "acme", "e404")), "partial clone removed");
    assertEquals(fs.readFileSync(path.join(env.teamDir, "config.json"), "utf8"), before);
  } finally {
    cleanup(env);
  }
});

test("update installs a configured package that isn't installed yet, even a pinned one", async () => {
  const env = setup();
  try {
    fs.writeFileSync(path.join(env.teamDir, "config.json"), JSON.stringify({ packages: ["npm:mpt-jira@1.0.0", "./local-only"] }));
    assertEquals(await plugins(env, "update"), 0);
    assertEquals(env.calls.map((c) => c.at(-1)), ["mpt-jira@1.0.0"]);
    assertStringIncludes(env.out.join("\n"), "local path, loads in place");
  } finally {
    cleanup(env);
  }
});

test("spec → install dir and command construction", () => {
  const team = "/teams/alpha";
  const npm = parsePackageSpec("npm:@acme/x@^2", team);
  assert(npm.ok);
  assertEquals(packageInstallDir(npm.spec, team), "/teams/alpha/packages/npm/node_modules/@acme/x");
  assertEquals(npmInstallArgs(npm.spec as NpmPackageSpec, team), ["install", "--prefix", "/teams/alpha/packages/npm", "--omit=peer", "--no-audit", "--no-fund", "@acme/x@^2"]);
  assertEquals(npmInstallArgs(npm.spec as NpmPackageSpec, team, true).at(-1), "@acme/x@latest");
  assertEquals(normalizeCliSpec("./p", "/home/me/proj"), "/home/me/proj/p");
  assertEquals(normalizeCliSpec("..", "/home/me/proj"), "/home/me");
  assertEquals(normalizeCliSpec("~/p", "/home/me/proj"), "~/p");
  assertEquals(normalizeCliSpec("npm:x", "/home/me/proj"), "npm:x");
});

test("usage: no subcommand or an unknown one exits 1; a missing team dir is reported", async () => {
  const env = setup();
  try {
    assertEquals(await plugins(env), 1);
    assertEquals(await plugins(env, "frobnicate"), 1);
    assertEquals(await plugins(env, "help"), 0);
    env.deps.teamDir = path.join(env.root, "nowhere", ".mpt");
    env.out.length = 0;
    assertEquals(await plugins(env, "list"), 1);
    assertStringIncludes(env.out.join("\n"), "mpt setup");
  } finally {
    cleanup(env);
  }
});

test("runPluginCommand captures stdout and reports a missing command", () => {
  const r = runPluginCommand(process.execPath, ["-e", "process.stdout.write('hi')"], { capture: true });
  assertEquals([r.code, r.stdout], [0, "hi"]);
  assertEquals(runPluginCommand("definitely-not-a-command-mpt", [], { capture: true }).code, 127);
});

test("install-on-start bounds each command: a killed install reports the timeout; the limit comes from MPT_PLUGIN_INSTALL_TIMEOUT_MS", () => {
  const env = setup();
  try {
    const seen: Array<number | undefined> = [];
    const failures = installMissingPackages({ packages: ["npm:mpt-slow"] }, {
      teamDir: env.teamDir,
      run: (_cmd, _args, opts) => {
        seen.push(opts.timeoutMs);
        return { code: TIMEOUT_EXIT_CODE, stdout: "", stderr: "" };
      },
      log: (l) => env.out.push(l),
      timeoutMs: 5_000,
    });
    assertEquals(seen[0], 5_000);
    assertStringIncludes(failures.get("mpt-slow") ?? "", "timed out after 5s");
    assertStringIncludes(env.out.join("\n"), "mpt-slow: install failed");
    assertEquals(pluginInstallTimeoutMs("1234"), 1234);
    assertEquals(pluginInstallTimeoutMs(undefined), DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS);
    assertEquals(pluginInstallTimeoutMs("nope"), DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS);
  } finally {
    cleanup(env);
  }
});
