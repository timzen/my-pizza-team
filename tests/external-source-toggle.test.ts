/**
 * tests/external-source-toggle.test.ts — On/off for external Work Sources, and
 * disconnecting one. See docs/DESIGN.md "Feature Toggles" (external sources).
 *
 * Covers: the default toggle an external source gets (`features.<id>`) and the
 * `toggle: null` opt-out; feature-name collisions refused at registration; the
 * sync loop, ticks, and `ctx.upsertDef`/`enqueue` doing nothing while a source
 * is off (and an in-flight sync's result dropped); switching it back on syncing
 * at once; the 409 guard without the opt-in; and `POST
 * /api/work-sources/:id/disconnect` archiving mirrors, canceling READY items,
 * leaving IN_PROGRESS ones, and restoring the mirrors when switched back on.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { FIXTURE_SOURCE_ID, FixtureSource } from "../daemon/sources/fixture.ts";
import { mirroredWorkDefId } from "../daemon/sources/mirror.ts";
import { defaultExternalToggle, effectiveToggle } from "../daemon/sources/registry.ts";
import type { ExternalDef, SourceContext, WorkSource } from "../daemon/sources/types.ts";
import { featureNames } from "../daemon/features.ts";
import type { FeaturesConfig, TeamConfig } from "../shared/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const put = (body: unknown) => ({ method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
const postReq = { method: "POST", headers: JSON_HEADERS, body: "{}" };

interface Env {
  store: Store;
  config: TeamConfig;
  teamDir: string;
  folder: string;
  app: ReturnType<typeof buildApp>;
  cleanup(): void;
}

/** A Store + app with the fixture source registered (demand-only sync), before `buildApp` like a plugin. */
function setup(features?: Record<string, boolean>): Env {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-ext-toggle-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const folder = path.join(teamDir, "external");
  fs.mkdirSync(folder);
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), ...(features ? { features: features as FeaturesConfig } : {}) };
  const store = new Store(teamDir, config);
  store.registerWorkSource(new FixtureSource({ dir: folder, label: "Fixture Tracker", syncEveryMs: null }));
  const app = buildApp(store, config, teamDir);
  const cleanup = () => { store.close(); try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ } };
  return { store, config, teamDir, folder, app, cleanup };
}

function writeItem(folder: string, externalId: string, title: string): void {
  fs.writeFileSync(path.join(folder, `${externalId}.md`), `---\ntitle: ${title}\n---\n## Goal\n\nDo ${title}\n`);
}

