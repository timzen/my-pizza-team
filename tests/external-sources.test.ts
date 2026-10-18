/**
 * tests/external-sources.test.ts — External (pull-only) Work Sources, driven by
 * the in-repo markdown-folder fixture source (daemon/sources/fixture.ts).
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins" (external sources).
 *
 * Covers: mirrored defs (namespaced, file-system-safe ids, read-only on disk),
 * the sync loop (one WorkItem per revision, readiness hold, vanish → archive,
 * reappear → restore), write-back (`onComment`, `onItemTerminal` on COMPLETE /
 * FAILED / CANCELED), the routes' refusals (edit, delete, create) with the
 * thread still working, failure isolation (a throwing or hanging source never
 * stalls the others; backoff), and the generic read-only routes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from "./_assert.ts";
import * as path from "node:path";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { registerDevSources } from "../daemon/app.ts";
import { FIXTURE_SOURCE_ID, FIXTURE_WRITEBACK_FILE, FixtureSource } from "../daemon/sources/fixture.ts";
import { invalidExternalDef, mirroredWorkDefId, mirrorRevisionKey, vanishedKey } from "../daemon/sources/mirror.ts";
import { SourceRegistry, sourceIdForWorkDef } from "../daemon/sources/registry.ts";
import { SyncRunner } from "../daemon/sources/sync.ts";
import { fileSourceKv } from "../daemon/store/source-kv.ts";
import type { ExternalDef, SourceContext, WorkSource } from "../daemon/sources/types.ts";
import { isMirroredWorkDef, workDefType } from "../shared/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface Env {
  store: Store;
  teamDir: string;
  folder: string;
  fixture: FixtureSource;
}

/** A Store with the fixture source registered on demand-only sync (no timers). */
function setup(): Env {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-ext-sources-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const folder = path.join(teamDir, "external");
  fs.mkdirSync(folder);
  const store = new Store(teamDir, TEST_CONFIG);
  const fixture = new FixtureSource({ dir: folder, label: "Fixture Tracker", syncEveryMs: null });
  store.registerWorkSource(fixture);
  return { store, teamDir, folder, fixture };
}

