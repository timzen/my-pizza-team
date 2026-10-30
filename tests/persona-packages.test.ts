/**
 * tests/persona-packages.test.ts — Persona packages: plugin packages that ship
 * personas (`"mpt": { "personas": [...] }`). See docs/DESIGN.md "Persona
 * packages" and GUIDE.md "Distributing a persona package".
 *
 * Every package is a throwaway local-path package in a temp dir. Covers the
 * loader (daemon/plugins/loader.ts): a persona-only package registers read-only
 * `<name>/<id>` personas; globs and literal files; personas beside sources (a
 * source naming its own package's persona); each failure — a file outside the
 * package (path or symlink), a `*` before the last segment, a missing file, a
 * lint error (still registered), no package.json `name`, a `name` another
 * package claimed, a manifest with neither sources nor personas — recorded in
 * that package's status while the rest load. Then `prepareGit` skipping npm for
 * a persona-only package, `validatePackage`, the doctor's persona checks, and
 * the CLI's add / list / update (npm, faked) / remove (the in-use warning).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { loadPlugins, readPackagePersonaFiles, readPluginManifest } from "../daemon/plugins/loader.ts";
import { PluginInstallError, prepareGit, validatePackage } from "../daemon/plugins/install.ts";
import { runPlugins, type PluginsDeps } from "../cli/plugins.ts";
import type { DoctorReport } from "../cli/plugins-doctor.ts";
import type { PackageEntry } from "../shared/types.ts";
import type { PluginLoadStatus } from "../shared/protocol.ts";

const REVIEWER = "---\ntitle: Reviewer\ndescription: Reviews code.\ntags: [review]\n---\nYou are the **reviewer**.\n";
const CODER = "---\ntitle: Coder\n---\nYou write code.\n";
const BROKEN = "---\ntitle: Broken\n---\n```\nan unclosed fence\n";

/** Write a package at `<root>/<dir>`: package.json (name unless null; `mpt` as given) and its files. */
function writePackage(root: string, dir: string, mpt: unknown, files: Record<string, string>, name: string | null = dir): string {
  const pkgDir = path.join(root, dir);
  fs.mkdirSync(pkgDir, { recursive: true });
  const pkg: Record<string, unknown> = { version: "1.0.0", type: "module", mpt };
  if (name !== null) pkg.name = name;
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkg));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(pkgDir, file)), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, file), content);
  }
  return pkgDir;
}

interface Env {
  root: string;
  teamDir: string;
  store: Store;
  logs: string[];
}

function setup(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-packages-test-"));
  const teamDir = path.join(root, "team");
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  return { root, teamDir, store: new Store(teamDir, TEST_CONFIG), logs: [] };
}

