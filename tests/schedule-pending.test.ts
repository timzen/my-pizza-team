/**
 * tests/schedule-pending.test.ts — Pending Schedules (docs/DESIGN.md "Pending
 * schedules: reversible, no catch-up").
 *
 * A Schedule's `pending` is reversible (active ⇄ pending). While pending the
 * scheduler never fires it and never holds it for readiness. Reactivating
 * resumes at the *next* cron occurrence: nothing skipped while pending is
 * back-fired, not even a readiness-held occurrence or the activation minute.
 * A job fires only when both its Schedule and its WorkDef are active.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { scheduleCursor } from "../daemon/store/schedules.ts";

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-sched-pending-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...TEST_CONFIG, features: { stories: true, tasks: true, schedules: true } };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir };
}
function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
}
const JSON_HEADERS = { "Content-Type": "application/json" };
const post = (app: ReturnType<typeof buildApp>, url: string, body: unknown = {}) =>
  app.request(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
const put = (app: ReturnType<typeof buildApp>, url: string, body: unknown) =>
  app.request(url, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
const readyCount = (store: Store) => store.getWorkItems({ states: ["READY"] }).total;
/** Finish every READY item so the next firing isn't skipped as "already in flight". */
const drain = (store: Store) => {
  for (const wi of store.getWorkItems({ states: ["READY"] }).items) store.cancelWorkItem(wi.id);
};

/** A minutely Schedule with one active child WorkDef. */
function minutely(store: Store, pending?: boolean) {
  const sched = store.createSchedule({ title: "Minutely", cron: "* * * * *", pending });
  store.createWorkDef({ title: "Minutely", goal: "g", acceptanceCriteria: "a", parent: { kind: "schedule", id: sched.id } }, false);
  return sched;
}

// 09:00 local time on a fixed day, plus `m` minutes and `s` seconds.
const at = (m: number, s = 0) => new Date(2030, 0, 7, 9, m, s);

Deno.test("a pending Schedule never fires", () => {
  const { store, teamDir } = setup();
  try {
    const sched = minutely(store, true);
    assertEquals(store.getSchedule(sched.id)?.pending, true);
    for (let m = 0; m < 5; m++) store.runScheduler(at(m));
    assertEquals(readyCount(store), 0);
    // No cursor advance while pending: lastEnqueuedAt is only for genuine firings.
    assertEquals(store.getSchedule(sched.id)?.lastEnqueuedAt, undefined);
  } finally { cleanup(teamDir, store); }
});

Deno.test("reactivating resumes at the next occurrence with no catch-up burst", () => {
  const { store, teamDir } = setup();
  try {
    const sched = minutely(store);
    store.runScheduler(at(0));
    assertEquals(readyCount(store), 1);
    drain(store);

    // Pending across several occurrences: none fire.
    store.setSchedulePending(sched.id, true);
    for (let m = 1; m <= 10; m++) store.runScheduler(at(m));
    assertEquals(readyCount(store), 0);

    // Reactivate mid-minute (09:10:20). The 09:10 occurrence was skipped while
    // pending, so it must not fire now; nor do 09:01–09:09 get back-filled.
    const resumed = store.setSchedulePending(sched.id, false, at(10, 20))!;
    assertEquals(resumed.pending, undefined);
    assertEquals(scheduleCursor(resumed), at(10, 20).toISOString());

    store.runScheduler(at(10, 40));
    assertEquals(readyCount(store), 0, "the activation minute doesn't fire");

    // The next occurrence fires exactly once.
    store.runScheduler(at(11, 5));
    store.runScheduler(at(11, 35));
    assertEquals(readyCount(store), 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a readiness-held occurrence is dropped when the Schedule goes pending, and a pending Schedule isn't held", () => {
  const { store, teamDir } = setup();
  try {
    store.registerMember("ag-a", "ag-a", "/repo/a", {});
    const sched = minutely(store);
    store.setTeamReadiness(false, "creds expired");
    store.runScheduler(at(0));
    assertEquals(store.getSchedule(sched.id)?.heldForReadiness, true);

    store.setSchedulePending(sched.id, true);
    assertEquals(store.getSchedule(sched.id)?.heldForReadiness, undefined);
    // While pending, a not-ready team doesn't hold it again.
    store.runScheduler(at(1));
    assertEquals(store.getSchedule(sched.id)?.heldForReadiness, undefined);

    // Team recovers and the Schedule is reactivated: no catch-up run of the held occurrence.
    store.setTeamReadiness(true);
    store.setSchedulePending(sched.id, false);
    store.runScheduler(new Date());
    assertEquals(readyCount(store), 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("precedence: a job fires only when both its Schedule and its WorkDef are active", () => {
  const { store, teamDir } = setup();
  try {
    const sched = store.createSchedule({ title: "Two", cron: "* * * * *" });
    const active = store.createWorkDef({ title: "Active", goal: "g", acceptanceCriteria: "a", parent: { kind: "schedule", id: sched.id } }, false);
    store.createWorkDef({ title: "Pending def", goal: "g", acceptanceCriteria: "a", parent: { kind: "schedule", id: sched.id }, pending: true }, false);

    // Active Schedule: only the active child fires.
    store.runScheduler(at(0));
    const items = store.getWorkItems({ states: ["READY"] }).items;
    assertEquals(items.length, 1);
    assertEquals(items[0]!.ref.workDefId, active.id);
    drain(store);

    // Pending Schedule overrides an active child: nothing fires.
    store.setSchedulePending(sched.id, true);
    store.runScheduler(at(1));
    assertEquals(readyCount(store), 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("toggling to the same value is a no-op (no new resume cursor)", () => {
  const { store, teamDir } = setup();
  try {
    const sched = minutely(store);
    store.setSchedulePending(sched.id, false);
    assertEquals(store.getSchedule(sched.id)?.resumedAt, undefined);
    assertEquals(store.setSchedulePending("nope", true), null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("API: pending/activate verbs, PUT { pending }, and the view's pending flag", async () => {
  const { app, store, teamDir } = setup();
  try {
    const sched = minutely(store);
    let list = await (await app.request("/api/schedules")).json();
    assertEquals(list.schedules[0].pending, false);

    let body = await (await post(app, `/api/schedules/${sched.id}/pending`)).json();
    assertEquals(body.success, true);
    assertEquals(body.schedule.pending, true);
    list = await (await app.request(`/api/schedules/${sched.id}`)).json();
    assertEquals(list.schedule.pending, true);

    body = await (await post(app, `/api/schedules/${sched.id}/activate`)).json();
    assertEquals(body.schedule.pending, false);
    assert(store.getSchedule(sched.id)?.resumedAt);

    body = await (await put(app, `/api/schedules/${sched.id}`, { pending: true })).json();
    assertEquals(body.schedule.pending, true);
    assertEquals((await put(app, `/api/schedules/${sched.id}`, { pending: "yes" })).status, 400);
    assertEquals((await post(app, "/api/schedules/missing/activate")).status, 404);
  } finally { cleanup(teamDir, store); }
});