function cleanup({ store, teamDir }: Pick<Env, "store" | "teamDir">): void {
  store.close();
  try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Write one fixture item file. */
function writeItem(folder: string, externalId: string, title: string, goal: string, extra: { url?: string; directory?: string } = {}): void {
  const fm = [`title: ${title}`];
  if (extra.url) fm.push(`url: "${extra.url}"`);
  if (extra.directory) fm.push(`directory: ${extra.directory}`);
  fs.writeFileSync(
    path.join(folder, `${externalId}.md`),
    `---\n${fm.join("\n")}\n---\n## Goal\n\n${goal}\n\n## Acceptance Criteria\n\n- MUST work\n`,
  );
}

/** Let fire-and-forget (async) hooks settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A minimal context for registry-only tests. */
function stubContext(sourceId: string): SourceContext {
  const data = new Map<string, string>();
  return {
    sourceId, teamDir: "/nowhere", config: () => TEST_CONFIG, log: () => {},
    listWorkDefs: () => [], hasActiveItem: () => false, enqueue: () => null,
    enqueueRevision: () => null, upsertDef: () => null,
    kv: { get: (k) => data.get(k), set: (k, v) => { data.set(k, v); }, delete: (k) => { data.delete(k); } },
    readiness: { canEnqueueNow: () => true },
  };
}

// ─── Mirrored defs ──────────────────────────────────────────────────

test("mirroredWorkDefId: namespaced, file-system safe, and distinct per source and id", () => {
  assertEquals(mirroredWorkDefId("jira", "PROJ-123"), "jira~PROJ-123");
  const odd = mirroredWorkDefId("jira", "../a/b c_é");
  assert(/^[A-Za-z0-9~_-]+$/.test(odd), odd);
  assert(!odd.includes("/") && !odd.includes(".."));
  // `_` is always escaped, so an id containing an escape sequence can't collide.
  assertNotEquals(mirroredWorkDefId("jira", "a/b"), mirroredWorkDefId("jira", "a_2Fb"));
  assertNotEquals(mirroredWorkDefId("jira", "x"), mirroredWorkDefId("asana", "x"));
});

test("invalidExternalDef: externalId, revision, and title are required", () => {
  assertEquals(invalidExternalDef({ externalId: "a", revision: "1", title: "t", goal: "g" }), null);
  assertStringIncludes(invalidExternalDef({ externalId: "a", title: "t", goal: "" }) ?? "", "revision");
  assertStringIncludes(invalidExternalDef({ externalId: "", revision: "1", title: "t" }) ?? "", "externalId");
  assert(invalidExternalDef(null));
});

test("External parent: type 'External', owned by parent.source, mirrored", () => {
  const parent = { kind: "external" as const, id: "PROJ-1", source: "jira" };
  assertEquals(workDefType(parent), "External");
  assertEquals(sourceIdForWorkDef({ parent }), "jira");
  assert(isMirroredWorkDef({ parent }));
  assert(!isMirroredWorkDef({ parent: { kind: "story", id: "s" } }));
});

test("SourceRegistry: an external source's id must be file-system safe", () => {
  const reg = new SourceRegistry((id) => stubContext(id));
  const sync = () => Promise.resolve([]);
  assertThrows(() => reg.register({ id: "Bad/Id", apiVersion: 1, sync }), Error, "must match");
  reg.register({ id: "good-id", apiVersion: 1, sync });
  // A non-external source isn't held to it (its id names no directory).
  reg.register({ id: "Whatever", apiVersion: 1 });
  assertEquals(reg.external().map((e) => e.source.id), ["good-id"]);
});

// ─── Sync: mirror, one WorkItem per revision ────────────────────────

test("sync: mirrors each item read-only and enqueues once per revision", async () => {
  const env = setup();
  try {
    const { store, folder, teamDir } = env;
    writeItem(folder, "T-1", "First thing", "Do the first thing", { url: "https://tracker.example/T-1", directory: "/repo/one" });
    writeItem(folder, "T-2", "Second thing", "Do the second thing");

    const first = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assert(first.ok, first.error);
    const id1 = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    const id2 = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-2");
    assertEquals(first.mirrored.sort(), [id1, id2].sort());
    assertEquals(first.enqueued.length, 2);

    const def = store.getWorkDef(id1)!;
    assertEquals(def.title, "First thing");
    assertEquals(def.goal, "Do the first thing");
    assertEquals(def.url, "https://tracker.example/T-1");
    assertEquals(def.parent, { kind: "external", id: "T-1", source: FIXTURE_SOURCE_ID });
    assertEquals(store.getWorkSourceFor(def)?.source.id, FIXTURE_SOURCE_ID);
    // On disk it's an ordinary WorkDef file; the runtime state is in the source's kv.
    const raw = fs.readFileSync(path.join(teamDir, "tasks", id1, "workdef.md"), "utf8");
    assertStringIncludes(raw, "parentKind: external");
    assertStringIncludes(raw, "parentSource: fixture");
    assert(!raw.includes("revision"), "no runtime state in workdef.md");
    const kv = fileSourceKv(teamDir, FIXTURE_SOURCE_ID);
    assert(kv.get(mirrorRevisionKey(id1)));
    // The item runs where the external item says.
    const item1 = store.getActiveWorkItemForTask(id1)!;
    assertEquals(item1.title, "First thing");
    assertEquals(item1.directory, "/repo/one");

    // Unchanged → nothing new, even after the run finishes (once per revision).
    const again = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals([again.mirrored, again.enqueued], [[], []]);
    store.registerMember("a1", "a1", "/repo/one", {});
    assert(store.claimWorkItem(item1.id, "a1"));
    assert(store.setWorkItemState(item1.id, "COMPLETE").ok);
    assertEquals((await store.syncWorkSource(FIXTURE_SOURCE_ID)).enqueued, []);

    // A new revision → the mirror is rewritten and exactly one new item is created.
    writeItem(folder, "T-1", "First thing (v2)", "Do it better", { url: "https://tracker.example/T-1" });
    const moved = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(moved.mirrored, [id1]);
    assertEquals(moved.enqueued.length, 1);
    assertEquals(store.getWorkDef(id1)!.title, "First thing (v2)");
    assertEquals((await store.syncWorkSource(FIXTURE_SOURCE_ID)).enqueued, []);
  } finally {
    cleanup(env);
  }
});

test("sync: a revision landing while an item is in flight runs once that item ends", async () => {
  const env = setup();
  try {
    const { store, folder } = env;
    writeItem(folder, "T-1", "Thing", "v1");
    await store.syncWorkSource(FIXTURE_SOURCE_ID);
    const id = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    const item = store.getActiveWorkItemForTask(id)!;
    store.registerMember("a1", "a1", "/x", {});
    store.claimWorkItem(item.id, "a1");

    writeItem(folder, "T-1", "Thing", "v2");
    const during = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(during.mirrored, [id]); // the mirror follows at once
    assertEquals(during.enqueued, []); // but one run at a time
    store.setWorkItemState(item.id, "COMPLETE");
    assertEquals((await store.syncWorkSource(FIXTURE_SOURCE_ID)).enqueued.length, 1);
  } finally {
    cleanup(env);
  }
});

test("sync: readiness gating holds a new revision, and the next ready sync enqueues it", async () => {
  const env = setup();
  try {
    const { store, folder } = env;
    store.registerMember("a1", "a1", "/x", {});
    store.setTeamReadiness(false, "creds expired");
    writeItem(folder, "T-1", "Thing", "v1");
    const held = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    const id = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    assertEquals(held.mirrored, [id]); // mirrored even while not ready
    assertEquals(held.held, [id]);
    assertEquals(held.enqueued, []);
    store.setTeamReadiness(true);
    const ready = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(ready.enqueued.length, 1);
  } finally {
    cleanup(env);
  }
});

test("sync: a vanished item's mirror is archived (not deleted), and comes back if it reappears", async () => {
  const env = setup();
  try {
    const { store, folder, teamDir } = env;
    writeItem(folder, "T-1", "Stays", "a");
    writeItem(folder, "T-2", "Goes", "b");
    await store.syncWorkSource(FIXTURE_SOURCE_ID);
    const gone = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-2");
    const queued = store.getActiveWorkItemForTask(gone)!;
    store.addCommentForRef({ workDefId: gone }, "you", "a note on the thread");

    fs.rmSync(path.join(folder, "T-2.md"));
    const res = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(res.archived, [gone]);
    const def = store.getWorkDef(gone)!;
    assertEquals(def.status, "archived");
    assertEquals(store.getCommentsForRef({ workDefId: gone }).length, 1, "the thread is kept");
    assertEquals(store.getWorkItem(queued.id)!.state, "CANCELED", "its READY item is withdrawn");
    assert(fileSourceKv(teamDir, FIXTURE_SOURCE_ID).get(vanishedKey(gone)));
    assertEquals(store.getWorkDef(mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1"))!.status, "active");
    // Archiving is once: a second sync has nothing to do.
    assertEquals((await store.syncWorkSource(FIXTURE_SOURCE_ID)).archived, []);

    // Back in the source → active again (same revision, so no new run).
    writeItem(folder, "T-2", "Goes", "b");
    const back = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(back.mirrored, [gone]);
    assertEquals(store.getWorkDef(gone)!.status, "active");
    assertEquals(fileSourceKv(teamDir, FIXTURE_SOURCE_ID).get(vanishedKey(gone)), undefined);
  } finally {
    cleanup(env);
  }
});

test("sync: a mirror a person archived stays archived (content kept current) and never enqueues", async () => {
  const env = setup();
  try {
    const { store, folder } = env;
    writeItem(folder, "T-1", "Thing", "v1");
    await store.syncWorkSource(FIXTURE_SOURCE_ID);
    const id = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    store.cancelWorkItem(store.getActiveWorkItemForTask(id)!.id);
    store.archiveWorkDef(id);
    writeItem(folder, "T-1", "Thing", "v2");
    const res = await store.syncWorkSource(FIXTURE_SOURCE_ID);
    assertEquals(res.mirrored, [id]); // its copy stays current…
    assertEquals(res.enqueued, []); // …but it doesn't run
    assertEquals(store.getWorkDef(id)!.status, "archived");
    assertEquals(store.getWorkDef(id)!.goal, "v2");
  } finally {
    cleanup(env);
  }
});

test("ctx.upsertDef mirrors without enqueueing; an unchanged revision is a no-op", () => {
  const env = setup();
  try {
    const { store } = env;
    const ctx = store.listExternalSources()[0]!.ctx;
    const ext: ExternalDef = { externalId: "P-9", revision: "r1", title: "Pushed", goal: "g" };
    const def = ctx.upsertDef(ext)!;
    assertEquals(def.id, mirroredWorkDefId(FIXTURE_SOURCE_ID, "P-9"));
    assertEquals(store.getActiveWorkItemForTask(def.id), null);
    assertEquals(ctx.upsertDef({ ...ext, title: "ignored" })!.title, "Pushed");
    assertEquals(ctx.upsertDef({ ...ext, revision: "r2", title: "Updated" })!.title, "Updated");
    assertEquals(ctx.upsertDef({ externalId: "", revision: "r", title: "t", goal: "" }), null);
  } finally {
    cleanup(env);
  }
});

// ─── Write-back ─────────────────────────────────────────────────────

test("write-back: onComment for thread comments; onItemTerminal on COMPLETE, FAILED, and CANCELED", async () => {
  const env = setup();
  try {
    const { store, folder, fixture } = env;
    writeItem(folder, "T-1", "Thing", "v1");
    await store.syncWorkSource(FIXTURE_SOURCE_ID);
    const id = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    const app = buildApp(store, TEST_CONFIG, env.teamDir);

    // A human comment through the route, then the teammate's completion comment + COMPLETE.
    const res = await app.request(`/api/work-defs/${id}/comment`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ from: "you", body: "please hurry" }) });
    assertEquals(res.status, 200);
    const item = store.getActiveWorkItemForTask(id)!;
    store.registerMember("a1", "a1", "/x", {});
    store.claimWorkItem(item.id, "a1");
    store.addCommentForRef({ workDefId: id }, "a1", "Done: did the thing");
    store.setWorkItemState(item.id, "COMPLETE");
    await settle();
    assertEquals(fixture.writeBacks.map((w) => w.hook === "onComment" ? `comment:${w.comment.body}` : `terminal:${w.state}`), [
      "comment:please hurry", "comment:Done: did the thing", "terminal:COMPLETE",
    ]);
    assert(fixture.writeBacks.every((w) => w.defId === id && w.externalId === "T-1"));

    // FAILED (agent) and CANCELED (human) are written back too.
    const second = store.enqueueWorkDef(id)!;
    store.claimWorkItem(second.id, "a1");
    store.setWorkItemState(second.id, "FAILED");
    const third = store.enqueueWorkDef(id)!;
    store.cancelWorkItem(third.id);
    await settle();
    assertEquals(fixture.writeBacks.filter((w) => w.hook === "onItemTerminal").map((w) => w.hook === "onItemTerminal" && w.state), ["COMPLETE", "FAILED", "CANCELED"]);
    // And recorded in the folder, for a person trying it out.
    const lines = fs.readFileSync(path.join(folder, FIXTURE_WRITEBACK_FILE), "utf8").trim().split("\n");
    assertEquals(lines.length, fixture.writeBacks.length);
  } finally {
    cleanup(env);
  }
});

