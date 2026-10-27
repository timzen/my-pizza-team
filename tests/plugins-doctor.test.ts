/**
 * tests/plugins-doctor.test.ts — `mpt plugins doctor` (cli/plugins-doctor.ts).
 * See GUIDE.md "Testing your plugin".
 *
 * Every plugin is a throwaway local-path package in a temp dir with a plain
 * `.js` entry (each test its own dir, so Node's module cache never hands one
 * test another's module). Covers: a good object export; a factory that is not
 * called without --config and is with it; a bad manifest, a throwing import, a
 * bad apiVersion; a sync returning invalid or duplicate items, one that throws,
 * one that times out; an unstable revision; --hooks; `--config team`; --config
 * with several targets (a usage error); the --json shape; and that the real
 * team dir is never written.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { runPlugins, type PluginsDeps } from "../cli/plugins.ts";
import { describeImportError, type DoctorReport } from "../cli/plugins-doctor.ts";

/** An external source object with this id whose sync returns `items` (a JS expression). */
const objectSource = (id: string, items = `[{ externalId: "A-1", revision: "r1", title: "One", goal: "g", url: "https://x.test/A-1" }]`, extra = "") => `
export default {
  id: ${JSON.stringify(id)}, apiVersion: 1, syncEveryMs: () => null, ${extra}
  async sync(ctx) { ctx.log("syncing"); return ${items}; },
};
`;

/** A factory export that records each call in `<dir>/called.json` (so a test can see it ran). */
const factorySource = (id: string) => `
import * as fs from "node:fs";
import { WORK_SOURCE_API_VERSION } from "my-pizza-team/plugin";
export default (options, { teamDir }) => {
  fs.writeFileSync(new URL("./called.json", import.meta.url), JSON.stringify({ options, teamDir, frozen: Object.isFrozen(options) }));
  return {
    id: ${JSON.stringify(id)}, apiVersion: WORK_SOURCE_API_VERSION,
    async init(ctx) { ctx.log("init " + String(ctx.options().greeting)); ctx.kv.set("k", "v"); },
    async sync(ctx) {
      ctx.upsertDef({ externalId: "F-1", revision: "r1", title: "F", goal: "" });
      ctx.enqueueRevision("x", "r1");
      return [{ externalId: "F-1", revision: "r1", title: "From " + String(ctx.options().greeting), goal: "", mode: "triage", directory: "/tmp/x" }];
    },
  };
};
`;

/** Write a local plugin package at `<root>/<name>` (with an `mpt` manifest unless null). */
function writePlugin(root: string, name: string, files: Record<string, string>, mpt: unknown = { sources: ["./index.js"] }): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const pkg: Record<string, unknown> = { name, version: "1.0.0", type: "module" };
  if (mpt !== null) pkg.mpt = mpt;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}

interface Env {
  root: string;
  teamDir: string;
  out: string[];
  deps: PluginsDeps;
  /** Run `mpt plugins doctor …`; the exit code and everything printed. */
  doctor: (...args: string[]) => Promise<{ code: number; text: string }>;
  /** Run with --json and parse the report. */
  json: (...args: string[]) => Promise<{ code: number; report: DoctorReport }>;
}

function setup(packages: unknown[] = []): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-plugins-doctor-test-"));
  const teamDir = path.join(root, "team");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({ packages }, null, 2));
  const out: string[] = [];
  const deps: PluginsDeps = {
    teamDir,
    cwd: root,
    run: () => {
      throw new Error("the doctor must not run commands");
    },
    fetchStatuses: async () => null,
    restartHint: "restart",
    log: (l) => out.push(l),
    error: (l) => out.push(l),
  };
  const doctor = async (...args: string[]) => {
    out.length = 0;
    const code = await runPlugins(["doctor", ...args], deps);
    return { code, text: out.join("\n") };
  };
  const json = async (...args: string[]) => {
    const { code, text } = await doctor(...args, "--json");
    return { code, report: JSON.parse(text) as DoctorReport };
  };
  return { root, teamDir, out, deps, doctor, json };
}

