/**
 * tests/pending.test.ts — Pending WorkDefs (docs/DESIGN.md "Pending: Write, Review, Activate").
 *
 * A pending WorkDef is editable and never gets a WorkItem — not on create, Run,
 * cron, or board admission (where it holds its story's next slot). Activating is
 * one-way: it makes the WorkDef eligible (Solitary: enqueued; Board: admitted;
 * Scheduled: next cron) and locks its definition against further PUTs.
 *
 * Also covers the pre-rename spellings: `draft: true` frontmatter loads as
 * pending, and the deprecated `draft` request field / `POST …/publish` route
 * still work for one release.
 */

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { parseWorkDef, serializeWorkDef } from "../daemon/store/workdefs.ts";

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-pending-test-" });
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

Deno.test("pending frontmatter round-trips; absent means active", () => {
  const def = { id: "d", title: "T", goal: "g", acceptanceCriteria: "a", pending: true };
  assertEquals(parseWorkDef("d", serializeWorkDef(def))?.pending, true);
  const active = parseWorkDef("p", serializeWorkDef({ id: "p", title: "T", goal: "g", acceptanceCriteria: "a" }));
  assertEquals(active?.pending, undefined);
  assert(!serializeWorkDef({ id: "p", title: "T", goal: "g", acceptanceCriteria: "a" }).includes("pending"));
});

Deno.test("legacy draft: true frontmatter loads as pending and is rewritten as pending", () => {
  const legacy = "---\ntitle: \"Old\"\ndraft: true\n---\n## Goal\n\ng\n\n## Acceptance Criteria\n\na\n\n## Additional Context\n\n";
  const def = parseWorkDef("old", legacy)!;
  assertEquals(def.pending, true);
  const rewritten = serializeWorkDef(def);
  assert(rewritten.includes("pending: true"));
  assert(!rewritten.includes("draft"));
});

Deno.test("a Solitary pending task is not enqueued, can't be Run, and stays editable", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/work-defs", { title: "Pending job", goal: "g", acceptanceCriteria: "a", pending: true });
    assertEquals(res.status, 201);
    const { workDef } = await res.json();
    assertEquals(workDef.pending, true);
    assertEquals(readyCount(store), 0);

    // Run refuses a pending WorkDef.
    assertEquals((await post(app, `/api/work-defs/${workDef.id}/enqueue`)).status, 409);
    assertEquals(readyCount(store), 0);

    // Editable while pending.
    const edit = await put(app, `/api/work-defs/${workDef.id}`, { goal: "better goal" });
    assertEquals(edit.status, 200);
    assertEquals((await edit.json()).workDef.goal, "better goal");
    assertEquals(readyCount(store), 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("activating a Solitary pending task enqueues it and locks its definition", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { title: "Pending job", goal: "g", acceptanceCriteria: "a", pending: true })).json();
    const pub = await post(app, `/api/work-defs/${workDef.id}/activate`);
    assertEquals(pub.status, 200);
    const body = await pub.json();
    assertEquals(body.workDef.pending, false);
    assert(body.workItemId);
    assertEquals(readyCount(store), 1);

    // Locked: any definition edit is refused, and nothing changed on disk.
    const edit = await put(app, `/api/work-defs/${workDef.id}`, { goal: "sneaky edit" });
    assertEquals(edit.status, 409);
    assertEquals(store.getWorkDef(workDef.id)?.goal, "g");

    // Activating twice is a 409; an unknown id is a 404.
    assertEquals((await post(app, `/api/work-defs/${workDef.id}/activate`)).status, 409);
    assertEquals((await post(app, "/api/work-defs/nope/activate")).status, 404);
  } finally { cleanup(teamDir, store); }
});

