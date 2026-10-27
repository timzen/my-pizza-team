/**
 * tests/source-routes.test.ts — The Config page's Sources surface
 * (daemon/routes/sources.ts): `GET /api/sources`, `POST /api/sources/:id/preview`,
 * `PUT /api/sources/:id/config`. See docs/DESIGN.md "Plugin settings:
 * configSchema and preview".
 *
 * Plugins are throwaway local-path packages in a temp dir (as in
 * tests/plugin-loader.test.ts). Each test uses its own source ids, because a
 * module is imported once per process and the plugins count their `init`
 * calls on `globalThis`. Covers: the list (kinds, toggle, schema, settings with
 * secrets redacted and env-var refs by name, sync status, mirror count);
 * preview validation, no side effects, the per-source gate; save validation,
 * the config.json round trip (other entries and keys kept, "source" scope,
 * a string entry, `packages` surviving a later `PUT /api/config`); re-init
 * calling `init` again with the new options, resetting backoff and syncing;
 * a failing re-init saved but reported; and the API token applying.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { loadPlugins } from "../daemon/plugins/loader.ts";
import { REDACTED_SETTING, type SourceConfigResponse, type SourcePreviewResponse, type SourcesResponse, type SourceView } from "../shared/protocol.ts";
import type { PackageEntry, TeamConfig } from "../shared/types.ts";
import { restoreRedacted, setPackageEntryConfig, viewSettings } from "../daemon/sources/settings.ts";

const SCHEMA = {
  type: "object",
  required: ["project"],
  properties: {
    project: { type: "string", pattern: "^[A-Z]+$" },
    tokenEnv: { type: "string", format: "env-var" },
    maxItems: { type: "integer", minimum: 1 },
  },
};

type Calls = Record<string, Array<Record<string, unknown>>>;
const calls = (): Calls => ((globalThis as Record<string, unknown>).__mptSourceRouteInits ??= {}) as Calls;

/**
 * A plugin source module: records each `init`'s options, syncs one item whose
 * goal names `project`, and (when `failInitOn` is set) throws from `init` when
 * `project` equals it.
 */
function sourceModule(id: string, opts: { scope?: "source"; failInitOn?: string; failSync?: boolean } = {}): string {
  return `
const calls = (globalThis.__mptSourceRouteInits ??= {});
const block = (ctx) => ${opts.scope === "source" ? `(ctx.options()[${JSON.stringify(id)}] ?? {})` : "ctx.options()"};
export default {
  id: ${JSON.stringify(id)}, label: "Demo ${id}", apiVersion: 1,
  syncEveryMs: () => null,
  configSchema: ${JSON.stringify(SCHEMA)},
  ${opts.scope ? `configScope: "source",` : ""}
  init(ctx) {
    (calls[${JSON.stringify(id)}] ??= []).push({ ...ctx.options() });
    ${opts.failInitOn ? `if (block(ctx).project === ${JSON.stringify(opts.failInitOn)}) throw new Error("bad project");` : ""}
  },
  async sync(ctx) {
    ${opts.failSync ? `if (block(ctx).project === "FAIL") throw new Error("boom");` : ""}
    ctx.kv.set("synced", "yes");
    return [{ externalId: "one", title: "One", goal: "project " + String(block(ctx).project), revision: "r-" + String(block(ctx).project) }];
  },
};`;
}

function writePlugin(root: string, name: string, sources: Record<string, string>): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", mpt: { sources: Object.keys(sources) } }));
  for (const [file, content] of Object.entries(sources)) fs.writeFileSync(path.join(dir, file), content);
}

interface Env {
  teamDir: string;
  store: Store;
  config: TeamConfig;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  onDisk: () => Record<string, unknown>;
}

