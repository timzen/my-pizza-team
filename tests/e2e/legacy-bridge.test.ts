/**
 * tests/e2e/legacy-bridge.test.ts — scripts/legacy-bridge.sh, run for real by sh.
 *
 * The bridge is what an old compiled-binary mpt (<= 0.27) downloads from a release
 * and writes over itself during `mpt upgrade` (docs/DESIGN.md "Moving Old Binaries
 * Across"). Its promise is that whatever happens, `mpt` keeps working: it either
 * hands off to the npm package or puts the v0.27.0 binary back. Each case builds a
 * fake world in a temp dir:
 *
 *   - a fake Node prefix (`<prefix>/bin/node`, `<prefix>/bin/npm`) whose npm
 *     "installs" the package by creating `<prefix>/lib/node_modules/my-pizza-team`,
 *     refusing (EEXIST) to overwrite a file at `<prefix>/bin/mpt` without --force,
 *     like the real one; the fake node logs how it was run;
 *   - a PATH holding only the system tools the script needs, so no real Node is found;
 *   - a file:// "release" with a fake v0.27.0 binary and its checksums.sha256.
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRIDGE = path.join(REPO, "scripts", "legacy-bridge.sh");

/** The tools the bridge uses — symlinked into a private PATH. */
const TOOLS = ["sh", "sed", "head", "uname", "dirname", "basename", "cat", "grep", "mkdir", "rmdir", "chmod", "mv",
  "rm", "cut", "id", "sleep", "curl", "sha256sum", "shasum", "ln", "touch", "printf", "env"];

/** The v0.27.0 asset name for this machine (legacy_asset in the script). */
function legacyAsset(): string {
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  return `mpt-${process.platform === "darwin" ? "darwin" : "linux"}-${arch}`;
}

const roots: string[] = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

interface World {
  root: string;
  home: string;
  prefix: string;
  node: string;
  log: string;
  /** Where the bridge is installed (the old binary's path). */
  self: string;
  env: NodeJS.ProcessEnv;
  run: (args: string[], extraEnv?: NodeJS.ProcessEnv) => { code: number; output: string };
  calls: () => string[];
}