/** Every file under `dir` with its content, to prove a run left it untouched. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("doctor: a good object export passes the install check, without syncing", async () => {
  const env = setup();
  const dir = writePlugin(env.root, "good", { "index.js": objectSource("good-src") });
  fs.writeFileSync(path.join(env.teamDir, "config.json"), JSON.stringify({ packages: [dir] }));
  const { code, text } = await env.doctor();
  assertEquals(code, 0);
  assertStringIncludes(text, "install check only");
  assertStringIncludes(text, `📦 ${dir}`);
  assertStringIncludes(text, "✓ imports (with my-pizza-team/plugin resolved to this host)");
  assertStringIncludes(text, `✓ default export is a WorkSource object: "good-src"`);
  assertStringIncludes(text, "✓ apiVersion 1");
  assert(!text.includes("sync returned"), "no sync without --config");
  assert(!text.includes("✗"));
});

test("doctor: a factory is not called without --config, and is with it (frozen options, a temp teamDir)", async () => {
  const env = setup();
  const dir = writePlugin(env.root, "fac", { "index.js": factorySource("fac-src") });
  const before = snapshot(env.teamDir);

  const install = await env.doctor("./fac");
  assertEquals(install.code, 0);
  assertStringIncludes(install.text, "default export is a factory (not called without --config");
  assertStringIncludes(install.text, "(not configured)");
  assertEquals(fs.existsSync(path.join(dir, "called.json")), false);

  const { code, report } = await env.json("./fac", "--config", '{"greeting":"hi"}');
  assertEquals(code, 0);
  const called = JSON.parse(fs.readFileSync(path.join(dir, "called.json"), "utf8"));
  assertEquals(called.options, { greeting: "hi" });
  assertEquals(called.frozen, true);
  assert(!called.teamDir.startsWith(env.teamDir), "the factory gets a throwaway teamDir");
  const src = report.packages[0]!.sources[0]!;
  assertEquals(src.id, "fac-src");
  assertEquals(src.export, "factory");
  assertEquals(src.items, [{ externalId: "F-1", revision: "r1", mode: "triage", title: "From hi", directory: "/tmp/x", mirrorId: "fac-src~F-1" }]);
  assert(src.logs!.includes("[fac-src] init hi"));
  assertEquals(src.calls!.upsertDef, ["F-1", "F-1"]);
  assertEquals(src.calls!.enqueueRevision.length, 2);
  assert(src.checks.some((c) => c.status === "ok" && c.message === "init"));
  assert(src.checks.some((c) => c.message === "revisions stable across two syncs"));
  // The throwaway context wrote nothing to the real team dir (nor did the factory).
  assertEquals(snapshot(env.teamDir), before);
});

test("doctor: a bad manifest, a throwing import, and a bad apiVersion each fail (exit 1) while the rest are checked", async () => {
  const env = setup();
  const noManifest = writePlugin(env.root, "nomani", { "index.js": objectSource("x") }, null);
  const throws = writePlugin(env.root, "throws", { "index.js": `throw new Error("boom at import");\n` });
  const badApi = writePlugin(env.root, "badapi", { "index.js": objectSource("bad-api").replace("apiVersion: 1", "apiVersion: 99") });
  const missing = writePlugin(env.root, "missing", {}, { sources: ["./dist/index.js"] });
  const good = writePlugin(env.root, "good2", { "index.js": objectSource("good-two") });
  fs.writeFileSync(path.join(env.teamDir, "config.json"), JSON.stringify({ packages: [noManifest, throws, badApi, missing, good, "npm:Bad Name"] }));

  const { code, report } = await env.json();
  assertEquals(code, 1);
  assertEquals(report.ok, false);
  const by = (dir: string) => report.packages.find((p) => p.spec === dir)!;
  assert(by(noManifest).checks.some((c) => c.status === "fail" && c.message.includes("no \"mpt\" manifest")));
  const imp = by(throws).sources[0]!.checks.find((c) => c.status === "fail")!;
  assertStringIncludes(imp.message, "import failed: boom at import");
  const api = by(badApi).sources[0]!.checks.find((c) => c.status === "fail")!;
  assertStringIncludes(api.message, "apiVersion 99; this host supports 1");
  assertStringIncludes(by(missing).sources[0]!.checks[0]!.message, "does not exist (is the package built?)");
  assert(by(good).sources[0]!.checks.every((c) => c.status === "ok"));
  assert(report.packages.some((p) => p.spec === "npm:Bad Name" && p.checks[0]!.status === "fail"));
  assertEquals(report.summary.fail > 0, true);
});

test("doctor: duplicate source ids across packages, a built-in id, and a bad external id fail", async () => {
  const env = setup();
  const a = writePlugin(env.root, "dupa", { "index.js": objectSource("same-id") });
  const b = writePlugin(env.root, "dupb", { "index.js": objectSource("same-id") });
  const c = writePlugin(env.root, "builtin", { "index.js": objectSource("story") });
  const d = writePlugin(env.root, "badid", { "index.js": objectSource("Bad_Id") });
  fs.writeFileSync(path.join(env.teamDir, "config.json"), JSON.stringify({ packages: [a, b, c, d] }));
  const { code, text } = await env.doctor();
  assertEquals(code, 1);
  assertStringIncludes(text, `✗ id "same-id" is already taken by ${a}`);
  assertStringIncludes(text, `✗ id "story" is already taken by a built-in source`);
  assertStringIncludes(text, `✗ id "Bad_Id" doesn't match`);
});

test("doctor --config: invalid and duplicate items fail; an unstable revision warns", async () => {
  const env = setup();
  writePlugin(env.root, "items", {
    "index.js": objectSource("items-src", `[
      { externalId: "A", revision: "r", title: "ok", goal: "" },
      { externalId: "A", revision: "r", title: "again", goal: "" },
      { externalId: "B", revision: "r", goal: "" },
      { externalId: "${"x".repeat(300)}", revision: "r", title: "long", goal: "" },
    ]`),
  });
  writePlugin(env.root, "unstable", {
    "index.js": objectSource("unstable-src", `[{ externalId: "U", revision: String(++n), title: "same", goal: "" }]`).replace("export default", "let n = 0;\nexport default"),
  });
  const items = await env.doctor("./items", "--config", "{}");
  assertEquals(items.code, 1);
  assertStringIncludes(items.text, "✗ item #3: missing 'title'");
  assertStringIncludes(items.text, "✗ duplicate externalIds: A");
  assertStringIncludes(items.text, "over the 255-byte directory-name limit");
  assertStringIncludes(items.text, `• A @ r  "ok"`);

  const unstable = await env.doctor("./unstable", "--config={}");
  assertEquals(unstable.code, 0);
  assertStringIncludes(unstable.text, "⚠ revision changed between two syncs with no content change: U");
});

test("doctor --config: a sync that throws, or outlives its syncTimeoutMs, fails", async () => {
  const env = setup();
  writePlugin(env.root, "sthrow", { "index.js": objectSource("sthrow", `(() => { throw new Error("upstream 500"); })()`) });
  writePlugin(env.root, "shang", { "index.js": objectSource("shang", `new Promise(() => {})`, "syncTimeoutMs: 50,") });
  writePlugin(env.root, "snot", { "index.js": objectSource("snot", `{ items: [] }`) });
  const t = await env.doctor("./sthrow", "--config", "{}");
  assertEquals(t.code, 1);
  assertStringIncludes(t.text, "✗ sync failed: upstream 500");
  const h = await env.doctor("./shang", "--config", "{}");
  assertEquals(h.code, 1);
  assertStringIncludes(h.text, "✗ sync failed: sync timed out after 50ms");
  const n = await env.doctor("./snot", "--config", "{}");
  assertEquals(n.code, 1);
  assertStringIncludes(n.text, "not an array");
});

test("doctor --config team uses the configured entry's config; errors when the target isn't configured", async () => {
  const dirName = "teamcfg";
  const env = setup();
  const dir = writePlugin(env.root, dirName, { "index.js": factorySource("team-src") });
  fs.writeFileSync(path.join(env.teamDir, "config.json"), JSON.stringify({ packages: [{ source: dir, config: { greeting: "from-team" } }] }));
  const before = snapshot(env.teamDir);

  // No target: exactly one configured package is the one target.
  const { code, report } = await env.json("--config", "team");
  assertEquals(code, 0);
  assertEquals(report.live, true);
  assertEquals(report.packages[0]!.configured, true);
  assertEquals(report.packages[0]!.sources[0]!.items![0]!.title, "From from-team");
  // By identity too.
  assertEquals((await env.doctor(dir, "--config", "team")).code, 0);
  assertEquals(snapshot(env.teamDir), before);

  writePlugin(env.root, "loose", { "index.js": factorySource("loose-src") });
  const loose = await env.doctor("./loose", "--config", "team");
  assertEquals(loose.code, 1);
  assertStringIncludes(loose.text, "is not in");
});

test("doctor: --config with several targets, or --hooks without --config, is a usage error", async () => {
  const env = setup();
  const a = writePlugin(env.root, "ua", { "index.js": objectSource("ua") });
  const b = writePlugin(env.root, "ub", { "index.js": objectSource("ub") });
  fs.writeFileSync(path.join(env.teamDir, "config.json"), JSON.stringify({ packages: [a, b] }));
  const many = await env.doctor("--config", "{}");
  assertEquals(many.code, 1);
  assertStringIncludes(many.text, "--config runs one package live; 2 are configured");
  assertStringIncludes(many.text, "Usage: mpt plugins doctor");
  const hooks = await env.doctor("--hooks");
  assertEquals(hooks.code, 1);
  assertStringIncludes(hooks.text, "add --config");
  assertEquals((await env.doctor("./ua", "--config", "[1]")).code, 1);
});

test("doctor --hooks calls onComment and onItemTerminal (a COMPLETE item) on the first item; --source picks one", async () => {
  const env = setup();
  writePlugin(env.root, "hooks", {
    "index.js": objectSource("hooks-src", undefined, `
      onComment(def, comment, ctx) { ctx.log("comment on " + def.id + ": " + comment.from); },
      onItemTerminal(def, item, ctx) { ctx.log("terminal " + item.state); throw new Error("write-back refused"); },`),
  });
  const { code, report } = await env.json("./hooks", "--config", "{}", "--hooks", "--source", "hooks-src");
  assertEquals(code, 1);
  const src = report.packages[0]!.sources[0]!;
  assert(src.logs!.includes("[hooks-src] comment on hooks-src~A-1: mpt-plugins-doctor"));
  assert(src.logs!.includes("[hooks-src] terminal COMPLETE"));
  assert(src.checks.some((c) => c.status === "ok" && c.message.startsWith("onComment on A-1: ok")));
  assert(src.checks.some((c) => c.status === "fail" && c.message.includes("onItemTerminal on A-1 failed: write-back refused")));

  const wrong = await env.doctor("./hooks", "--config", "{}", "--source", "nope");
  assertEquals(wrong.code, 1);
  assertStringIncludes(wrong.text, "--source nope: no source with that id");
});

test("doctor --json: the report's shape", async () => {
  const env = setup();
  const dir = writePlugin(env.root, "shape", { "index.js": objectSource("shape-src") });
  fs.writeFileSync(path.join(env.teamDir, "config.json"), JSON.stringify({ packages: [dir] }));
  const { code, report } = await env.json();
  assertEquals(code, 0);
  assertEquals(Object.keys(report).sort(), ["live", "ok", "packages", "summary"]);
  assertEquals(report.ok, true);
  assertEquals(report.live, false);
  const p = report.packages[0]!;
  assertEquals(p.spec, dir);
  assertEquals(p.kind, "local");
  assertEquals(p.identity, dir);
  assertEquals(p.dir, dir);
  assertEquals(p.configured, true);
  assertEquals(p.sources[0]!.entry, "./index.js");
  assertEquals(p.sources[0]!.id, "shape-src");
  assertEquals(p.sources[0]!.export, "object");
  for (const c of [...p.checks, ...p.sources[0]!.checks]) assert(["ok", "warn", "fail"].includes(c.status) && typeof c.message === "string");
  assertEquals(report.summary.fail, 0);
  assertEquals(report.summary.ok, p.checks.length + p.sources[0]!.checks.length);
});

test("doctor: no packages configured is fine; an npm spec that isn't installed fails without touching the network", async () => {
  const env = setup();
  const none = await env.doctor();
  assertEquals(none.code, 0);
  assertStringIncludes(none.text, "No plugin packages configured");
  const npm = await env.doctor("npm:mpt-not-here");
  assertEquals(npm.code, 1);
  assertStringIncludes(npm.text, "not installed");
  assertEquals(fs.existsSync(path.join(env.teamDir, "packages")), false);
});

test("describeImportError: a native ABI mismatch says which Node to rebuild with", () => {
  const e = Object.assign(new Error("The module '/x/foo.node' was compiled against a different Node.js version using\nNODE_MODULE_VERSION 115. This version of Node.js requires\nNODE_MODULE_VERSION 137."), { code: "ERR_DLOPEN_FAILED" });
  const { message, hint } = describeImportError(e, "/pkg");
  assertStringIncludes(message, "NODE_MODULE_VERSION 115");
  assertStringIncludes(hint ?? "", `Node ${process.versions.node} (NODE_MODULE_VERSION ${process.versions.modules})`);
  assertStringIncludes(hint ?? "", "cd /pkg && npm rebuild");
});