/** A team whose config.json declares `packages` (plus an unrelated key), loaded and served. */
async function setup(packages: PackageEntry[], plugins: Record<string, Record<string, string>>, extra: Partial<TeamConfig> = {}): Promise<Env> {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-source-routes-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  for (const [name, sources] of Object.entries(plugins)) writePlugin(teamDir, name, sources);
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), packages: structuredClone(packages), favoriteDirectories: ["/tmp/fav"], ...extra };
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({ port: config.port, packages, favoriteDirectories: ["/tmp/fav"] }, null, 2) + "\n");
  const store = new Store(teamDir, config);
  store.setPluginStatuses(await loadPlugins(store, config, teamDir, { log: () => {} }));
  const app = buildApp(store, config, teamDir);
  const auth: Record<string, string> = config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {};
  const request = (url: string, init: RequestInit = {}) =>
    Promise.resolve(app.request(url, { ...init, headers: { "Content-Type": "application/json", ...auth, ...init.headers as Record<string, string> } }));
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as Record<string, unknown>;
  return { teamDir, store, config, request, onDisk };
}

function cleanup({ store, teamDir }: Env): void {
  store.close();
  try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const put = (env: Env, id: string, options: unknown) =>
  env.request(`/api/sources/${id}/config`, { method: "PUT", body: JSON.stringify({ options }) });
const preview = (env: Env, id: string, options: unknown) =>
  env.request(`/api/sources/${id}/preview`, { method: "POST", body: JSON.stringify({ options }) });
async function viewOf(env: Env, id: string): Promise<SourceView> {
  const body = await (await env.request("/api/sources")).json() as SourcesResponse;
  const v = body.sources.find((s) => s.id === id);
  assert(v, `no ${id} in ${JSON.stringify(body.sources.map((s) => s.id))}`);
  return v;
}
/** Let fire-and-forget work (the re-init's sync) finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test("GET /api/sources lists every source: kind, package, toggle, schema, redacted settings, env vars, sync, mirrors", async () => {
  process.env.MPT_TEST_SRC_TOKEN = "s3cret";
  const env = await setup(
    [{ source: "./list-pkg", config: { project: "ACME", tokenEnv: "MPT_TEST_SRC_TOKEN", apiToken: "inline-secret", missingEnv: "MPT_TEST_SRC_UNSET" } }],
    { "list-pkg": { "./a.js": sourceModule("list-a") } },
  );
  try {
    const res = await env.request("/api/sources");
    assertEquals(res.status, 200);
    const body = await res.json() as SourcesResponse;
    assertEquals(body.sources.find((s) => s.id === "story")?.kind, "built-in");
    assertEquals(body.sources.find((s) => s.id === "story")?.toggle, { feature: "stories", enabled: true });
    assertEquals(body.sources.find((s) => s.id === "thought")?.toggle, null);
    const v = body.sources.find((s) => s.id === "list-a")!;
    assertEquals(v.kind, "plugin");
    assertEquals(v.label, "Demo list-a");
    assertEquals(v.package?.spec, "./list-pkg");
    assertEquals(v.mode, "work");
    assertEquals(v.toggle, { feature: "list-a", enabled: true });
    assertEquals(v.configurable, true);
    assertEquals(v.previewable, true);
    assertEquals(v.configScope, "package");
    assertEquals((v.configSchema as { required: string[] }).required, ["project"]);
    // The inline secret never leaves the daemon; env-var refs are shown by name.
    assertEquals(v.options.apiToken, REDACTED_SETTING);
    assertEquals(v.redacted, ["apiToken"]);
    assertEquals(v.options.tokenEnv, "MPT_TEST_SRC_TOKEN");
    assert(!JSON.stringify(body).includes("s3cret") && !JSON.stringify(body).includes("inline-secret"), "a secret leaked");
    assertEquals(v.envVars, [
      { path: "tokenEnv", name: "MPT_TEST_SRC_TOKEN", set: true },
      { path: "missingEnv", name: "MPT_TEST_SRC_UNSET", set: false },
    ]);
    assertEquals(v.sync, { running: false, failures: 0, backoffUntil: null, last: null });
    assertEquals(v.activeMirrors, 0);

    await env.store.syncWorkSource("list-a");
    const after = await viewOf(env, "list-a");
    assertEquals(after.activeMirrors, 1);
    assertEquals(after.sync?.last?.ok, true);
    assertEquals(after.sync?.last?.mirrored, 1);
    assert(typeof after.sync?.last?.at === "number");
  } finally {
    delete process.env.MPT_TEST_SRC_TOKEN;
    cleanup(env);
  }
});

test("preview: field errors are a 400; a good draft returns items without mirroring, enqueueing, or persisting", async () => {
  const env = await setup([{ source: "./prev-pkg", config: { project: "OLD" } }], { "prev-pkg": { "./a.js": sourceModule("prev-a") } });
  try {
    const bad = await preview(env, "prev-a", { project: "lower", maxItems: 0 });
    assertEquals(bad.status, 400);
    const badBody = await bad.json() as SourcePreviewResponse;
    assertEquals(badBody.fieldErrors?.map((e) => e.path).sort(), ["maxItems", "project"]);
    assertEquals((await preview(env, "prev-a", "nope")).status, 400);
    assertEquals((await preview(env, "no-such", {})).status, 404);

    const before = fs.readFileSync(path.join(env.teamDir, "config.json"), "utf8");
    const ok = await preview(env, "prev-a", { project: "NEW" });
    assertEquals(ok.status, 200);
    const body = await ok.json() as SourcePreviewResponse;
    assertEquals(body.success, true);
    assertEquals(body.via, "sync");
    assertEquals(body.items?.map((i) => i.goal), ["project NEW"]);
    // No side effects: no mirror, no kv write, config unchanged, live options unchanged.
    assertEquals(env.store.getWorkDefs("all").filter((d) => d.parent?.kind === "external").length, 0);
    assert(!fs.existsSync(path.join(env.teamDir, "sources", "prev-a.json")) ||
      !fs.readFileSync(path.join(env.teamDir, "sources", "prev-a.json"), "utf8").includes("synced"), "preview wrote kv");
    assertEquals(fs.readFileSync(path.join(env.teamDir, "config.json"), "utf8"), before);
    assertEquals((await viewOf(env, "prev-a")).options.project, "OLD");
    assertEquals(calls()["prev-a"]?.length, 1);
  } finally {
    cleanup(env);
  }
});

test("preview is one at a time per source, then cools down (429 + Retry-After)", async () => {
  const slow = `
let release;
export default {
  id: "gate-a", apiVersion: 1, syncEveryMs: () => null,
  async sync() { return []; },
  preview() { return new Promise((r) => { globalThis.__mptReleaseGate = () => r({ items: [] }); }); },
};`;
  const env = await setup(["./gate-pkg"], { "gate-pkg": { "./a.js": slow } });
  try {
    const first = preview(env, "gate-a", {});
    await settle();
    const second = await preview(env, "gate-a", {});
    assertEquals(second.status, 429);
    assertStringIncludes((await second.json() as SourcePreviewResponse).error ?? "", "already running");
    ((globalThis as Record<string, unknown>).__mptReleaseGate as () => void)();
    assertEquals((await first).status, 200);
    const third = await preview(env, "gate-a", {});
    assertEquals(third.status, 429);
    assert(third.headers.get("Retry-After"), "no Retry-After");
  } finally {
    cleanup(env);
  }
});

test("PUT config: validates, writes packages[].config keeping the rest, re-inits with the new options, and syncs", async () => {
  const env = await setup(
    [
      "./other-pkg",
      { source: "./save-pkg", config: { project: "OLD", apiToken: "keep-me" } },
    ],
    { "save-pkg": { "./a.js": sourceModule("save-a", { failSync: true }) }, "other-pkg": { "./o.js": sourceModule("save-other") } },
  );
  try {
    const bad = await put(env, "save-a", { project: "nope" });
    assertEquals(bad.status, 400);
    assertEquals((await bad.json() as SourceConfigResponse).fieldErrors?.[0]?.path, "project");
    assertEquals((await put(env, "story", {})).status, 409);
    assertEquals((await put(env, "no-such", {})).status, 404);

    // Back off the source first, so the save is seen resetting it.
    const failing = await put(env, "save-a", { project: "FAIL", apiToken: REDACTED_SETTING });
    assertEquals(failing.status, 200);
    await settle();
    assert(env.store.syncFailures("save-a") >= 1, "the FAIL project should have failed its sync");

    const res = await put(env, "save-a", { project: "NEW", maxItems: 3, apiToken: REDACTED_SETTING });
    assertEquals(res.status, 200);
    const body = await res.json() as SourceConfigResponse;
    assertEquals(body.success, true);
    assertEquals(body.reinit, [{ id: "save-a", ok: true }]);
    assertEquals(body.source?.options.project, "NEW");

    // Persisted: the redacted secret kept, the other entry and unrelated keys untouched.
    const disk = env.onDisk();
    assertEquals(disk.packages, ["./other-pkg", { source: "./save-pkg", config: { project: "NEW", maxItems: 3, apiToken: "keep-me" } }]);
    assertEquals(disk.favoriteDirectories, ["/tmp/fav"]);

    // Re-init: init ran again and sees the new options; backoff reset; a sync ran with them.
    const inits = calls()["save-a"]!;
    assertEquals(inits.length, 3);
    assertEquals(inits[2], { project: "NEW", maxItems: 3, apiToken: "keep-me" });
    assertEquals(calls()["save-other"]?.length, 1);
    await settle();
    assertEquals(env.store.syncFailures("save-a"), 0);
    const mirrors = env.store.getWorkDefs("active").filter((d) => d.parent?.kind === "external");
    assertEquals(mirrors.map((d) => d.goal), ["project NEW"]);

    // A later Config-page save doesn't erase packages (serializeConfig keeps them).
    const cfg = await (await env.request("/api/config")).json() as Record<string, unknown>;
    const saved = await env.request("/api/config", { method: "PUT", body: JSON.stringify(cfg) });
    assertEquals(saved.status, 200);
    assertEquals((env.onDisk().packages as unknown[]).length, 2);
  } finally {
    cleanup(env);
  }
});

test("PUT config: a switched-off source is saved and re-inited but not synced", async () => {
  const env = await setup([{ source: "./off-pkg", config: { project: "A" } }], { "off-pkg": { "./a.js": sourceModule("off-a") } },
    { features: { "off-a": false } as TeamConfig["features"] });
  try {
    const res = await put(env, "off-a", { project: "B" });
    assertEquals(res.status, 200);
    await settle();
    assertEquals(calls()["off-a"]?.at(-1), { project: "B" });
    assertEquals(env.store.getWorkDefs("all").filter((d) => d.parent?.kind === "external").length, 0);
    assertEquals((await viewOf(env, "off-a")).toggle, { feature: "off-a", enabled: false });
  } finally {
    cleanup(env);
  }
});

test("PUT config: source scope keeps sibling blocks; a string entry becomes { source, config }; all siblings re-init", async () => {
  const env = await setup(
    [{ source: "./multi-pkg", config: { "multi-b": { project: "BEE" }, shared: 1 } }],
    { "multi-pkg": { "./a.js": sourceModule("multi-a", { scope: "source" }), "./b.js": sourceModule("multi-b", { scope: "source" }) } },
  );
  try {
    const res = await put(env, "multi-a", { project: "AYE" });
    assertEquals(res.status, 200);
    const body = await res.json() as SourceConfigResponse;
    assertEquals(body.reinit?.map((r) => r.id), ["multi-a", "multi-b"]);
    const expected = { "multi-b": { project: "BEE" }, shared: 1, "multi-a": { project: "AYE" } };
    assertEquals(env.onDisk().packages, [{ source: "./multi-pkg", config: expected }]);
    assertEquals(calls()["multi-b"]?.at(-1), expected);
    assertEquals((await viewOf(env, "multi-b")).options, { project: "BEE" });
  } finally {
    cleanup(env);
  }

  const bare = await setup(["./bare-pkg"], { "bare-pkg": { "./a.js": sourceModule("bare-a") } });
  try {
    assertEquals((await put(bare, "bare-a", { project: "X" })).status, 200);
    assertEquals(bare.onDisk().packages, [{ source: "./bare-pkg", config: { project: "X" } }]);
  } finally {
    cleanup(bare);
  }
});

test("PUT config: a re-init that throws keeps the new config saved, reports it, and marks the source errored", async () => {
  const env = await setup([{ source: "./err-pkg", config: { project: "OK" } }], { "err-pkg": { "./a.js": sourceModule("err-a", { failInitOn: "BAD" }) } });
  try {
    const res = await put(env, "err-a", { project: "BAD" });
    assertEquals(res.status, 200);
    const body = await res.json() as SourceConfigResponse;
    assertEquals(body.success, true);
    assertEquals(body.reinit, [{ id: "err-a", ok: false, error: "bad project" }]);
    assertStringIncludes(body.error ?? "", "bad project");
    assertEquals(body.source?.initError, "bad project");
    assertEquals(env.onDisk().packages, [{ source: "./err-pkg", config: { project: "BAD" } }]);
    // Fixing it clears the error.
    await put(env, "err-a", { project: "GOOD" });
    assertEquals((await viewOf(env, "err-a")).initError, undefined);
  } finally {
    cleanup(env);
  }
});

test("the source routes sit behind the API token, like PUT /api/config", async () => {
  const env = await setup(["./auth-pkg"], { "auth-pkg": { "./a.js": sourceModule("auth-a") } }, { apiToken: "tok" });
  try {
    assertEquals((await env.request("/api/sources")).status, 200);
    const app = buildApp(env.store, env.config, env.teamDir);
    assertEquals((await app.request("/api/sources")).status, 401);
    assertEquals((await app.request("/api/sources/auth-a/config", { method: "PUT", body: "{}" })).status, 401);
  } finally {
    cleanup(env);
  }
});

test("settings helpers: redaction round-trips, env refs by key convention, package entry lookup", () => {
  const v = viewSettings(undefined, { password: "p", tokenEnv: "TOK", nested: { secret: "s", ok: 1 }, n: 2 }, { TOK: "x" });
  assertEquals(v.options, { password: REDACTED_SETTING, tokenEnv: "TOK", nested: { secret: REDACTED_SETTING, ok: 1 }, n: 2 });
  assertEquals(v.redacted, ["password", "nested.secret"]);
  assertEquals(v.envVars, [{ path: "tokenEnv", name: "TOK", set: true }]);
  // A pasted secret under an env-var key is redacted, not shown as a "name".
  assertEquals(viewSettings(undefined, { tokenEnv: "ghp_abc-123 xyz" }).redacted, ["tokenEnv"]);
  assertEquals(restoreRedacted(v.options, { password: "p", nested: { secret: "s" } }), { password: "p", tokenEnv: "TOK", nested: { secret: "s", ok: 1 }, n: 2 });
  assertEquals(restoreRedacted({ password: REDACTED_SETTING }, {}), {});
  const r = setPackageEntryConfig(["./a", { source: "./b", config: { x: 1 }, note: "kept" } as PackageEntry], "/t/b", { y: 2 }, "/t");
  assert(!("error" in r));
  assertEquals(r.packages, ["./a", { source: "./b", config: { y: 2 }, note: "kept" }]);
  assert("error" in setPackageEntryConfig(["./a"], "/t/zzz", {}, "/t"));
});