function cleanup(env: Env): void {
  env.store.close();
  try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function load(env: Env, packages: PackageEntry[]): Promise<PluginLoadStatus[]> {
  return loadPlugins(env.store, { packages }, env.teamDir, { log: (m) => env.logs.push(m) });
}

// --- the loader ---

test("loader: a persona-only package registers read-only <name>/<id> personas from a glob and a literal file", async () => {
  const env = setup();
  try {
    const dir = writePackage(env.root, "acme-personas", { personas: ["personas/*.md", "extra/coder.md"] }, {
      "personas/reviewer.md": REVIEWER,
      "personas/notes.txt": "not matched",
      "extra/coder.md": CODER,
    });
    const [status] = await load(env, [dir]);
    assertEquals(status!.state, "loaded");
    assertEquals(status!.sources, []);
    assertEquals(status!.personas, ["acme-personas/reviewer", "acme-personas/coder"]);
    assertStringIncludes(env.logs.join("\n"), "personas: acme-personas/reviewer, acme-personas/coder");

    const p = env.store.getPersona("acme-personas/reviewer")!;
    assertEquals(p.title, "Reviewer");
    assertEquals(p.description, "Reviews code.");
    assertEquals(p.readOnly, true);
    assertEquals(p.origin, { kind: "package", name: "acme-personas", identity: dir });
    assert(env.store.listPersonas().some((x) => x.id === "acme-personas/coder"), "listed in the library");
    // Read-only: the library refuses to edit it, and it resolves for a prompt.
    assertEquals(env.store.resolvePersona("acme-personas/coder", { via: "task", fallback: "builtin:worker" })?.body.trim(), "You write code.");
  } finally {
    cleanup(env);
  }
});

test("loader: personas beside sources — a source may name its own package's persona", async () => {
  const env = setup();
  try {
    const dir = writePackage(env.root, "jira-like", { sources: ["./index.js"], personas: ["personas/*.md"] }, {
      "index.js": `export default { id: "jira-like", apiVersion: 1, mode: "triage", triagePersona: "jira-like/ticket-triage", syncEveryMs: () => null, async sync() { return []; } };`,
      "personas/ticket-triage.md": "---\ntitle: Ticket triage\n---\nTriage the ticket.\n",
    });
    const [status] = await load(env, [dir]);
    assertEquals(status!.state, "loaded", status!.error);
    assertEquals(status!.sources, ["jira-like"]);
    assertEquals(status!.personas, ["jira-like/ticket-triage"]);
    assertEquals(env.store.sourcePersonaProblem("jira-like"), null);
  } finally {
    cleanup(env);
  }
});

test("loader: persona failures are recorded in that package's status; other packages still load", async () => {
  const env = setup();
  try {
    fs.writeFileSync(path.join(env.root, "secret.md"), "outside");
    const escape = writePackage(env.root, "escape", { personas: ["../secret.md", "deep/*/x.md", "personas/missing.md", "personas/*.md"] }, {
      "personas/ok.md": CODER,
    });
    fs.symlinkSync(path.join(env.root, "secret.md"), path.join(escape, "personas", "link.md"));
    const lint = writePackage(env.root, "lint", { personas: ["p/*.md", "empty/*.md"] }, { "p/broken.md": BROKEN, "p/Bad_Name.md": CODER });
    const nameless = writePackage(env.root, "nameless", { personas: ["a.md"] }, { "a.md": CODER }, null);
    const first = writePackage(env.root, "first", { personas: ["a.md"] }, { "a.md": CODER }, "shared-name");
    const second = writePackage(env.root, "second", { personas: ["b.md"] }, { "b.md": CODER }, "shared-name");
    const neither = writePackage(env.root, "neither", {}, {});
    const good = writePackage(env.root, "good", { personas: ["r.md"] }, { "r.md": REVIEWER });

    const statuses = await load(env, [escape, lint, nameless, first, second, neither, good]);
    const by = (dir: string) => statuses.find((s) => s.identity === dir)!;

    const e = by(escape);
    assertEquals(e.state, "error");
    assertStringIncludes(e.error!, "../secret.md is outside the package");
    assertStringIncludes(e.error!, "only a * in the last path segment");
    assertStringIncludes(e.error!, "personas/missing.md does not exist");
    assertStringIncludes(e.error!, "personas/link.md is outside the package (a symlink");
    assertEquals(e.personas, ["escape/ok"], "the usable file still registers");

    const l = by(lint);
    assertEquals(l.state, "error");
    assertStringIncludes(l.error!, "persona lint/broken: Unbalanced code fence");
    assertStringIncludes(l.error!, "\"Bad_Name\" is not a valid persona id");
    assertEquals(l.personas, ["lint/broken"], "a lint error still registers (references resolve to it)");
    assert(env.store.getPersona("lint/broken")!.lintError, "marked lintError");
    assert((l.warnings ?? []).some((w) => w.includes("empty/*.md matches no files")), JSON.stringify(l.warnings));

    assertStringIncludes(by(nameless).error!, "needs a package.json \"name\"");
    assertEquals(by(first).state, "loaded");
    assertEquals(by(second).state, "error");
    assertStringIncludes(by(second).error!, "already registered personas as \"shared-name\"");
    assertEquals(env.store.getPersona("shared-name/b"), null);
    assertStringIncludes(by(neither).error!, "lists neither sources nor personas");
    assertEquals(by(good).state, "loaded");
    assertEquals(by(good).personas, ["good/r"]);
  } finally {
    cleanup(env);
  }
});

test("readPluginManifest / readPackagePersonaFiles: shapes and duplicate ids", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-manifest-test-"));
  try {
    const dir = writePackage(root, "dup", { personas: ["a/*.md", "b/reviewer.md"] }, { "a/reviewer.md": REVIEWER, "b/reviewer.md": REVIEWER });
    assertEquals(readPluginManifest(dir), { name: "dup", sources: [], personas: ["a/*.md", "b/reviewer.md"] });
    const found = readPackagePersonaFiles(dir, ["a/*.md", "b/reviewer.md"]);
    assertEquals(found.files.map((f) => f.name), ["reviewer"]);
    assertStringIncludes(found.errors[0] ?? "", "a/reviewer.md and b/reviewer.md both have the id \"reviewer\"");
    const bad = writePackage(root, "bad", { personas: "personas/*.md" }, {});
    assertStringIncludes((readPluginManifest(bad) as { error: string }).error, "\"mpt.personas\" must be an array");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- install ---

test("prepareGit: a persona-only package runs no npm, even with dependencies and a build script", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-prepare-test-"));
  try {
    const dir = writePackage(root, "p", { personas: ["personas/*.md"] }, { "personas/r.md": REVIEWER });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...pkg, dependencies: { x: "1" }, scripts: { build: "tsc" } }));
    const calls: string[][] = [];
    const logs: string[] = [];
    prepareGit(dir, { teamDir: root, run: (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: "" }; }, log: (l) => logs.push(l) });
    assertEquals(calls.filter((c) => c[0] === "npm"), []);
    assertStringIncludes(logs.join("\n"), "persona-only package");
    assertEquals(validatePackage(dir), { sources: [], personas: ["p/r"], warnings: [] });

    const broken = writePackage(root, "broken", { personas: ["x.md"] }, { "x.md": BROKEN });
    let threw: unknown;
    try { validatePackage(broken); } catch (e) { threw = e; }
    assert(threw instanceof PluginInstallError, "a lint error refuses the package");
    assertStringIncludes((threw as Error).message, "Unbalanced code fence");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- the CLI and the doctor ---

interface CliEnv {
  root: string;
  teamDir: string;
  out: string[];
  deps: PluginsDeps;
  run: (...args: string[]) => Promise<{ code: number; text: string }>;
}

function cliSetup(config: Record<string, unknown> = {}, statuses: PluginLoadStatus[] | null = null): CliEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-cli-test-"));
  const teamDir = path.join(root, "team");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify(config, null, 2));
  const out: string[] = [];
  const deps: PluginsDeps = {
    teamDir,
    cwd: root,
    run: () => { throw new Error("no commands expected"); },
    fetchStatuses: async () => statuses,
    restartHint: "restart",
    log: (l) => out.push(l),
    error: (l) => out.push(l),
  };
  const run = async (...args: string[]) => {
    out.length = 0;
    const code = await runPlugins(args, deps);
    return { code, text: out.join("\n") };
  };
  return { root, teamDir, out, deps, run };
}

