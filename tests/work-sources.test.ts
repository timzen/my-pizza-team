/**
 * tests/work-sources.test.ts — Verifies the Work Source registry and that the
 * Store calls a registered source at each hook point (enqueue, eligibility,
 * claim prompt, terminal, tick). See docs/DESIGN.md "Work Sources: WorkDef
 * Kinds as Plugins".
 *
 * The fake sources here register under "task" (the parent-less kind), which
 * no built-in claims yet, so they see Solitary WorkDefs.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { SourceRegistry, sourceIdForWorkDef, TASK_SOURCE_ID } from "../daemon/sources/registry.ts";
import { SCHEDULE_SOURCE_ID } from "../daemon/sources/schedule.ts";
import type { SourceContext, WorkSource } from "../daemon/sources/types.ts";
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

/** A minimal context for registry-only tests (no Store). */
function stubContext(sourceId: string, logs: string[] = []): SourceContext {
  return {
    sourceId, teamDir: "/nowhere", config: () => TEST_CONFIG, log: (m) => logs.push(`${sourceId}: ${m}`),
    listWorkDefs: () => [], hasActiveItem: () => false, enqueue: () => null,
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

Deno.test("Store: the Schedule source is registered as a built-in", () => {
  const { store, teamDir } = setup();
  try {
    assertEquals(store.getWorkSourceFor({ parent: { kind: "schedule", id: "s" } })?.source.id, SCHEDULE_SOURCE_ID);
    // Not-yet-migrated kinds have no source (the Store's inline default applies).
    assertEquals(store.getWorkSourceFor({}), undefined);
    assertThrows(() => store.registerWorkSource({ id: SCHEDULE_SOURCE_ID, apiVersion: 1 }), Error, "already registered");
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
    store.registerWorkSource({ id: TASK_SOURCE_ID, apiVersion: 1, init: (c) => { ctx = c; } });
    const def = store.createWorkDef({ title: "Held", goal: "g", acceptanceCriteria: "a", pending: true });
    assertEquals(ctx!.enqueue(def.id), null);
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 0);
  } finally { cleanup(teamDir, store); }
});