/** A PUT /api/config body that changes only `features`. */
function featuresBody(config: TeamConfig, features: unknown) {
  return { defaultWorkflow: config.defaultWorkflow, workflows: config.workflows, features };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

/** A minimal external source with a controllable sync. */
function externalSource(id: string, extra: Partial<WorkSource> = {}): WorkSource {
  return { id, apiVersion: 1, sync: async () => [], ...extra };
}

// ─── The default toggle ─────────────────────────────────────────────

test("an external source without a toggle gets features.<id>; toggle: null opts out; in-daemon sources get none", () => {
  assertEquals(effectiveToggle(externalSource("jira")), defaultExternalToggle("jira"));
  assertEquals(effectiveToggle(externalSource("jira"))?.feature, "jira");
  assertEquals(effectiveToggle(externalSource("jira", { toggle: null })), null);
  assertEquals(effectiveToggle({ id: "plain", apiVersion: 1 }), null);
  const own = { feature: "tracker" };
  assertEquals(effectiveToggle(externalSource("jira", { toggle: own })), own);
});

test("the default toggle is exposed by /api/status and GET /api/config, with label and kind", async () => {
  const env = setup();
  try {
    assertEquals(featureNames(env.store), ["stories", "tasks", "schedules", FIXTURE_SOURCE_ID]);
    const status = await (await env.app.request("/api/status")).json();
    assertEquals(status.features[FIXTURE_SOURCE_ID], true);
    assertEquals(status.externalSources, [{ id: FIXTURE_SOURCE_ID, label: "Fixture Tracker", feature: FIXTURE_SOURCE_ID }]);
    const cfg = await (await env.app.request("/api/config")).json();
    assertEquals(cfg.featureUsage[FIXTURE_SOURCE_ID], { count: 0, description: "0 items" });
    assertEquals(cfg.featureSources.map((f: { feature: string }) => f.feature), ["stories", "tasks", "schedules", FIXTURE_SOURCE_ID]);
    assertEquals(cfg.featureSources[3], { feature: FIXTURE_SOURCE_ID, sourceId: FIXTURE_SOURCE_ID, label: "Fixture Tracker", external: true });
    assertEquals(cfg.featureSources[0].external, false);
  } finally { env.cleanup(); }
});

test("a source's frozen object is never mutated: the toggle lives on the registry entry", () => {
  const env = setup();
  try {
    const frozen = Object.freeze(externalSource("frozen-one"));
    env.store.registerWorkSource(frozen);
    assertEquals("toggle" in frozen, false);
    assertEquals(env.store.listWorkSources().find((e) => e.source.id === "frozen-one")!.toggle!.feature, "frozen-one");
  } finally { env.cleanup(); }
});

test("feature names can't collide: built-in names are reserved, and one name has one source", () => {
  const env = setup();
  try {
    // An external source named after a built-in feature (its default toggle would be "stories").
    assertThrows(() => env.store.registerWorkSource(externalSource("stories")), Error, "reserved for the built-in");
    assertThrows(() => env.store.registerWorkSource(externalSource("jira", { toggle: { feature: "tasks" } })), Error, "reserved for the built-in");
    // The fixture already owns "fixture".
    assertThrows(() => env.store.registerWorkSource(externalSource("other", { toggle: { feature: FIXTURE_SOURCE_ID } })), Error, "already used by source");
    // Nothing half-registered.
    assertEquals(env.store.listWorkSources().some((e) => e.source.id === "stories" || e.source.id === "other"), false);
    // Opting out never collides.
    env.store.registerWorkSource(externalSource("always-on", { toggle: null }));
    assertEquals(featureNames(env.store).includes("always-on"), false);
  } finally { env.cleanup(); }
});

// ─── Off means off ──────────────────────────────────────────────────

test("a switched-off external source isn't synced (even forced), and its routes 403", async () => {
  const env = setup({ [FIXTURE_SOURCE_ID]: false });
  try {
    writeItem(env.folder, "T-1", "One");
    const outcome = await env.store.syncWorkSource(FIXTURE_SOURCE_ID, { force: true });
    assertEquals(outcome.ok, false);
    assertEquals(outcome.skipped, "disabled");
    assertEquals(env.store.getWorkDef(mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1")), null);
    assertEquals((await env.app.request(`/api/work-sources/${FIXTURE_SOURCE_ID}/sync`, postReq)).status, 403);
    assertEquals((await env.app.request(`/api/work-sources/${FIXTURE_SOURCE_ID}/defs`)).status, 403);
    // The list still names it, so the UI can explain it's off.
    assertEquals((await (await env.app.request("/api/work-sources")).json()).sources.length, 1);
  } finally { env.cleanup(); }
});

test("a switched-off external source isn't ticked, and its ctx mirrors and enqueues nothing", () => {
  const env = setup({ hooky: false });
  try {
    let ticks = 0;
    let ctx: SourceContext | null = null;
    env.store.registerWorkSource(externalSource("hooky", {
      init: (c) => { ctx = c; },
      tick: () => { ticks++; },
    }));
    env.store.tickWorkSources();
    assertEquals(ticks, 0);
    const ext: ExternalDef = { externalId: "H-1", revision: "r1", title: "Hook", goal: "g" };
    assertEquals(ctx!.upsertDef(ext), null);
    env.config.features = { ...env.config.features, hooky: true } as FeaturesConfig;
    env.store.tickWorkSources();
    assertEquals(ticks, 1);
    const def = ctx!.upsertDef(ext);
    assert(def);
    env.config.features = { ...env.config.features, hooky: false } as FeaturesConfig;
    assertEquals(ctx!.enqueue(def.id), null);
    assertEquals(ctx!.enqueueRevision(def.id, "r1"), null);
  } finally { env.cleanup(); }
});

test("a sync in flight when the source is switched off has its result dropped", async () => {
  const env = setup();
  try {
    let release!: (defs: ExternalDef[]) => void;
    env.store.registerWorkSource(externalSource("slowpoke", {
      sync: () => new Promise<ExternalDef[]>((r) => { release = r; }),
    }));
    const pending = env.store.syncWorkSource("slowpoke");
    await settle();
    env.config.features = { ...env.config.features, slowpoke: false } as FeaturesConfig;
    release([{ externalId: "S-1", revision: "r1", title: "Slow", goal: "g" }]);
    const outcome = await pending;
    assertEquals(outcome.skipped, "disabled");
    assertEquals(env.store.getWorkDef(mirroredWorkDefId("slowpoke", "S-1")), null);
  } finally { env.cleanup(); }
});

test("switching an external source back on syncs it at once", async () => {
  const env = setup({ [FIXTURE_SOURCE_ID]: false });
  try {
    writeItem(env.folder, "T-1", "One");
    const res = await env.app.request("/api/config", put(featuresBody(env.config, { [FIXTURE_SOURCE_ID]: true })));
    assertEquals(res.status, 200);
    await settle();
    assert(env.store.getWorkDef(mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1")), "mirrored by the immediate sync");
  } finally { env.cleanup(); }
});

// ─── Disconnect ─────────────────────────────────────────────────────

test("switching off an external source with mirrors is 409 without the opt-in, naming disconnect", async () => {
  const env = setup();
  try {
    writeItem(env.folder, "T-1", "One");
    await env.store.syncWorkSource(FIXTURE_SOURCE_ID);
    const res = await env.app.request("/api/config", put(featuresBody(env.config, { [FIXTURE_SOURCE_ID]: false })));
    assertEquals(res.status, 409);
    const { error } = await res.json();
    assertStringIncludes(error, `Can't turn off ${FIXTURE_SOURCE_ID}: archive or delete 1 item first`);
    assertStringIncludes(error, `POST /api/work-sources/${FIXTURE_SOURCE_ID}/disconnect`);
    assertEquals(env.config.features?.[FIXTURE_SOURCE_ID as keyof FeaturesConfig], undefined);
    // A built-in's message is exactly as before.
    env.store.createStory("s1", "S", "");
    const story = await env.app.request("/api/config", put(featuresBody(env.config, { stories: false })));
    assertEquals(story.status, 409);
    assertEquals((await story.json()).error.includes("disconnect"), false);
  } finally { env.cleanup(); }
});

test("disconnect archives mirrors, cancels READY items, leaves IN_PROGRESS ones, switches off and saves", async () => {
  const env = setup();
  try {
    const { store, app, folder, teamDir, config } = env;
    writeItem(folder, "T-1", "One");
    writeItem(folder, "T-2", "Two");
    const first = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(first.enqueued.length, 2);
    const id1 = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    const id2 = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-2");
    const running = store.getActiveWorkItemForTask(id1)!;
    const ready = store.getActiveWorkItemForTask(id2)!;
    store.registerMember("a1", "a1", "/x", {});
    store.claimWorkItem(running.id, "a1");

    const res = await app.request(`/api/work-sources/${FIXTURE_SOURCE_ID}/disconnect`, postReq);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.feature, FIXTURE_SOURCE_ID);
    assertEquals([...body.archived].sort(), [id1, id2].sort());

    assertEquals(store.getWorkDef(id1)!.status, "archived");
    assertEquals(store.getWorkDef(id2)!.status, "archived");
    assertEquals(store.getWorkItem(ready.id)!.state, "CANCELED");
    assertEquals(store.getWorkItem(running.id)!.state, "IN_PROGRESS");
    assertEquals((config.features as Record<string, boolean>)[FIXTURE_SOURCE_ID], false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as TeamConfig;
    assertEquals((onDisk.features as Record<string, boolean>)[FIXTURE_SOURCE_ID], false);
    // Built-ins stored in full alongside, as a PUT would.
    assertEquals((onDisk.features as Record<string, boolean>).stories, true);
    const cfg = await (await app.request("/api/config")).json();
    assertEquals(cfg.featureUsage[FIXTURE_SOURCE_ID].count, 0);
    // The in-flight item still completes.
    assertEquals(store.setWorkItemState(running.id, "COMPLETE").ok !== false, true);
    // Idempotent.
    assertEquals((await app.request(`/api/work-sources/${FIXTURE_SOURCE_ID}/disconnect`, postReq)).status, 200);

    // Switched back on: sync restores the mirrors; an unchanged revision doesn't re-run.
    const on = await app.request("/api/config", put(featuresBody(config, { [FIXTURE_SOURCE_ID]: true })));
    assertEquals(on.status, 200);
    await settle(); // the immediate sync the re-enable fired
    assertEquals(store.getWorkDef(id1)!.status, "active");
    assertEquals(store.getWorkDef(id2)!.status, "active");
    assertEquals(store.getActiveWorkItemForTask(id2), null, "its revision was already handed over");
  } finally { env.cleanup(); }
});

test("a mirror a person archived stays archived after a disconnect and reconnect", async () => {
  const env = setup();
  try {
    writeItem(env.folder, "T-1", "One");
    await env.store.syncWorkSource(FIXTURE_SOURCE_ID);
    const id1 = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    env.store.archiveWorkDef(id1);
    const res = await env.app.request(`/api/work-sources/${FIXTURE_SOURCE_ID}/disconnect`, postReq);
    assertEquals((await res.json()).archived, []);
    env.config.features = { ...env.config.features, [FIXTURE_SOURCE_ID]: true } as FeaturesConfig;
    await env.store.syncWorkSource(FIXTURE_SOURCE_ID, { force: true });
    assertEquals(env.store.getWorkDef(id1)!.status, "archived");
  } finally { env.cleanup(); }
});

test("disconnect is only for external sources with a toggle", async () => {
  const env = setup();
  try {
    env.store.registerWorkSource(externalSource("always-on", { toggle: null }));
    assertEquals((await env.app.request("/api/work-sources/story/disconnect", postReq)).status, 404);
    assertEquals((await env.app.request("/api/work-sources/nope/disconnect", postReq)).status, 404);
    const res = await env.app.request("/api/work-sources/always-on/disconnect", postReq);
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).error, "toggle: null");
  } finally { env.cleanup(); }
});
