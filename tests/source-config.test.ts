/**
 * tests/source-config.test.ts — A Work Source's settings schema and preview
 * (daemon/sources/config-schema.ts, daemon/sources/preview.ts).
 * See docs/DESIGN.md "Plugin settings: configSchema and preview".
 *
 * Covers: validating settings against the supported JSON Schema subset
 * (types, enums, required, env-var names, nested objects, arrays, unknown
 * keys) with field-level paths; schemas outside the subset; the settings
 * block per `configScope`; the restricted preview context (no mirror, no
 * enqueue, no persisted kv, options = the draft); a source's own `preview`;
 * the default preview via `sync`; timeouts, throws, and bad results; and
 * load-time warnings (logged, recorded, never refused).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { loadPlugins } from "../daemon/plugins/loader.ts";
import {
  checkConfigSchema,
  sourceConfigBlock,
  sourceConfigWarnings,
  validateSourceConfig,
  withSourceConfigBlock,
} from "../daemon/sources/config-schema.ts";
import { previewSource } from "../daemon/sources/preview.ts";
import type { ExternalDef, SourceConfigSchema, SourcePreview, WorkSource } from "../daemon/sources/types.ts";

const SCHEMA: SourceConfigSchema = {
  type: "object",
  required: ["project"],
  additionalProperties: false,
  properties: {
    project: { type: "string", title: "Project key", placeholder: "ACME", pattern: "^[A-Z]+$" },
    tokenEnv: { type: "string", format: "env-var", default: "ACME_TOKEN" },
    status: { type: "string", enum: ["open", "all"] },
    maxItems: { type: "integer", minimum: 1, maximum: 50 },
    dryRun: { type: "boolean" },
    labels: { type: "array", items: { type: "string" }, uniqueItems: true },
    filter: { type: "object", properties: { assignee: { type: "string" }, priority: { type: "number", enum: [1, 2, 3] } } },
  },
};

test("valid settings pass; each kind of mistake is a field-level error", () => {
  assertEquals(validateSourceConfig(SCHEMA, { project: "ACME", tokenEnv: "ACME_TOKEN", status: "open", maxItems: 5, dryRun: true, labels: ["a", "b"], filter: { assignee: "me", priority: 2 } }), []);
  // Missing optional fields (and nulls) are fine.
  assertEquals(validateSourceConfig(SCHEMA, { project: "ACME", status: null }), []);
  const errors = validateSourceConfig(SCHEMA, {
    tokenEnv: "ghp_abc-123 secret", status: "closed", maxItems: 2.5, dryRun: "yes",
    labels: ["a", 3, "a"], filter: { priority: 9 }, extra: 1,
  });
  const byPath = Object.fromEntries(errors.map((e) => [e.path, e.message]));
  assertEquals(byPath.project, "is required");
  assertStringIncludes(byPath.tokenEnv ?? "", "name of an environment variable");
  assertStringIncludes(byPath.status ?? "", "one of open, all");
  assertEquals(byPath.maxItems, "must be a whole number");
  assertEquals(byPath.dryRun, "must be true or false");
  assertEquals(byPath.labels, "must not repeat an item");
  assertStringIncludes(byPath["filter.priority"] ?? "", "one of 1, 2, 3");
  assertEquals(byPath.extra, "is not a known setting");
  assertEquals(validateSourceConfig(SCHEMA, { project: "acme" })[0]?.message, "must match ^[A-Z]+$");
  assertEquals(validateSourceConfig(SCHEMA, { project: "ACME", maxItems: 99 })[0], { path: "maxItems", message: "must be at most 50" });
  assertEquals(validateSourceConfig(SCHEMA, { project: "ACME", labels: ["ok", 3] })[0], { path: "labels[1]", message: "must be text" });
  assertEquals(validateSourceConfig(SCHEMA, []), [{ path: "", message: "must be an object" }]);
});

test("schemas outside the supported subset are reported, not enforced", () => {
  assertEquals(checkConfigSchema(SCHEMA), []);
  assertStringIncludes(checkConfigSchema({ type: "array" })[0] ?? "", 'type "object"');
  assertStringIncludes(checkConfigSchema({ type: "object", properties: { a: { type: "null" } } })[0] ?? "", "unsupported type");
  assertStringIncludes(
    checkConfigSchema({ type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: {} } } } } })[0] ?? "",
    "one level",
  );
  assertStringIncludes(checkConfigSchema({ type: "object", properties: { a: { type: "array", items: { type: "number" } } } })[0] ?? "", "items");
  assertStringIncludes(checkConfigSchema({ type: "object", properties: { a: { type: "string", pattern: "(" } } })[0] ?? "", "pattern");
  // An unusable schema validates nothing beyond "is an object".
  assertEquals(validateSourceConfig({ type: "object", properties: { a: { type: "null" } } } as unknown as SourceConfigSchema, { a: 1 }), []);
});

test("the settings block follows configScope: the whole config, or config[<id>]", () => {
  const flat = { id: "acme" };
  const ns = { id: "sim-t", configScope: "source" as const };
  const entry = { "sim-t": { maxItems: 3 }, taskei: { maxItems: 9 } };
  assertEquals(sourceConfigBlock(flat, { project: "A" }), { project: "A" });
  assertEquals(sourceConfigBlock(ns, entry), { maxItems: 3 });
  assertEquals(sourceConfigBlock(ns, {}), {});
  assertEquals(withSourceConfigBlock(flat, { project: "A" }, { project: "B" }), { project: "B" });
  // The other source's block in the same package is kept.
  assertEquals(withSourceConfigBlock(ns, entry, { maxItems: 5 }), { "sim-t": { maxItems: 5 }, taskei: { maxItems: 9 } });
});

interface Env {
  teamDir: string;
  store: Store;
  logs: string[];
}

function setup(): Env {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-source-config-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  return { teamDir, store: new Store(teamDir, TEST_CONFIG), logs: [] };
}

function cleanup({ store, teamDir }: Env): void {
  store.close();
  try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const item = (externalId: string, extra: Partial<ExternalDef> = {}): ExternalDef =>
  ({ externalId, revision: "r1", title: `Item ${externalId}`, goal: "do it", ...extra });

/** Register `source` (with `options`) and return its registry entry. */
function register(env: Env, source: WorkSource, options: Record<string, unknown> = {}) {
  env.store.registerWorkSource(source, { options });
  return env.store.listWorkSources().find((e) => e.source.id === source.id)!;
}