Deno.test("activate with enqueue:false activates a Solitary pending task without running it", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { title: "Later", goal: "g", pending: true })).json();
    const body = await (await post(app, `/api/work-defs/${workDef.id}/activate`, { enqueue: false })).json();
    assertEquals(body.success, true);
    assertEquals(body.workItemId, null);
    assertEquals(readyCount(store), 0);
    assertEquals(store.isPending(workDef.id), false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("existing (non-pending) WorkDefs are active: PUT refused, Run works", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { title: "Live", goal: "g", enqueue: false })).json();
    assertEquals(workDef.pending, false);
    assertEquals((await put(app, `/api/work-defs/${workDef.id}`, { title: "Renamed" })).status, 409);
    assertEquals((await post(app, `/api/work-defs/${workDef.id}/enqueue`)).status, 200);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a Scheduled pending job never fires; once activated, a cron-only edit is still allowed", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { type: "Scheduled", cron: "* * * * *", title: "Minutely", goal: "g", pending: true })).json();
    store.runScheduler(new Date());
    assertEquals(readyCount(store), 0);

    // Activating a Scheduled job enqueues nothing now; the next firing does.
    const body = await (await post(app, `/api/work-defs/${workDef.id}/activate`)).json();
    assertEquals(body.workItemId, null);
    store.runScheduler(new Date(Date.now() + 60_000));
    assertEquals(readyCount(store), 1);

    assertEquals((await put(app, `/api/work-defs/${workDef.id}`, { cron: "0 9 * * *" })).status, 200);
    assertEquals((await put(app, `/api/work-defs/${workDef.id}`, { cron: "0 9 * * *", goal: "x" })).status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a pending board task holds its story's slot until activated", async () => {
  const { app, store, teamDir } = setup();
  try {
    // First task is pending: nothing is admitted, and the second task waits behind it.
    store.createStory("s", "S", "d", "open", [], [
      { title: "Step one", description: "d1", pending: true },
      { title: "Step two", description: "d2" },
    ]);
    assertEquals(readyCount(store), 0);
    assertEquals(store.getTask("s-1")?.status, "todo");
    assertEquals(store.getTask("s-2")?.status, "todo");

    const stories = await (await app.request("/api/stories")).json();
    assertEquals(stories.stories[0].tasks.map((t: { pending: boolean }) => t.pending), [true, false]);

    // Activate → admitted into the first active state with a READY item.
    const body = await (await post(app, "/api/work-defs/s-1/activate")).json();
    assertEquals(body.success, true);
    assert(body.workItemId);
    assertEquals(store.getTask("s-1")?.status, "in_progress");
    assertEquals(readyCount(store), 1);
    assertEquals((await put(app, "/api/work-defs/s-1", { goal: "late edit" })).status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a pending board task moved into an agent state gets no WorkItem until activated", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("m", "M", "d", "open", [], []);
    const added = await (await post(app, "/api/stories/m/tasks", { title: "T", description: "d", pending: true })).json();
    assertEquals(added.task.pending, true);
    assertEquals(readyCount(store), 0);

    assertEquals(store.moveTask(added.task.id, "in_progress").ok, true);
    assertEquals(readyCount(store), 0);

    await post(app, `/api/work-defs/${added.task.id}/activate`);
    assertEquals(readyCount(store), 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("deprecated aliases: draft:true creates pending, POST …/publish activates", async () => {
  const { app, store, teamDir } = setup();
  try {
    const { workDef } = await (await post(app, "/api/work-defs", { title: "Old client", goal: "g", draft: true })).json();
    assertEquals(workDef.pending, true);
    assertEquals(readyCount(store), 0);
    const body = await (await post(app, `/api/work-defs/${workDef.id}/publish`)).json();
    assertEquals(body.success, true);
    assertEquals(body.workDef.pending, false);
    assertEquals(readyCount(store), 1);

    // Board tasks too: add_task and create-story tasks[] from an older extension.
    store.createStory("a", "A", "d", "open", [], []);
    const added = await (await post(app, "/api/stories/a/tasks", { title: "T", description: "d", draft: true })).json();
    assertEquals(added.task.pending, true);
    const created = await (await post(app, "/api/stories", { id: "b", title: "B", description: "d", workflow: "default", tasks: [{ title: "T", description: "d", draft: true }] })).json();
    assertEquals(created.story.tasks[0].pending, true);
  } finally { cleanup(teamDir, store); }
});