function exe(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** A fresh fake world. `collide`: the bridge lives where npm puts its `mpt`. */
function world(opts: { collide?: boolean; nodeMajor?: number; npmFails?: string; badChecksum?: boolean } = {}): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-bridge-e2e-"));
  roots.push(root);
  const home = path.join(root, "home");
  const prefix = path.join(root, "prefix");
  const tools = path.join(root, "tools");
  const release = path.join(root, "release");
  const log = path.join(root, "calls.log");
  for (const d of [home, path.join(prefix, "bin"), tools, release, path.join(root, "old")]) fs.mkdirSync(d, { recursive: true });

  for (const t of TOOLS) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (found.startsWith("/")) fs.symlinkSync(found, path.join(tools, t));
  }

  const node = path.join(prefix, "bin", "node");
  const pkg = path.join(prefix, "lib", "node_modules", "my-pizza-team");
  // Fake node: answers the version probe, runs the bridge's `-e` snippet (saving
  // runtime.json) with the real Node, and otherwise logs its argv.
  exe(node, `
if [ "$1" = -p ]; then echo ${opts.nodeMajor ?? 24}; exit 0; fi
if [ "$1" = -e ]; then exec "${process.execPath}" "$@"; fi
echo "node $*" >> "${log}"`);
  exe(path.join(prefix, "bin", "npm"), `
case "$1" in
  root) echo "${prefix}/lib/node_modules"; exit 0 ;;
  prefix) echo "${prefix}"; exit 0 ;;
  install)
    echo "npm $*" >> "${log}"
    ${opts.npmFails ? `echo "npm error code ${opts.npmFails}" >&2; exit 243` : ""}
    if [ -e "${prefix}/bin/mpt" ] && [ "$3" != --force ]; then echo "npm error code EEXIST" >&2; exit 1; fi
    mkdir -p "${pkg}/dist" && echo "// entry" > "${pkg}/dist/main.js"
    rm -f "${prefix}/bin/mpt" && ln -s "${pkg}/dist/main.js" "${prefix}/bin/mpt" ;;
esac`);

  // The v0.27.0 "release": a binary that says what it is, and its checksum.
  const legacy = path.join(release, legacyAsset());
  exe(legacy, `echo "legacy $*" >> "${log}"`);
  const sum = opts.badChecksum ? "0".repeat(64) : crypto.createHash("sha256").update(fs.readFileSync(legacy)).digest("hex");
  fs.writeFileSync(path.join(release, "checksums.sha256"), `${sum}  ${legacyAsset()}\n`);

  const self = opts.collide ? path.join(prefix, "bin", "mpt") : path.join(root, "old", "mpt");
  fs.copyFileSync(BRIDGE, self);
  fs.chmodSync(self, 0o755);

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: tools,
    TMPDIR: root,
    MPT_BRIDGE_NODE_PATHS: node,
    MPT_BRIDGE_LEGACY_BASE: `file://${release}`,
  };
  return {
    root, home, prefix, node, log, self, env,
    run: (args, extraEnv = {}) => {
      const r = spawnSync(self, args, { env: { ...env, ...extraEnv }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
    },
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

const entryOf = (w: World) => path.join(w.prefix, "lib", "node_modules", "my-pizza-team", "dist", "main.js");

describe("legacy bridge", () => {
  it("first run from a terminal: installs the package, adopts (with the service), then hands off", () => {
    const w = world();
    const r = w.run(["write-extension-internal"]);
    assertEquals(r.code, 0, r.output);
    const entry = entryOf(w);
    assertEquals(w.calls(), [
      "npm install -g my-pizza-team",
      `node ${entry} adopt-legacy-internal ${w.node} ${w.self} service`,
      `node ${entry} write-extension-internal`,
    ]);
    assertStringIncludes(r.output, "installing it with");
    const saved = JSON.parse(fs.readFileSync(path.join(w.home, ".config", "mpt", "runtime.json"), "utf8"));
    assertEquals(saved.node, w.node);
  });

  it("an installed mpt that predates adopt-legacy-internal: its complaint is hidden, the Node still saved", () => {
    const w = world();
    // An entry that rejects the command, as 0.30.1 does.
    fs.writeFileSync(path.join(w.prefix, "bin", "node"), `#!/bin/sh
if [ "$1" = -p ]; then echo 24; exit 0; fi
if [ "$1" = -e ]; then exec "${process.execPath}" "$@"; fi
if [ "$2" = adopt-legacy-internal ]; then echo "Unknown command: adopt-legacy-internal"; exit 1; fi
echo "node $*" >> "${w.log}"
`);
    const r = w.run(["--version"]);
    assertEquals(r.code, 0, r.output);
    assert(!r.output.includes("Unknown command"), r.output);
    assert(fs.existsSync(path.join(w.home, ".config", "mpt", "runtime.json")));
  });

  it("later runs go straight to the package, with no npm and no adopt", () => {
    const w = world();
    w.run(["status"]);
    fs.rmSync(w.log);
    assertEquals(w.run(["status", "--json"]).code, 0);
    assertEquals(w.calls(), [`node ${entryOf(w)} status --json`]);
  });

  it("run by the old service: installs and hands off, leaving the service file to a terminal run", () => {
    const w = world();
    const r = w.run(["start"], { INVOCATION_ID: "abc" });
    assertEquals(r.code, 0, r.output);
    assertEquals(w.calls(), ["npm install -g my-pizza-team", `node ${entryOf(w)} start`]);
  });

  it("bridge where npm puts its mpt: --force from a terminal, and npm's link takes the path", () => {
    const w = world({ collide: true });
    const r = w.run(["write-extension-internal"]);
    assertEquals(r.code, 0, r.output);
    assertEquals(w.calls()[0], "npm install -g --force my-pizza-team");
    assertEquals(fs.realpathSync(w.self), fs.realpathSync(entryOf(w)));
  });

  it("bridge where npm puts its mpt, run by the service: puts v0.27.0 back instead", () => {
    const w = world({ collide: true });
    const r = w.run(["start"], { XPC_SERVICE_NAME: "com.my-pizza-team.daemon" });
    assertEquals(r.code, 0, r.output);
    assertEquals(w.calls(), ["legacy start"]);
    assertStringIncludes(r.output, "needs a terminal");
  });

  it("no Node >=24: says so, puts v0.27.0 back over itself, and runs it", () => {
    const w = world({ nodeMajor: 22 });
    const r = w.run(["write-extension-internal"]);
    assertEquals(r.code, 0, r.output);
    assertStringIncludes(r.output, "Node.js >=24");
    assertEquals(w.calls(), ["legacy write-extension-internal"]);
    assert(!fs.readFileSync(w.self, "utf8").includes("MPT_LEGACY_BRIDGE"), "the binary replaced the bridge");
  });

  it("npm can't write its prefix: the sudo hint, and v0.27.0 back", () => {
    const w = world({ npmFails: "EACCES" });
    const r = w.run(["status"]);
    assertEquals(r.code, 0, r.output);
    assertStringIncludes(r.output, "sudo env");
    assertEquals(w.calls().at(-1), "legacy status");
  });

  it("a fallback binary that fails its checksum is not installed", () => {
    const w = world({ nodeMajor: 22, badChecksum: true });
    const r = w.run(["status"]);
    assertEquals(r.code, 1);
    assertStringIncludes(r.output, "checksum mismatch");
    assertStringIncludes(fs.readFileSync(w.self, "utf8"), "MPT_LEGACY_BRIDGE");
  });
});
