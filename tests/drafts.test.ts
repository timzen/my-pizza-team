/**
 * tests/drafts.test.ts — Draft WorkDefs (docs/DESIGN.md "Drafts: Write, Review, Publish").
 *
 * A draft is editable and never gets a WorkItem — not on create, Run, cron, or
 * board admission (where it holds its story's next slot). Publishing is one-way:
 * it makes the WorkDef eligible (Solitary: enqueued; Board: admitted; Scheduled:
 * next cron) and locks its definition against further PUTs.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { parseWorkDef, serializeWorkDef } from "../daemon/store/workdefs.ts";

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-drafts-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, TEST_CONFIG);
  const app = buildApp(store, TEST_CONFIG, teamDir);
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

Deno.test("draft frontmatter round-trips; absent means published", () => {
  const def = { id: "d", title: "T", goal: "g", acceptanceCriteria: "a", draft: true };
  assertEquals(parseWorkDef("d", serializeWorkDef(def))?.draft, true);
  const published = parseWorkDef("p", serializeWorkDef({ id: "p", title: "T", goal: "g", acceptanceCriteria: "a" }));
  assertEquals(published?.draft, undefined);
  assert(!serializeWorkDef({ id: "p", title: "T", goal: "g", acceptanceCriteria: "a" }).includes("draft"));
});

Deno.test("a Solitary draft is not enqueued, can't be Run, and stays editable", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/work-defs", { title: "Draft job", goal: "g", acceptanceCriteria: "a", draft: true });
    assertEquals(res.status, 201);
    const { workDef } = await res.json();
    assertEquals(workDef.draft, true);
    assertEquals(readyCount(store), 0);

    // Run refuses a draft.
    assertEquals((await post(app, `/api/work-defs/${workDef.id}/enqueue`)).status, 409);
    assertEquals(readyCount(store), 0);

    // Editable while a draft.
    const edit = await put(app, `/api/work-defs/${workDef.id}`, { goal: "better goal" });
    assertEquals(edit.status, 200);
    assertEquals((await edit.json()).workDef.goal, "better goal");
    assertEquals(readyCount(store), 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("publishing a Solitary draft enqueues it and locks its definition", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { title: "Draft job", goal: "g", acceptanceCriteria: "a", draft: true })).json();
    const pub = await post(app, `/api/work-defs/${workDef.id}/publish`);
    assertEquals(pub.status, 200);
    const body = await pub.json();
    assertEquals(body.workDef.draft, false);
    assert(body.workItemId);
    assertEquals(readyCount(store), 1);

    // Locked: any definition edit is refused, and nothing changed on disk.
    const edit = await put(app, `/api/work-defs/${workDef.id}`, { goal: "sneaky edit" });
    assertEquals(edit.status, 409);
    assertEquals(store.getWorkDef(workDef.id)?.goal, "g");

    // Publishing twice is a 409; an unknown id is a 404.
    assertEquals((await post(app, `/api/work-defs/${workDef.id}/publish`)).status, 409);
    assertEquals((await post(app, "/api/work-defs/nope/publish")).status, 404);
  } finally { cleanup(teamDir, store); }
});

Deno.test("publish with enqueue:false publishes a Solitary draft without running it", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { title: "Later", goal: "g", draft: true })).json();
    const body = await (await post(app, `/api/work-defs/${workDef.id}/publish`, { enqueue: false })).json();
    assertEquals(body.success, true);
    assertEquals(body.workItemId, null);
    assertEquals(readyCount(store), 0);
    assertEquals(store.isDraft(workDef.id), false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("existing (non-draft) WorkDefs are published: PUT refused, Run works", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { title: "Live", goal: "g", enqueue: false })).json();
    assertEquals(workDef.draft, false);
    assertEquals((await put(app, `/api/work-defs/${workDef.id}`, { title: "Renamed" })).status, 409);
    assertEquals((await post(app, `/api/work-defs/${workDef.id}/enqueue`)).status, 200);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a Scheduled draft never fires; once published, a cron-only edit is still allowed", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { type: "Scheduled", cron: "* * * * *", title: "Minutely", goal: "g", draft: true })).json();
    store.runScheduler(new Date());
    assertEquals(readyCount(store), 0);

    // Publishing a Scheduled job enqueues nothing now; the next firing does.
    const body = await (await post(app, `/api/work-defs/${workDef.id}/publish`)).json();
    assertEquals(body.workItemId, null);
    store.runScheduler(new Date(Date.now() + 60_000));
    assertEquals(readyCount(store), 1);

    assertEquals((await put(app, `/api/work-defs/${workDef.id}`, { cron: "0 9 * * *" })).status, 200);
    assertEquals((await put(app, `/api/work-defs/${workDef.id}`, { cron: "0 9 * * *", goal: "x" })).status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a draft board task holds its story's slot until published", async () => {
  const { app, store, teamDir } = setup();
  try {
    // First task is a draft: nothing is admitted, and the second task waits behind it.
    store.createStory("s", "S", "d", "open", [], [
      { title: "Step one", description: "d1", draft: true },
      { title: "Step two", description: "d2" },
    ]);
    assertEquals(readyCount(store), 0);
    assertEquals(store.getTask("s-1")?.status, "todo");
    assertEquals(store.getTask("s-2")?.status, "todo");

    const stories = await (await app.request("/api/stories")).json();
    assertEquals(stories.stories[0].tasks.map((t: { draft: boolean }) => t.draft), [true, false]);

    // Publish → admitted into the first active state with a READY item.
    const body = await (await post(app, "/api/work-defs/s-1/publish")).json();
    assertEquals(body.success, true);
    assert(body.workItemId);
    assertEquals(store.getTask("s-1")?.status, "in_progress");
    assertEquals(readyCount(store), 1);
    assertEquals((await put(app, "/api/work-defs/s-1", { goal: "late edit" })).status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a draft board task moved into an agent state gets no WorkItem until published", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("m", "M", "d", "open", [], []);
    const added = await (await post(app, "/api/stories/m/tasks", { title: "T", description: "d", draft: true })).json();
    assertEquals(added.task.draft, true);
    assertEquals(readyCount(store), 0);

    assertEquals(store.moveTask(added.task.id, "in_progress").ok, true);
    assertEquals(readyCount(store), 0);

    await post(app, `/api/work-defs/${added.task.id}/publish`);
    assertEquals(readyCount(store), 1);
  } finally { cleanup(teamDir, store); }
});