const readConfig = (env: CliEnv) => JSON.parse(fs.readFileSync(path.join(env.teamDir, "config.json"), "utf8")) as Record<string, unknown>;

test("cli: add a persona-only package lists its personas; a lint error refuses it with config.json untouched", async () => {
  const env = cliSetup();
  try {
    const dir = writePackage(env.root, "acme", { personas: ["personas/*.md"] }, { "personas/reviewer.md": REVIEWER, "personas/coder.md": CODER });
    let r = await env.run("add", dir);
    assertEquals(r.code, 0, r.text);
    assertStringIncludes(r.text, "Personas: acme/coder, acme/reviewer");
    assertStringIncludes(r.text, "Source entries: none");
    assertEquals(readConfig(env).packages, [dir]);

    const bad = writePackage(env.root, "bad", { personas: ["x.md"] }, { "x.md": BROKEN });
    r = await env.run("add", bad);
    assertEquals(r.code, 1);
    assertStringIncludes(r.text, "Unbalanced code fence");
    assertEquals(readConfig(env).packages, [dir]);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("cli: list shows a persona count (from disk, and from the daemon's status)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-list-test-"));
  try {
    const dir = writePackage(root, "acme", { personas: ["personas/*.md"] }, { "personas/reviewer.md": REVIEWER, "personas/coder.md": CODER });
    const env = cliSetup({ packages: [dir] }, [{ identity: dir, spec: dir, state: "loaded", sources: [], personas: ["acme/coder", "acme/reviewer"] }]);
    try {
      const r = await env.run("list");
      assertEquals(r.code, 0);
      assertStringIncludes(r.text, "provides: 0 source entries, 2 personas");
      assertStringIncludes(r.text, "status: loaded (personas: 2)");
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cli: add and update an npm persona package: no build, the personas validated and counted", async () => {
  const env = cliSetup();
  try {
    let body = REVIEWER;
    const calls: string[][] = [];
    // A fake npm that lays the package out where `npm install --prefix P` would.
    env.deps.run = (cmd, args) => {
      calls.push([cmd, ...args]);
      const prefix = args[args.indexOf("--prefix") + 1]!;
      writePackage(path.join(prefix, "node_modules"), "mpt-personas-acme", { personas: ["personas/*.md"] }, { "personas/reviewer.md": body });
      return { code: 0, stdout: "" };
    };
    let r = await env.run("add", "npm:mpt-personas-acme");
    assertEquals(r.code, 0, r.text);
    assertStringIncludes(r.text, "Personas: mpt-personas-acme/reviewer");
    r = await env.run("update");
    assertEquals(r.code, 0, r.text);
    assertStringIncludes(r.text, "is up to date (0 source entries, 1 persona)");
    // An update that breaks a persona fails loudly.
    body = BROKEN;
    r = await env.run("update");
    assertEquals(r.code, 1);
    assertStringIncludes(r.text, "Unbalanced code fence");
    assert(calls.every((c) => c[0] === "npm" && c[1] === "install"), "npm install only, never a build");
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("cli: remove warns about references to the package's personas, which fall back", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-remove-test-"));
  try {
    const dir = writePackage(root, "acme", { personas: ["personas/*.md"] }, { "personas/reviewer.md": REVIEWER, "personas/coder.md": CODER });
    const env = cliSetup({
      packages: [dir],
      assistant: { persona: "acme/coder" },
      sourcePersonas: { tickets: { triagePersona: "acme/reviewer" } },
    });
    try {
      fs.mkdirSync(path.join(env.teamDir, "workflows", "default"), { recursive: true });
      fs.writeFileSync(path.join(env.teamDir, "workflows", "default", "workflow.json"), JSON.stringify({
        states: [{ name: "TODO", type: "manual" }, { name: "review", type: "agent", persona: "acme/reviewer" }, { name: "DONE", type: "manual" }],
      }));
      const r = await env.run("remove", dir);
      assertEquals(r.code, 0, r.text);
      assertEquals(readConfig(env).packages, []);
      assertStringIncludes(r.text, "3 references to this package's personas will fall back to built-ins");
      assertStringIncludes(r.text, "acme/reviewer — workflow \"default\" state \"review\" → builtin:worker");
      assertStringIncludes(r.text, "acme/coder — the assistant (config.json assistant.persona) → builtin:assistant");
      assertStringIncludes(r.text, "acme/reviewer — source \"tickets\" triage persona setting → the source stops syncing");
      assert(fs.existsSync(dir), "a local package stays on disk");
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor: lists each package's personas ✓, fails a lint error, a missing name, and a duplicate name; resolves package ids", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-doctor-test-"));
  try {
    const good = writePackage(root, "good", { personas: ["personas/*.md"] }, { "personas/reviewer.md": REVIEWER, "personas/broken.md": BROKEN });
    const dup = writePackage(root, "dup", { personas: ["a.md"] }, { "a.md": CODER }, "good");
    const nameless = writePackage(root, "nameless", { personas: ["a.md"] }, { "a.md": CODER }, null);
    const src = writePackage(root, "src", { sources: ["./index.js"] }, {
      "index.js": `export default { id: "src-t", apiVersion: 1, mode: "triage", triagePersona: "good/reviewer", defaultPersona: "good/nope", syncEveryMs: () => null, async sync() { return []; } };`,
    });
    const env = cliSetup({ packages: [good, dup, nameless, src] });
    try {
      const { code, text } = await env.run("doctor", "--json");
      assertEquals(code, 1);
      const report = JSON.parse(text) as DoctorReport;
      const pkg = (dir: string) => report.packages.find((p) => p.identity === dir)!;
      const g = pkg(good);
      assertEquals(g.personas, ["good/broken", "good/reviewer"]);
      assert(g.checks.some((c) => c.status === "ok" && c.message === "persona good/reviewer"), JSON.stringify(g.checks));
      assert(g.checks.some((c) => c.status === "fail" && c.message.startsWith("persona good/broken: Unbalanced code fence")));
      assert(!g.checks.some((c) => c.status === "ok" && c.message === "persona good/broken"));
      assert(pkg(dup).checks.some((c) => c.status === "fail" && c.message.includes("already registered personas as \"good\"")));
      assert(pkg(nameless).checks.some((c) => c.status === "fail" && c.message.includes("needs a package.json \"name\"")));
      const s = pkg(src).sources[0]!.checks;
      assert(s.some((c) => c.status === "ok" && c.message === "triage persona: good/reviewer (declared)"), JSON.stringify(s));
      assert(s.some((c) => c.status === "warn" && c.message.startsWith("defaultPersona \"good/nope\" doesn't exist")));

      // One clean persona package on its own passes.
      const clean = writePackage(root, "clean", { personas: ["r.md"] }, { "r.md": REVIEWER });
      const one = await env.run("doctor", clean);
      assertEquals(one.code, 0, one.text);
      assertStringIncludes(one.text, "✓ persona clean/r");
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
