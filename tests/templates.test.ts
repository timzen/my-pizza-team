/**
 * tests/templates.test.ts — Task Template CRUD via the /api/templates routes.
 *
 * A Template is a reusable mold for a Solitary task: it stores the same authored
 * fields as a WorkDef but never enqueues a WorkItem and never appears in the
 * /api/work-defs listing (it lives under templates/, separate from work).
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import * as path from "@std/path";

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-templates-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, DEFAULT_CONFIG);
  const app = buildApp(store, DEFAULT_CONFIG, teamDir);
  return { app, store, teamDir };
}
function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
}
const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.test("POST /api/templates creates a template (no WorkItem enqueued)", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/templates", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Investigate a ticket", goal: "Dig into the ticket", acceptanceCriteria: "MUST summarize findings", directory: "/tmp/repo" }),
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.template.id, "investigate-a-ticket");
    assertEquals(body.template.goal, "Dig into the ticket");

    // A template must not create work: no WorkItems, and it's absent from /api/work-defs.
    assertEquals(store.getWorkItems({}).items.length, 0);
    const wds = await (await app.request("/api/work-defs")).json();
    assertEquals(wds.workDefs.length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET/PUT/DELETE /api/templates round-trips", async () => {
  const { app, store, teamDir } = setup();
  try {
    await app.request("/api/templates", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Research package", goal: "Study the code", acceptanceCriteria: "MUST note the entry points" }),
    });

    const list = await (await app.request("/api/templates")).json();
    assertEquals(list.templates.length, 1);
    const id = list.templates[0].id;

    const put = await app.request(`/api/templates/${id}`, {
      method: "PUT", headers: JSON_HEADERS,
      body: JSON.stringify({ goal: "Study the code deeply", additionalContext: "Focus on auth" }),
    });
    assertEquals((await put.json()).template.goal, "Study the code deeply");

    const got = await (await app.request(`/api/templates/${id}`)).json();
    assertEquals(got.template.additionalContext, "Focus on auth");

    const del = await app.request(`/api/templates/${id}`, { method: "DELETE" });
    assertEquals((await del.json()).success, true);
    assertEquals((await (await app.request("/api/templates")).json()).templates.length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/templates/:id 404s for unknown", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/templates/nope");
    assertEquals(res.status, 404);
  } finally { cleanup(teamDir, store); }
});
