/**
 * tests/runtime-config.test.ts — The saved Node setting (shared/runtime-config.ts)
 * and the prompt that fills it (cli/node-choice.ts).
 *
 * Covers: where the file lives, atomic read/write, `--node` > `MPT_NODE` > file
 * priority, validating a Node (with fake `node` scripts that print a version),
 * version-pinned path detection, the suggestion, and every branch of
 * `ensureNodeConfigured` with the terminal and the version check stubbed.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "./_assert.ts";
import {
  checkNode,
  configuredNode,
  extractNodeFlag,
  meetsVersion,
  type NodeCheck,
  pinnedNodeManager,
  pinnedNodeWarning,
  readRuntimeConfig,
  requiredNodeVersion,
  runtimeConfigPath,
  saveConfiguredNode,
  stableNodeAlternative,
  suggestedNode,
  writeRuntimeConfig,
} from "../shared/runtime-config.ts";
import { ensureNodeConfigured, type EnsureNodeDeps, NodeConfigError } from "../cli/node-choice.ts";
import { mptInvocation } from "../daemon/self.ts";
import { cliEntryScript } from "../shared/paths.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-runtime-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake `node` that prints `version` for any arguments. */
function fakeNode(name: string, version: string, mode = 0o755): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
  fs.chmodSync(file, mode);
  return file;
}