test("write-back: a throwing or rejecting hook is logged and never breaks the comment or the state change", async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-ext-sources-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, TEST_CONFIG);
  const logs: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: string) => { logs.push(String(m)); };
  try {
    const broken: WorkSource = {
      id: "broken", apiVersion: 1,
      sync: () => Promise.resolve([{ externalId: "B-1", revision: "1", title: "B", goal: "g" }]),
      onComment: () => { throw new Error("tracker down"); },
      onItemTerminal: () => Promise.reject(new Error("tracker still down")),
    };
    store.registerWorkSource(broken);
    await store.syncWorkSource("broken");
    const id = mirroredWorkDefId("broken", "B-1");
    const app = buildApp(store, TEST_CONFIG, teamDir);
    const res = await app.request(`/api/work-defs/${id}/comment`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ from: "you", body: "hi" }) });
    assertEquals(res.status, 200);
    assertEquals(store.getCommentsForRef({ workDefId: id }).length, 1);
    const item = store.getActiveWorkItemForTask(id)!;
    store.registerMember("a1", "a1", "/x", {});
    store.claimWorkItem(item.id, "a1");
    assertEquals(store.setWorkItemState(item.id, "COMPLETE").ok, true);
    assertEquals(store.getWorkItem(item.id)!.state, "COMPLETE");
    await settle();
    assert(logs.some((l) => l.includes("[source:broken] onComment failed: tracker down")), logs.join("\n"));
    assert(logs.some((l) => l.includes("[source:broken] onItemTerminal failed: tracker still down")), logs.join("\n"));
  } finally {
    console.warn = origWarn;
    cleanup({ store, teamDir });
  }
});