test("default preview runs sync on a restricted ctx: the draft as options, and no side effects", async () => {
  const env = setup();
  try {
    let seenOptions: unknown;
    const source: WorkSource = {
      id: "acme", apiVersion: 1, configSchema: SCHEMA, syncEveryMs: () => null,
      async sync(ctx) {
        seenOptions = ctx.options();
        // A sync that writes through ctx: none of it may stick during a preview.
        ctx.kv.set("cursor", "moved");
        assertEquals(ctx.kv.get("cursor"), "moved");
        ctx.kv.delete("token");
        assertEquals(ctx.kv.get("token"), undefined);
        assertEquals(ctx.upsertDef(item("side")), null);
        assertEquals(ctx.enqueue("acme~side"), null);
        assertEquals(ctx.enqueueRevision("acme~side", "r1"), null);
        return [item(`${ctx.options().project}-1`), { externalId: "bad" } as ExternalDef, item(`${ctx.options().project}-1`)];
      },
    };
    const entry = register(env, source, { project: "OLD" });
    entry.ctx.kv.set("token", "keep");

    const outcome = await previewSource(entry, { project: "NEW" });
    assert(outcome.ok, JSON.stringify(outcome));
    assertEquals(outcome.via, "sync");
    assertEquals(seenOptions, { project: "NEW" });
    assertEquals(outcome.preview.items.map((i) => i.externalId), ["NEW-1"]);
    const warnings = outcome.preview.warnings ?? [];
    for (const w of ["ctx.upsertDef", "ctx.enqueue ", "ctx.enqueueRevision", "item 2 would be skipped: missing 'revision'", "is repeated"]) {
      assert(warnings.some((x) => x.includes(w.trim())), `expected a warning about ${w}: ${JSON.stringify(warnings)}`);
    }

    // Nothing happened for real: no mirror, no work item, kv untouched, options unchanged.
    assertEquals(env.store.getWorkDefs().filter((d) => d.parent?.kind === "external").length, 0);
    assertEquals(env.store.getWorkItems().total, 0);
    assertEquals(entry.ctx.kv.get("cursor"), undefined);
    assertEquals(entry.ctx.kv.get("token"), "keep");
    assertEquals(entry.ctx.options(), { project: "OLD" });
  } finally {
    cleanup(env);
  }
});