describe("runtime.json location", () => {
  test("~/.config/mpt/runtime.json by default", () => {
    assertEquals(runtimeConfigPath({ HOME: "/h" }, "darwin"), "/h/.config/mpt/runtime.json");
    assertEquals(runtimeConfigPath({ HOME: "/h" }, "linux"), "/h/.config/mpt/runtime.json");
  });
  test("$XDG_CONFIG_HOME on Linux only", () => {
    assertEquals(runtimeConfigPath({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux"), "/x/mpt/runtime.json");
    assertEquals(runtimeConfigPath({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "darwin"), "/h/.config/mpt/runtime.json");
  });
});

describe("read/write", () => {
  test("missing or broken file reads as empty", () => {
    const file = path.join(dir, "runtime.json");
    assertEquals(readRuntimeConfig(file), {});
    fs.writeFileSync(file, "{not json");
    assertEquals(readRuntimeConfig(file), {});
  });

  test("save keeps other keys, records chosenAt, and leaves no temp file", () => {
    const file = path.join(dir, "nested", "runtime.json");
    writeRuntimeConfig({ node: "/old/node", other: 1 }, file);
    saveConfiguredNode("/new/node", file, new Date("2025-01-02T03:04:05Z"));
    assertEquals(readRuntimeConfig(file), { node: "/new/node", other: 1, chosenAt: "2025-01-02T03:04:05.000Z" });
    assertEquals(fs.readdirSync(path.dirname(file)), ["runtime.json"]);
  });
});

describe("priority", () => {
  test("--node > MPT_NODE > file > none", () => {
    const file = path.join(dir, "runtime.json");
    assertEquals(configuredNode({ env: {}, file }), null);
    saveConfiguredNode("/file/node", file);
    assertEquals(configuredNode({ env: {}, file }), { path: "/file/node", source: "file" });
    assertEquals(configuredNode({ env: { MPT_NODE: "/env/node" }, file }), { path: "/env/node", source: "env" });
    assertEquals(configuredNode({ env: { MPT_NODE: "/env/node" }, file, flag: "/flag/node" }), { path: "/flag/node", source: "flag" });
  });

  test("extractNodeFlag takes both spellings out of argv", () => {
    assertEquals(extractNodeFlag(["install", "--node", "/a/node", "--yes"]), { args: ["install", "--yes"], node: "/a/node" });
    assertEquals(extractNodeFlag(["--node=/b/node", "doctor"]), { args: ["doctor"], node: "/b/node" });
    assertEquals(extractNodeFlag(["status"]), { args: ["status"] });
    assertThrows(() => extractNodeFlag(["install", "--node"]));
    assertThrows(() => extractNodeFlag(["install", "--node", "--yes"]));
  });
});

describe("validation", () => {
  test("engines minimum is >=24", () => {
    assertEquals(requiredNodeVersion(), [24, 0, 0]);
    assert(meetsVersion("24.0.0"));
    assert(meetsVersion("v26.1.2"));
    assert(!meetsVersion("22.12.0"));
    assert(!meetsVersion("garbage"));
  });

  test("a new-enough Node passes and reports its version", () => {
    assertEquals(checkNode(fakeNode("bin/node", "24.3.1")), { ok: true, version: "24.3.1" });
  });

  test("too old, missing, not executable, not Node, relative", () => {
    const old = checkNode(fakeNode("old/node", "22.1.0"));
    assert(!old.ok);
    assertStringIncludes((old as { problem: string }).problem, ">=24");
    assertStringIncludes((checkNode(path.join(dir, "nope")) as { problem: string }).problem, "does not exist");
    assertStringIncludes((checkNode(fakeNode("noexec/node", "24.0.0", 0o644)) as { problem: string }).problem, "not executable");
    assertStringIncludes((checkNode(fakeNode("liar/node", "hello")) as { problem: string }).problem, "did not report");
    assertStringIncludes((checkNode("node") as { problem: string }).problem, "absolute");
  });

  test("a symlinked Node is checked as given, not resolved", () => {
    const real = fakeNode("Cellar/node/24.1.0/bin/node", "24.1.0");
    const link = path.join(dir, "bin-node");
    fs.symlinkSync(real, link);
    assertEquals(checkNode(link), { ok: true, version: "24.1.0" });
    const file = path.join(dir, "runtime.json");
    saveConfiguredNode(link, file);
    assertEquals(readRuntimeConfig(file).node, link);
  });
});

describe("version-pinned paths", () => {
  const home = "/Users/me";
  test("detects nvm, fnm, volta, asdf, mise and Homebrew's Cellar", () => {
    assertEquals(pinnedNodeManager("/Users/me/.nvm/versions/node/v24.1.0/bin/node", home), "nvm");
    assertEquals(pinnedNodeManager("/Users/me/.local/share/fnm/node-versions/v24/installation/bin/node", home), "fnm");
    assertEquals(pinnedNodeManager("/run/user/1/fnm_multishells/123_456/bin/node", home), "fnm");
    assertEquals(pinnedNodeManager("/Users/me/.volta/tools/image/node/24.1.0/bin/node", home), "volta");
    assertEquals(pinnedNodeManager("/Users/me/.asdf/installs/nodejs/24.1.0/bin/node", home), "asdf");
    assertEquals(pinnedNodeManager("/Users/me/.local/share/mise/installs/node/24/bin/node", home), "mise");
    assertEquals(pinnedNodeManager("/opt/homebrew/Cellar/node/24.1.0/bin/node", home), "Homebrew");
  });
  test("stable paths are not pinned", () => {
    for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/Users/me/.volta/bin/node"]) {
      assertEquals(pinnedNodeManager(p, home), null);
    }
  });
  test("the warning explains the risk and suggests a stable path", () => {
    const w = pinnedNodeWarning("/Users/me/.nvm/versions/node/v24.1.0/bin/node", "/usr/local/bin/node", home)!;
    assertStringIncludes(w, "nvm");
    assertStringIncludes(w, "breaks if that version is removed");
    assertStringIncludes(w, "/usr/local/bin/node");
    assertEquals(pinnedNodeWarning("/usr/bin/node", null, home), null);
  });
  test("stableNodeAlternative picks the first candidate that passes", () => {
    const old = fakeNode("a/node", "20.0.0");
    const good = fakeNode("b/node", "24.0.0");
    assertEquals(stableNodeAlternative([path.join(dir, "missing"), old, good]), good);
    assertEquals(stableNodeAlternative([old]), null);
  });
});

describe("suggestion", () => {
  test("a stable spelling of the running Node wins over its resolved path", () => {
    const real = fakeNode("Cellar/node/24.1.0/bin/node", "24.1.0");
    const link = path.join(dir, "stable-node");
    fs.symlinkSync(real, link);
    assertEquals(suggestedNode(real, { candidates: [link], pathVar: "" }), link);
  });
  test("a node on PATH that links to the running Node wins", () => {
    const real = fakeNode("Cellar/node/24.1.0/bin/node", "24.1.0");
    fs.mkdirSync(path.join(dir, "brew-bin"));
    const link = path.join(dir, "brew-bin", "node");
    fs.symlinkSync(real, link);
    assertEquals(suggestedNode(real, { candidates: [], pathVar: `/nowhere:${path.join(dir, "brew-bin")}` }), link);
  });
  test("a pinned running Node yields to a working stable one", () => {
    const pinned = fakeNode(".nvm/versions/node/v24.1.0/bin/node", "24.1.0");
    const stable = fakeNode("usr/bin/node", "24.2.0");
    assertEquals(suggestedNode(pinned, { candidates: [stable], home: dir, pathVar: "" }), stable);
    assertEquals(suggestedNode(pinned, { candidates: [], home: dir, pathVar: "" }), pinned);
  });
  test("otherwise the running Node", () => {
    const n = fakeNode("plain/node", "24.0.0");
    assertEquals(suggestedNode(n, { candidates: [], pathVar: "" }), n);
  });
});

describe("ensureNodeConfigured", () => {
  const good = (version = "24.5.0"): NodeCheck => ({ ok: true, version });
  /** Deps where every path except those in `bad` checks out, and the terminal answers from `answers`. */
  function deps(over: Partial<EnsureNodeDeps> & { answers?: string[]; bad?: Record<string, string> } = {}) {
    const lines: string[] = [];
    const asked: string[] = [];
    const answers = [...(over.answers ?? [])];
    const d: Partial<EnsureNodeDeps> = {
      file: path.join(dir, "runtime.json"),
      env: { HOME: dir },
      execPath: "/usr/local/bin/node",
      candidates: [],
      check: (n) => (over.bad?.[n] ? { ok: false, problem: over.bad[n]! } : good()),
      ask: async (q) => {
        asked.push(q);
        const a = answers.shift();
        if (a === undefined) throw new Error("unexpected prompt");
        return a;
      },
      log: (l) => lines.push(l),
      now: () => new Date("2025-06-01T00:00:00Z"),
      ...over,
    };
    return { d, lines, asked };
  }
  const saved = () => readRuntimeConfig(path.join(dir, "runtime.json"));

  test("no terminal, nothing saved: uses the current Node, says so, saves it", async () => {
    const { d, lines, asked } = deps();
    const n = await ensureNodeConfigured({ interactive: false }, d);
    assertEquals(n, { path: "/usr/local/bin/node", version: "24.5.0", source: "file" });
    assertEquals(asked, []);
    assertEquals(saved(), { node: "/usr/local/bin/node", chosenAt: "2025-06-01T00:00:00.000Z" });
    assert(lines.some((l) => l.includes("Using Node 24.5.0 at /usr/local/bin/node")));
  });

  test("--yes in a terminal: no prompt", async () => {
    const { d, asked } = deps();
    await ensureNodeConfigured({ interactive: true, assumeYes: true }, d);
    assertEquals(asked, []);
    assertEquals(saved().node, "/usr/local/bin/node");
  });

  test("interactive: Enter accepts the suggestion", async () => {
    const { d, asked } = deps({ answers: [""] });
    await ensureNodeConfigured({ interactive: true }, d);
    assertEquals(asked, ["Node path [/usr/local/bin/node]: "]);
    assertEquals(saved().node, "/usr/local/bin/node");
  });

  test("interactive: a bad typed path is re-asked, a good one saved", async () => {
    const { d, lines, asked } = deps({ answers: ["/bad/node", "/opt/node"], bad: { "/bad/node": "/bad/node does not exist" } });
    const n = await ensureNodeConfigured({ interactive: true }, d);
    assertEquals(n.path, "/opt/node");
    assertEquals(asked.length, 2);
    assert(lines.some((l) => l.includes("/bad/node does not exist")));
    assertEquals(saved().node, "/opt/node");
  });

  test("a working saved Node is used without asking or rewriting", async () => {
    saveConfiguredNode("/saved/node", path.join(dir, "runtime.json"), new Date("2020-01-01T00:00:00Z"));
    const { d, asked } = deps();
    const n = await ensureNodeConfigured({ interactive: true }, d);
    assertEquals(n, { path: "/saved/node", version: "24.5.0", source: "file" });
    assertEquals(asked, []);
    assertEquals(saved().chosenAt, "2020-01-01T00:00:00.000Z");
  });

  test("an MPT_NODE override is used and saved", async () => {
    const { d } = deps({ env: { HOME: dir, MPT_NODE: "/env/node" } });
    const n = await ensureNodeConfigured({ interactive: false }, d);
    assertEquals(n.source, "env");
    assertEquals(saved().node, "/env/node");
  });

  test("a broken override fails rather than falling back", async () => {
    const { d } = deps({ env: { HOME: dir, MPT_NODE: "/env/node" }, bad: { "/env/node": "/env/node does not exist" } });
    await assertRejects(() => ensureNodeConfigured({ interactive: true }, d), NodeConfigError, "MPT_NODE");
  });

  test("a broken saved Node: prompts again in a terminal", async () => {
    saveConfiguredNode("/gone/node", path.join(dir, "runtime.json"));
    const { d, asked } = deps({ answers: [""], bad: { "/gone/node": "/gone/node does not exist" } });
    const n = await ensureNodeConfigured({ interactive: true }, d);
    assertEquals(asked.length, 1);
    assertEquals(n.path, "/usr/local/bin/node");
    assertEquals(saved().node, "/usr/local/bin/node");
  });

  test("a broken saved Node with no terminal fails clearly and leaves the file alone", async () => {
    saveConfiguredNode("/gone/node", path.join(dir, "runtime.json"));
    const { d } = deps({ bad: { "/gone/node": "/gone/node is Node 20.0.0; mpt needs Node >=24.0.0" } });
    await assertRejects(() => ensureNodeConfigured({ interactive: false }, d), NodeConfigError, "no longer works");
    assertEquals(saved().node, "/gone/node");
  });

  test("a broken saved Node with --yes is replaced by the current Node", async () => {
    saveConfiguredNode("/gone/node", path.join(dir, "runtime.json"));
    const { d } = deps({ bad: { "/gone/node": "/gone/node does not exist" } });
    const n = await ensureNodeConfigured({ interactive: false, assumeYes: true }, d);
    assertEquals(n.path, "/usr/local/bin/node");
  });

  test("an unusable current Node with no terminal fails", async () => {
    const { d } = deps({ bad: { "/usr/local/bin/node": "too old" } });
    await assertRejects(() => ensureNodeConfigured({ interactive: false }, d), NodeConfigError, "--node");
  });

  test("a pinned choice is saved with a warning", async () => {
    const pinned = path.join(dir, ".nvm", "versions", "node", "v24.0.0", "bin", "node");
    const { d, lines } = deps({ execPath: pinned });
    await ensureNodeConfigured({ interactive: false }, d);
    assertEquals(saved().node, pinned);
    assert(lines.some((l) => l.includes("pinned") && l.includes("nvm")));
  });
});

describe("mptInvocation", () => {
  test("prefers the configured Node", () => {
    assertEquals(mptInvocation("/running/node", "/configured/node"), ["/configured/node", cliEntryScript()]);
  });
  test("falls back to the running Node", () => {
    assertEquals(mptInvocation("/running/node", null), ["/running/node", cliEntryScript()]);
  });
});
