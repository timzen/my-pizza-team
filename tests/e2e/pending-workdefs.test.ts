/**
 * tests/e2e/pending-workdefs.test.ts — the demo team loads, and a pending WorkDef
 * is never run until it is activated.
 *
 * Ported from mpt-demo-team's run-e2e.sh ("Verify Story Loaded", "Pending
 * WorkDefs"). The daemon starts from source on the demo team
 * (tests/fixtures/demo/team, tests/e2e/_demo.ts) and must load its stories. Then a
 * pending WorkDef (docs/DESIGN.md "Pending: Write, Review, Activate") must never be
 * enqueued or run, stays editable until activated, and is locked afterwards.
 */

import { test } from "node:test";
import { assert, assertEquals } from "../_assert.ts";
import { sandbox } from "./_sandbox.ts";
import { api, demoTeam, type Json } from "./_demo.ts";

test("the demo team loads: its story with three tasks, and the pending story", async () => {
  await using sb = await sandbox("demo-load");
  demoTeam(sb);
  await sb.startDaemon("source");
  const a = api(sb);

  const stories = (await a.get("/api/stories")).body.stories as Json[];
  const auth = stories.find((s) => s.id === "add-user-auth");
  assert(auth, `no add-user-auth story: ${JSON.stringify(stories.map((s) => s.id))}`);
  assertEquals(auth.tasks.length, 3);
  const polish = stories.find((s) => s.id === "ui-theme-polish");
  assert(polish, "the pending story didn't load");
  assertEquals(polish.pending, true);
});

test("a pending WorkDef: not enqueued, run refused, editable — and locked once activated", async () => {
  await using sb = await sandbox("demo-pending");
  demoTeam(sb);
  await sb.startDaemon("source");
  const a = api(sb);

  const created = await a.post("/api/work-defs", { title: "E2E pending check", goal: "never runs", pending: true });
  assertEquals(created.status, 201, JSON.stringify(created.body));
  const id = created.body.workDef.id as string;
  const runs = async () => ((await a.get("/api/work-items")).body.items as Json[]).filter((i) => i.ref.workDefId === id).length;

  assertEquals(await runs(), 0, "the pending WorkDef was enqueued");
  assertEquals((await a.post(`/api/work-defs/${id}/enqueue`)).status, 409, "a run on a pending WorkDef wasn't refused");
  assertEquals((await a.put(`/api/work-defs/${id}`, { goal: "edited" })).status, 200, "editing a pending WorkDef failed");
  assertEquals((await a.post(`/api/work-defs/${id}/activate`, { enqueue: false })).status, 200, "activate failed");
  assertEquals(await runs(), 0, "activate with enqueue:false enqueued it");
  assertEquals((await a.put(`/api/work-defs/${id}`, { goal: "too late" })).status, 409, "an active WorkDef was still editable");
  assertEquals((await a.del(`/api/work-defs/${id}`)).status, 200);
});
