/**
 * tests/execution-count.test.ts — A WorkDef's execution count and last run
 * (docs/DESIGN.md "Execution Count: Derived, not Counted").
 *
 * The count is derived from `work_items` on every read: 0 / 1 / many runs,
 * CANCELED items excluded, every other state (READY and in-flight included)
 * counted, archived WorkDefs counted the same way, and the list and detail
 * routes agreeing with the store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import * as path from "node:path";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";

function setup() {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-exec-count-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, TEST_CONFIG);
  const app = buildApp(store, TEST_CONFIG, teamDir);
  return { app, store, teamDir };
}
function cleanup(teamDir: string, store: Store) {
  store.close();
  try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
const def = (store: Store, title: string) =>
  store.createWorkDef({ title, goal: "g", acceptanceCriteria: "a" }, false);

/** Enqueue, claim, and finish one run of `id`, returning the WorkItem id. */
function runOnce(store: Store, id: string, outcome: "COMPLETE" | "FAILED" = "COMPLETE"): string {
  const item = store.enqueueWorkDef(id)!;
  store.claimWorkItem(item.id, "agent-1");
  store.setWorkItemState(item.id, outcome);
  return item.id;
}

test("execution count: 0 for a WorkDef that never ran", () => {
  const { store, teamDir } = setup();
  try {
    const d = def(store, "Never");
    assertEquals(store.getExecutionStatsFor(d.id), { executionCount: 0, lastRunAt: null });
    assertEquals(store.getExecutionStats().has(d.id), false);
  } finally { cleanup(teamDir, store); }
});

test("execution count: 1, then many; lastRunAt is the latest enqueue", () => {
  const { store, teamDir } = setup();
  try {
    const d = def(store, "Busy");
    const first = runOnce(store, d.id);
    assertEquals(store.getExecutionStatsFor(d.id).executionCount, 1);
    assertEquals(store.getExecutionStatsFor(d.id).lastRunAt, store.getWorkItem(first)!.enqueuedAt);

    runOnce(store, d.id, "FAILED"); // a failed run is still a run
    const last = runOnce(store, d.id);
    const stats = store.getExecutionStatsFor(d.id);
    assertEquals(stats.executionCount, 3);
    assertEquals(stats.lastRunAt, store.getWorkItem(last)!.enqueuedAt);
    assertEquals(store.getExecutionStats().get(d.id), stats);
  } finally { cleanup(teamDir, store); }
});

test("execution count: CANCELED items are excluded; READY and in-flight count", () => {
  const { store, teamDir } = setup();
  try {
    const d = def(store, "Policy");
    const canceled = store.enqueueWorkDef(d.id)!;
    store.cancelWorkItem(canceled.id);
    assertEquals(store.getExecutionStatsFor(d.id), { executionCount: 0, lastRunAt: null });

    const ready = store.enqueueWorkDef(d.id)!; // queued: not "never run"
    assertEquals(store.getExecutionStatsFor(d.id).executionCount, 1);
    store.claimWorkItem(ready.id, "agent-1"); // in flight: still one
    assertEquals(store.getExecutionStatsFor(d.id).executionCount, 1);
  } finally { cleanup(teamDir, store); }
});

test("execution count: stats are per WorkDef", () => {
  const { store, teamDir } = setup();
  try {
    const a = def(store, "A");
    const b = def(store, "B");
    runOnce(store, a.id);
    runOnce(store, a.id);
    runOnce(store, b.id);
    const stats = store.getExecutionStats();
    assertEquals(stats.get(a.id)?.executionCount, 2);
    assertEquals(stats.get(b.id)?.executionCount, 1);
  } finally { cleanup(teamDir, store); }
});

test("execution count: list and detail APIs expose it, archived defs included", async () => {
  const { app, store, teamDir } = setup();
  try {
    const never = def(store, "Never");
    const twice = def(store, "Twice");
    runOnce(store, twice.id);
    runOnce(store, twice.id);

    const list = await (await app.request("/api/work-defs")).json();
    const byId = new Map(list.workDefs.map((d: { id: string }) => [d.id, d]));
    assertEquals((byId.get(never.id) as { executionCount: number; lastRunAt: string | null }).executionCount, 0);
    assertEquals((byId.get(never.id) as { lastRunAt: string | null }).lastRunAt, null);
    assertEquals((byId.get(twice.id) as { executionCount: number }).executionCount, 2);

    const one = await (await app.request(`/api/work-defs/${twice.id}`)).json();
    assertEquals(one.workDef.executionCount, 2);
    assertEquals(one.workDef.lastRunAt, store.getExecutionStatsFor(twice.id).lastRunAt);

    // Archiving keeps the history: the count is the same under ?status=archived.
    store.archiveWorkDef(twice.id);
    const archived = await (await app.request("/api/work-defs?status=archived")).json();
    assertEquals(archived.workDefs.find((d: { id: string }) => d.id === twice.id).executionCount, 2);
  } finally { cleanup(teamDir, store); }
});
