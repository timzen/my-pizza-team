/**
 * tests/work-sources.test.ts — Verifies the Work Source registry and that the
 * Store calls a registered source at each hook point (enqueue, eligibility,
 * claim prompt, terminal, tick). See docs/DESIGN.md "Work Sources: WorkDef
 * Kinds as Plugins".
 *
 * The fake sources here replace the built-in "task" source (the parent-less
 * kind), so they see Solitary WorkDefs. Also covers the revision-dedupe helper
 * (`enqueueRevision`) and the per-source kv store behind it.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { SourceRegistry, sourceIdForWorkDef, TASK_SOURCE_ID } from "../daemon/sources/registry.ts";
import { SCHEDULE_SOURCE_ID } from "../daemon/sources/schedule.ts";
import { THOUGHT_SOURCE_ID } from "../daemon/sources/thought.ts";
import { STORY_SOURCE_ID } from "../daemon/sources/story.ts";
import { enqueueRevision, kvRevisionCursor, revisionKey } from "../daemon/sources/revision.ts";
import { fileSourceKv, SOURCES_DIR } from "../daemon/store/source-kv.ts";
import type { SourceContext, SourceKv, WorkSource } from "../daemon/sources/types.ts";
import type { WorkDef, WorkItem } from "../shared/types.ts";

function setup(): { store: Store; teamDir: string } {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-sources-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  return { store: new Store(teamDir, TEST_CONFIG), teamDir };
}

function cleanup(teamDir: string, store: Store): void {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
}

/** An in-memory `SourceKv`. */
function memoryKv(): SourceKv & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k), set: (k, v) => { data.set(k, v); }, delete: (k) => { data.delete(k); } };
}