// ─── Routes: read-only defs, thread still works ─────────────────────

test("routes: a mirrored def can't be edited, deleted, or created — its thread still works", async () => {
  const env = setup();
  try {
    const { store, folder } = env;
    writeItem(folder, "T-1", "Thing", "v1", { url: "https://tracker.example/T-1" });
    await store.syncWorkSource(FIXTURE_SOURCE_ID);
    const id = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    const app = buildApp(store, TEST_CONFIG, env.teamDir);

    const put = await app.request(`/api/work-defs/${id}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ title: "Mine now" }) });
    assertEquals(put.status, 409);
    const putBody = await put.json();
    assertStringIncludes(putBody.error, "mirrored from Fixture Tracker");
    assertStringIncludes(putBody.error, "pull only");
    const del = await app.request(`/api/work-defs/${id}`, { method: "DELETE" });
    assertEquals(del.status, 409);
    assertEquals(store.getWorkDef(id)!.title, "Thing");
    const create = await app.request("/api/work-defs", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ title: "x", goal: "y", type: "External" }) });
    assertEquals(create.status, 409);
    assertStringIncludes((await create.json()).error, "pull only");

    // The thread, attachments, and the view still work.
    const comment = await app.request(`/api/work-defs/${id}/comment`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ from: "you", body: "noted" }) });
    assertEquals(comment.status, 200);
    const att = await app.request(`/api/work-defs/${id}/attachments`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: "notes.md", content: "# hi" }) });
    assertEquals(att.status, 200);
    const view = (await (await app.request(`/api/work-defs/${id}`)).json()).workDef;
    assertEquals(view.type, "External");
    assertEquals(view.mirror.sourceId, FIXTURE_SOURCE_ID);
    assertEquals(view.mirror.sourceLabel, "Fixture Tracker");
    assertEquals(view.mirror.externalId, "T-1");
    assertEquals(view.mirror.url, "https://tracker.example/T-1");
    assert(view.mirror.revision);
    assertEquals(view.mirror.vanished, false);
  } finally {
    cleanup(env);
  }
});

test("routes: /api/work-sources lists external sources and their mirrored defs; /api/status reports them", async () => {
  const env = setup();
  try {
    const { store, folder } = env;
    writeItem(folder, "T-1", "Thing one", "a", { url: "https://tracker.example/T-1" });
    writeItem(folder, "T-2", "Thing two", "b");
    const app = buildApp(store, TEST_CONFIG, env.teamDir);

    // Manual sync route.
    const synced = await app.request(`/api/work-sources/${FIXTURE_SOURCE_ID}/sync`, { method: "POST" });
    assertEquals(synced.status, 200);
    assertEquals((await synced.json()).enqueued.length, 2);
    const id1 = mirroredWorkDefId(FIXTURE_SOURCE_ID, "T-1");
    const item = store.getActiveWorkItemForTask(id1)!;
    store.registerMember("a1", "a1", "/x", {});
    store.claimWorkItem(item.id, "a1");
    store.setWorkItemState(item.id, "COMPLETE");

    const list = await (await app.request("/api/work-sources")).json();
    assertEquals(list.sources, [{ id: FIXTURE_SOURCE_ID, label: "Fixture Tracker" }]);
    const status = await (await app.request("/api/status")).json();
    assertEquals(status.externalSources, [{ id: FIXTURE_SOURCE_ID, label: "Fixture Tracker" }]);

    const defs = await (await app.request(`/api/work-sources/${FIXTURE_SOURCE_ID}/defs`)).json();
    assertEquals(defs.source.label, "Fixture Tracker");
    const row = defs.defs.find((d: { id: string }) => d.id === id1);
    assertEquals(row.title, "Thing one");
    assertEquals(row.externalId, "T-1");
    assertEquals(row.url, "https://tracker.example/T-1");
    assertEquals(row.latestState, "COMPLETE");
    assertEquals(row.runCount, 1);
    assert(row.revision);
    assertEquals(defs.defs.find((d: { id: string }) => d.id !== id1).latestState, "READY");

    assertEquals((await app.request("/api/work-sources/nope/defs")).status, 404);
  } finally {
    cleanup(env);
  }
});

test("routes: with no external source registered, none is reported", async () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-ext-sources-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, TEST_CONFIG);
  try {
    const app = buildApp(store, TEST_CONFIG, teamDir);
    assertEquals((await (await app.request("/api/status")).json()).externalSources, []);
    assertEquals((await (await app.request("/api/work-sources")).json()).sources, []);
  } finally {
    cleanup({ store, teamDir });
  }
});

// ─── Isolation ──────────────────────────────────────────────────────

test("isolation: a throwing and a hanging source fail alone, back off, and never stall the fixture", async () => {
  const env = setup();
  const origWarn = console.warn;
  const logs: string[] = [];
  console.warn = (m: string) => { logs.push(String(m)); };
  try {
    const { store, folder } = env;
    let throwingCalls = 0;
    store.registerWorkSource({ id: "throws", apiVersion: 1, sync: () => { throwingCalls++; throw new Error("boom"); } });
    // Never settles; the runner's timeout is what ends it.
    store.registerWorkSource({ id: "hangs", apiVersion: 1, syncTimeoutMs: 20, sync: () => new Promise<ExternalDef[]>(() => {}) });
    store.registerWorkSource({ id: "garbage", apiVersion: 1, sync: () => Promise.resolve("nope" as unknown as ExternalDef[]) });
    writeItem(folder, "T-1", "Thing", "v1");

    const [threw, hung, garbage, fixture] = await Promise.all(
      ["throws", "hangs", "garbage", FIXTURE_SOURCE_ID].map((id) => store.syncWorkSource(id)),
    );
    assertEquals([threw!.ok, threw!.error], [false, "boom"]);
    assertEquals(hung!.ok, false);
    assertStringIncludes(hung!.error ?? "", "timed out");
    assertEquals(garbage!.ok, false);
    assert(fixture!.ok);
    assertEquals(fixture!.enqueued.length, 1);
    assert(logs.some((l) => l.startsWith("[source:throws] sync failed")));

    // Backing off: the next tick doesn't call the source; `force` does.
    assertEquals(store.syncFailures("throws"), 1);
    assertEquals((await store.syncWorkSource("throws")).skipped, "backoff");
    assertEquals(throwingCalls, 1);
    await store.syncWorkSource("throws", { force: true });
    assertEquals([throwingCalls, store.syncFailures("throws")], [2, 2]);
    // The fixture syncs regardless.
    assert((await store.syncWorkSource(FIXTURE_SOURCE_ID)).ok);
    assertEquals(store.syncFailures(FIXTURE_SOURCE_ID), 0);
  } finally {
    console.warn = origWarn;
    cleanup(env);
  }
});

test("isolation: a sync still running is not started again (no overlap)", async () => {
  let release!: (defs: ExternalDef[]) => void;
  let calls = 0;
  const source: WorkSource = { id: "slow", apiVersion: 1, sync: () => { calls++; return new Promise((r) => { release = r; }); } };
  const runner = new SyncRunner(() => ({ ok: true, mirrored: [], enqueued: [], archived: [], held: [] }));
  const entry = { source, ctx: stubContext("slow") };
  const first = runner.run(entry);
  assertEquals((await runner.run(entry)).skipped, "in-flight");
  release([]);
  assert((await first).ok);
  assertEquals(calls, 1);
});

test("isolation: backoff doubles per consecutive failure, capped, and resets on success", async () => {
  let fail = true;
  const source: WorkSource = { id: "flaky", apiVersion: 1, sync: () => fail ? Promise.reject(new Error("x")) : Promise.resolve([]) };
  const runner = new SyncRunner(() => ({ ok: true, mirrored: [], enqueued: [], archived: [], held: [] }), { baseMs: 100, maxMs: 250 });
  const entry = { source, ctx: stubContext("flaky") };
  await runner.run(entry, { now: 0 });
  assertEquals((await runner.run(entry, { now: 99 })).skipped, "backoff");
  await runner.run(entry, { now: 100 }); // 2nd failure → wait 200
  assertEquals((await runner.run(entry, { now: 299 })).skipped, "backoff");
  await runner.run(entry, { now: 300 }); // 3rd → 400, capped at 250
  assertEquals((await runner.run(entry, { now: 549 })).skipped, "backoff");
  fail = false;
  assert((await runner.run(entry, { now: 550 })).ok);
  assertEquals(runner.failures("flaky"), 0);
});

// ─── Dev config ─────────────────────────────────────────────────────

test("registerDevSources: the fixture source is registered only when config.dev.fixtureSource names a folder", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-ext-sources-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, TEST_CONFIG);
  try {
    registerDevSources(store, TEST_CONFIG, teamDir);
    assertEquals(store.listExternalSources().length, 0);
    registerDevSources(store, { ...TEST_CONFIG, dev: { fixtureSource: { dir: "ext", id: "dev-fixture", label: "Dev" } } }, teamDir);
    const entry = store.listExternalSources()[0]!;
    assertEquals([entry.source.id, entry.source.label], ["dev-fixture", "Dev"]);
  } finally {
    cleanup({ store, teamDir });
  }
});