test("a source's own preview is used, gets the draft in place per configScope, and its warnings/note come back", async () => {
  const env = setup();
  try {
    let syncCalled = false;
    const calls: Array<{ draft: unknown; options: unknown }> = [];
    const source: WorkSource = {
      id: "sim-t", apiVersion: 1, configScope: "source",
      configSchema: { type: "object", properties: { maxItems: { type: "integer", minimum: 1 } } },
      syncEveryMs: () => null,
      async sync() { syncCalled = true; return []; },
      async preview(ctx, draft): Promise<SourcePreview> {
        calls.push({ draft, options: ctx.options() });
        return { items: [item("SIM-1")], warnings: ["2 more hidden"], note: "first 1 of 3" };
      },
    };
    const entry = register(env, source, { "sim-t": { maxItems: 9 }, taskei: { maxItems: 4 } });
    const outcome = await previewSource(entry, { maxItems: 1 });
    assert(outcome.ok, JSON.stringify(outcome));
    assertEquals(outcome.via, "preview");
    assertEquals(syncCalled, false);
    assertEquals(calls[0]?.draft, { "sim-t": { maxItems: 1 }, taskei: { maxItems: 4 } });
    assertEquals(calls[0]?.options, calls[0]?.draft);
    assertEquals(outcome.preview, { items: [item("SIM-1")], warnings: ["2 more hidden"], note: "first 1 of 3" });

    // An invalid draft is refused with field errors, without calling the source.
    const bad = await previewSource(entry, { maxItems: 0 });
    assert(!bad.ok);
    assertEquals(bad.fieldErrors, [{ path: "maxItems", message: "must be at least 1" }]);
    assertEquals(calls.length, 1);
    const notObject = await previewSource(entry, "nope");
    assert(!notObject.ok);
  } finally {
    cleanup(env);
  }
});

test("a preview is bounded by syncTimeoutMs; throws and bad results are errors, never rejections", async () => {
  const env = setup();
  try {
    const hang = register(env, { id: "hang", apiVersion: 1, syncTimeoutMs: 30, syncEveryMs: () => null, sync: () => new Promise<ExternalDef[]>(() => {}) });
    const timedOut = await previewSource(hang, {});
    assert(!timedOut.ok);
    assertStringIncludes(timedOut.error, "timed out after 30ms");

    const slowPreview = register(env, {
      id: "slow", apiVersion: 1, syncTimeoutMs: 20, syncEveryMs: () => null,
      sync: async () => [], preview: () => new Promise<SourcePreview>(() => {}),
    });
    const r = await previewSource(slowPreview, {});
    assert(!r.ok);
    assertStringIncludes(r.error, "preview timed out");

    const throws = register(env, { id: "throws", apiVersion: 1, syncEveryMs: () => null, sync: () => { throw new Error("no token"); } });
    const thrown = await previewSource(throws, {});
    assertEquals(thrown, { ok: false, error: "no token" });

    const garbage = register(env, { id: "garbage", apiVersion: 1, syncEveryMs: () => null, sync: async () => "nope" as unknown as ExternalDef[] });
    assertEquals(await previewSource(garbage, {}), { ok: false, error: "sync did not return an array" });

    const local = register(env, { id: "local-only", apiVersion: 1 });
    const none = await previewSource(local, {});
    assert(!none.ok);
    assertStringIncludes(none.error, "nothing to preview");
  } finally {
    cleanup(env);
  }
});

test("settings that don't match the schema are a load-time warning, not a refusal", async () => {
  const env = setup();
  try {
    assertEquals(sourceConfigWarnings({ id: "x", apiVersion: 1 }, { anything: 1 }), []);
    const dir = path.join(env.teamDir, "acme");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "acme", type: "module", mpt: { sources: ["./index.js"] } }));
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default {
        id: "acme", apiVersion: 1, syncEveryMs: () => null, async sync() { return []; },
        configSchema: ${JSON.stringify(SCHEMA)},
      };`);
    const statuses = await loadPlugins(env.store, { packages: [{ source: "./acme", config: { tokenEnv: "not a name" } }] }, env.teamDir, {
      log: (m) => env.logs.push(m),
    });
    assertEquals(statuses[0]?.state, "loaded");
    assertEquals(statuses[0]?.sources, ["acme"]);
    const warnings = statuses[0]?.warnings ?? [];
    assert(warnings.some((w) => w.includes('source "acme": config.project: is required')), JSON.stringify(warnings));
    assert(warnings.some((w) => w.includes("config.tokenEnv: must be the name of an environment variable")), JSON.stringify(warnings));
    assert(env.logs.some((l) => l.includes("warning:") && l.includes("config.project")), JSON.stringify(env.logs));
  } finally {
    cleanup(env);
  }
});