/** A minimal context for registry-only tests (no Store). */
function stubContext(sourceId: string, logs: string[] = []): SourceContext {
  return {
    sourceId, teamDir: "/nowhere", config: () => TEST_CONFIG, log: (m) => logs.push(`${sourceId}: ${m}`),
    listWorkDefs: () => [], hasActiveItem: () => false, enqueue: () => null,
    enqueueRevision: () => null, upsertDef: () => null, kv: memoryKv(),
    readiness: { canEnqueueNow: () => true },
  };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.test("sourceIdForWorkDef: parent.kind, or 'task' with no parent", () => {
  assertEquals(sourceIdForWorkDef({}), TASK_SOURCE_ID);
  assertEquals(sourceIdForWorkDef({ parent: { kind: "schedule", id: "s" } }), "schedule");
  assertEquals(sourceIdForWorkDef({ parent: { kind: "story", id: "s" } }), "story");
  assertEquals(sourceIdForWorkDef({ parent: { kind: "thought", id: "n" } }), "thought");
});

Deno.test("SourceRegistry: register, lookup by id and by WorkDef, init runs once with its context", () => {
  const inits: string[] = [];
  const reg = new SourceRegistry((id) => stubContext(id));
  const src: WorkSource = { id: "schedule", apiVersion: 1, init: (ctx) => { inits.push(ctx.sourceId); } };
  reg.register(src);
  assertEquals(inits, ["schedule"]);
  assertEquals(reg.get("schedule")?.source, src);
  assertEquals(reg.forWorkDef({ parent: { kind: "schedule", id: "x" } })?.source, src);
  assertEquals(reg.forWorkDef({}), undefined); // "task" not registered
  assertEquals(reg.all().length, 1);
});

Deno.test("SourceRegistry: refuses a duplicate id and an unsupported apiVersion", () => {
  const reg = new SourceRegistry((id) => stubContext(id));
  reg.register({ id: "a", apiVersion: 1 });
  assertThrows(() => reg.register({ id: "a", apiVersion: 1 }), Error, "already registered");
  assertThrows(() => reg.register({ id: "b", apiVersion: 2 as unknown as 1 }), Error, "apiVersion");
});

Deno.test("SourceRegistry: tickAll ticks every source and isolates one that throws", () => {
  const logs: string[] = [];
  const ticked: string[] = [];
  const reg = new SourceRegistry((id) => stubContext(id, logs));
  reg.register({ id: "bad", apiVersion: 1, tick: () => { throw new Error("boom"); } });
  reg.register({ id: "good", apiVersion: 1, tick: (ctx) => { ticked.push(ctx.sourceId); } });
  reg.tickAll(new Date());
  assertEquals(ticked, ["good"]);
  assertEquals(logs, ["bad: tick failed: boom"]);
});

Deno.test("Store: the Task, Story, Schedule, and Thought sources are registered as built-ins", () => {
  const { store, teamDir } = setup();
  try {
    assertEquals(store.getWorkSourceFor({ parent: { kind: "schedule", id: "s" } })?.source.id, SCHEDULE_SOURCE_ID);
    assertEquals(store.getWorkSourceFor({})?.source.id, TASK_SOURCE_ID);
    assertEquals(store.getWorkSourceFor({ parent: { kind: "thought", id: "n" } })?.source.id, THOUGHT_SOURCE_ID);
    assertEquals(store.getWorkSourceFor({ parent: { kind: "story", id: "s" } })?.source.id, STORY_SOURCE_ID);
    assertThrows(() => store.registerWorkSource({ id: STORY_SOURCE_ID, apiVersion: 1 }), Error, "already registered");
    assertThrows(() => store.registerWorkSource({ id: SCHEDULE_SOURCE_ID, apiVersion: 1 }), Error, "already registered");
    assertThrows(() => store.registerWorkSource({ id: THOUGHT_SOURCE_ID, apiVersion: 1 }), Error, "already registered");
  } finally { cleanup(teamDir, store); }
});

Deno.test("Store: tickWorkSources fires the Schedule source (due cron enqueues once)", () => {
  const { store, teamDir } = setup();
  try {
    const sched = store.createSchedule({ title: "Every minute", cron: "* * * * *" });
    store.createWorkDef({ title: "Job", goal: "g", acceptanceCriteria: "a", parent: { kind: "schedule", id: sched.id } }, false);
    const now = new Date();
    store.tickWorkSources(now);
    store.tickWorkSources(now);
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("Store: a registered source's hooks are called (resolveItem, isEligible, buildPrompt, onItemTerminal, tick)", async () => {
  const { store, teamDir } = setup();
  const app = buildApp(store, TEST_CONFIG, teamDir);
  try {
    let eligible = false;
    const terminal: Array<{ def: string; state: WorkItem["state"] }> = [];
    let ticks = 0;
    let ctxSeen: SourceContext | null = null;
    assert(store.unregisterWorkSource(TASK_SOURCE_ID));
    store.registerWorkSource({
      id: TASK_SOURCE_ID,
      apiVersion: 1,
      init: (ctx) => { ctxSeen = ctx; },
      tick: () => { ticks++; },
      resolveItem: (def: WorkDef) => ({ title: `[fake] ${def.title}`, directory: "/repo/fake" }),
      isEligible: () => eligible,
      buildPrompt: (_def, base) => `${base}\n\nFAKE-SOURCE-FOOTER`,
      onItemTerminal: (def, item) => { terminal.push({ def: def.id, state: item.state }); },
    });
    assert(ctxSeen !== null);

    // resolveItem: the item takes the source's title and directory.
    const def = store.createWorkDef({ title: "Solo", goal: "Do the thing", acceptanceCriteria: "- MUST work" });
    const items = store.getWorkItems({ states: ["READY"] }).items;
    assertEquals(items.length, 1);
    assertEquals(items[0]!.title, "[fake] Solo");
    assertEquals(items[0]!.directory, "/repo/fake");

    // isEligible: a READY item the source says no to is not handed out.
    store.registerMember("a1", "a1", "/repo/fake", {});
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/repo/fake" }), null);
    eligible = true;
    const next = store.getNextWorkItem({ id: "a1", directory: "/repo/fake" });
    assertEquals(next?.id, items[0]!.id);

    // buildPrompt: the claim prompt is the base plus the source's contribution.
    const claim = await (await app.request(`/api/agents/claim/${next!.id}`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ agentId: "a1" }),
    })).json();
    assertEquals(claim.success, true);
    assert(claim.prompt.includes("Do the thing"));
    assert(claim.prompt.endsWith("FAKE-SOURCE-FOOTER"));

    // onItemTerminal: told once, with the terminal state.
    assertEquals(store.setWorkItemState(next!.id, "COMPLETE").ok, true);
    assertEquals(terminal, [{ def: def.id, state: "COMPLETE" }]);

    // tick: driven by the daemon.
    store.tickWorkSources();
    assertEquals(ticks, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("Store: a source still can't enqueue a pending WorkDef (the single enqueueFor refuses)", () => {
  const { store, teamDir } = setup();
  try {
    let ctx: SourceContext | null = null;
    store.unregisterWorkSource(TASK_SOURCE_ID);
    store.registerWorkSource({ id: TASK_SOURCE_ID, apiVersion: 1, init: (c) => { ctx = c; } });
    const def = store.createWorkDef({ title: "Held", goal: "g", acceptanceCriteria: "a", pending: true });
    assertEquals(ctx!.enqueue(def.id), null);
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 0);
  } finally { cleanup(teamDir, store); }
});

// ─── The built-in Story source: board policy through the hooks ──────

Deno.test("Store: board tasks go through the Story source (directory fallback, eligibility, advance outcome)", () => {
  const { store, teamDir } = setup();
  try {
    store.createStory("s1", "S", "d", "open", [], [{ title: "T1", description: "g" }], undefined, undefined, false, "/repo/story");
    const task = store.getTasksForStory("s1")[0]!;
    const def = store.getWorkDef(task.id)!;
    const src = store.getWorkSourceFor(def)!;
    // resolveItem: no directory of its own → the story's.
    assertEquals(src.source.resolveItem?.(def, src.ctx), { directory: "/repo/story" });
    const item = store.getWorkItems({ states: ["READY"] }).items[0]!;
    assertEquals(item.directory, "/repo/story");
    // isEligible: a pending story hands out nothing new.
    assertEquals(src.source.isEligible?.(def, src.ctx), true);
    store.setStoryPending("s1", true);
    assertEquals(src.source.isEligible?.(store.getWorkDef(task.id)!, src.ctx), false);
    store.setStoryPending("s1", false);
    // onItemClaimed records the assignment; onItemTerminal's outcome reaches the caller.
    store.registerMember("a1", "a1", "/repo/story", {});
    assert(store.claimWorkItem(item.id, "a1"));
    assertEquals(store.getAssignment(task.id)?.memberId, "a1");
    const res = store.setWorkItemState(item.id, "COMPLETE");
    assert(res.ok && typeof res.newStatus === "string");
    assertEquals(store.getAssignment(task.id), null);
    assertEquals(store.getTask(task.id)?.status, res.newStatus);
  } finally { cleanup(teamDir, store); }
});

// ─── tickSchedule (per-source timers) ───────────────────────────────

Deno.test("SourceRegistry: tickSchedule uses tickEveryMs, defaults the rest, and drops opt-outs", () => {
  const reg = new SourceRegistry((id) => stubContext(id));
  reg.register({ id: "plain", apiVersion: 1, tick: () => {} });
  reg.register({ id: "slow", apiVersion: 1, tick: () => {}, tickEveryMs: () => 60_000 });
  reg.register({ id: "off", apiVersion: 1, tick: () => {}, tickEveryMs: () => null });
  reg.register({ id: "notick", apiVersion: 1 });
  assertEquals(reg.tickSchedule(30_000), [{ id: "plain", everyMs: 30_000 }, { id: "slow", everyMs: 60_000 }]);
});

// ─── The revision-dedupe helper (enqueueRevision) ──────────────────

/** Fake daemon deps for `enqueueRevision`: counts enqueues, toggles in-flight. */
function fakeRevisionDeps(): { deps: { hasActiveItem: (id: string) => boolean; enqueue: (id: string) => WorkItem | null }; enqueued: string[]; active: Set<string>; refuse: Set<string> } {
  const enqueued: string[] = [];
  const active = new Set<string>();
  const refuse = new Set<string>();
  return {
    enqueued, active, refuse,
    deps: {
      hasActiveItem: (id) => active.has(id),
      enqueue: (id) => {
        if (refuse.has(id)) return null;
        enqueued.push(id);
        return { id: `wi-${enqueued.length}` } as WorkItem;
      },
    },
  };
}

Deno.test("enqueueRevision: once per revision; a new revision enqueues again", () => {
  const { deps, enqueued } = fakeRevisionDeps();
  const kv = memoryKv();
  const cursor = kvRevisionCursor(kv);
  assert(enqueueRevision(deps, cursor, "d1", "r1") !== null);
  assertEquals(kv.get(revisionKey("d1")), "r1"); // stamped at enqueue
  assertEquals(enqueueRevision(deps, cursor, "d1", "r1"), null); // unchanged
  assert(enqueueRevision(deps, cursor, "d1", "r2") !== null);
  assertEquals(enqueued, ["d1", "d1"]);
  // Per def: another def's revision is its own.
  assert(enqueueRevision(deps, cursor, "d2", "r1") !== null);
});

Deno.test("enqueueRevision: in flight refuses (even forced) and doesn't stamp", () => {
  const { deps, active, enqueued } = fakeRevisionDeps();
  const kv = memoryKv();
  const cursor = kvRevisionCursor(kv);
  active.add("d1");
  assertEquals(enqueueRevision(deps, cursor, "d1", "r1"), null);
  assertEquals(enqueueRevision(deps, cursor, "d1", "r1", { force: true }), null);
  assertEquals(kv.get(revisionKey("d1")), undefined);
  assertEquals(enqueued, []);
});

Deno.test("enqueueRevision: force re-runs an unchanged revision", () => {
  const { deps, enqueued } = fakeRevisionDeps();
  const cursor = kvRevisionCursor(memoryKv());
  enqueueRevision(deps, cursor, "d1", "r1");
  assert(enqueueRevision(deps, cursor, "d1", "r1", { force: true }) !== null);
  assertEquals(enqueued, ["d1", "d1"]);
});

Deno.test("enqueueRevision: a refused enqueue (e.g. pending) leaves the revision unstamped", () => {
  const { deps, refuse } = fakeRevisionDeps();
  const kv = memoryKv();
  refuse.add("d1");
  assertEquals(enqueueRevision(deps, kvRevisionCursor(kv), "d1", "r1"), null);
  assertEquals(kv.get(revisionKey("d1")), undefined);
  refuse.delete("d1");
  assert(enqueueRevision(deps, kvRevisionCursor(kv), "d1", "r1") !== null); // due once it can enqueue
});

Deno.test("enqueueRevision: a custom cursor replaces the kv", () => {
  const { deps } = fakeRevisionDeps();
  const kv = memoryKv();
  const stamps = new Map<string, string>([["d1", "r1"]]);
  const cursor = { get: (id: string) => stamps.get(id), set: (id: string, r: string) => { stamps.set(id, r); } };
  assertEquals(enqueueRevision(deps, kvRevisionCursor(kv), "d1", "r1", { cursor }), null);
  assert(enqueueRevision(deps, kvRevisionCursor(kv), "d1", "r2", { cursor }) !== null);
  assertEquals(stamps.get("d1"), "r2");
  assertEquals(kv.data.size, 0);
});

Deno.test("fileSourceKv: persists per source under sources/<id>.json", () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-source-kv-test-" });
  try {
    const a = fileSourceKv(teamDir, "jira");
    assertEquals(a.get("k"), undefined);
    a.set("k", "v1");
    a.set("b", "x");
    assertEquals(fileSourceKv(teamDir, "jira").get("k"), "v1"); // a fresh handle reads the file
    assertEquals(fileSourceKv(teamDir, "other").get("k"), undefined); // per source
    const raw = JSON.parse(Deno.readTextFileSync(path.join(teamDir, SOURCES_DIR, "jira.json")));
    assertEquals(Object.keys(raw), ["b", "k"]); // sorted, for clean diffs
    a.delete("k");
    assertEquals(a.get("k"), undefined);
    assertEquals(a.get("b"), "x");
  } finally {
    Deno.removeSync(teamDir, { recursive: true });
  }
});

Deno.test("Store: ctx.enqueueRevision goes through enqueueFor and the source's kv", () => {
  const { store, teamDir } = setup();
  try {
    let ctx: SourceContext | null = null;
    store.unregisterWorkSource(TASK_SOURCE_ID);
    store.registerWorkSource({ id: TASK_SOURCE_ID, apiVersion: 1, init: (c) => { ctx = c; } });
    const def = store.createWorkDef({ title: "Mirrored", goal: "g", acceptanceCriteria: "a" }, false);
    const first = ctx!.enqueueRevision(def.id, "etag-1");
    assert(first !== null);
    assertEquals(ctx!.enqueueRevision(def.id, "etag-2"), null); // in flight
    store.claimWorkItem(first.id, "m1");
    store.setWorkItemState(first.id, "COMPLETE");
    assertEquals(ctx!.enqueueRevision(def.id, "etag-1"), null); // unchanged
    assert(ctx!.enqueueRevision(def.id, "etag-2") !== null);
    // Stamped in the source's own file, not the authored workdef.md.
    assertEquals(fileSourceKv(teamDir, TASK_SOURCE_ID).get(revisionKey(def.id)), "etag-2");
    assert(!Deno.readTextFileSync(path.join(teamDir, "tasks", def.id, "workdef.md")).includes("etag"));
    // Pending defs still never enqueue.
    const held = store.createWorkDef({ title: "Held", goal: "g", acceptanceCriteria: "a", pending: true });
    assertEquals(ctx!.enqueueRevision(held.id, "r"), null);
  } finally { cleanup(teamDir, store); }
});

// ─── The built-in Task source: Run and activate ─────────────────────

Deno.test("Store: runWorkDef / activateWorkDef follow the Solitary rules through the Task source", () => {
  const { store, teamDir } = setup();
  try {
    const def = store.createWorkDef({ title: "Solo", goal: "g", acceptanceCriteria: "a" }, false);
    const run = store.runWorkDef(def.id);
    assert(run.ok);
    const again = store.runWorkDef(def.id);
    assert(!again.ok && !again.conflict); // in flight → 400
    const pending = store.createWorkDef({ title: "P", goal: "g", acceptanceCriteria: "a", pending: true });
    const refused = store.runWorkDef(pending.id);
    assert(!refused.ok && refused.conflict); // pending → 409
    assertEquals(store.runWorkDef("nope").ok, false);
    // Activation enqueues a Solitary def, unless asked not to.
    const act = store.activateWorkDef(pending.id);
    assert(act && !("error" in act) && act.workItem !== null);
    const quiet = store.createWorkDef({ title: "Q", goal: "g", acceptanceCriteria: "a", pending: true });
    const actQuiet = store.activateWorkDef(quiet.id, { enqueue: false });
    assert(actQuiet && !("error" in actQuiet) && actQuiet.workItem === null);
  } finally { cleanup(teamDir, store); }
});
