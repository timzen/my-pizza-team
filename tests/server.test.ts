/**
 * tests/server.test.ts — Verifies API routes via Hono's app.request() test
 * helper (no real server). Covers stories/tasks, the WorkItem-centric agent
 * contract, the WorkItem queue, and WorkDefs.
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import * as path from "@std/path";

function setup(): { app: ReturnType<typeof buildApp>; store: Store; teamDir: string } {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-server-test-" });
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

Deno.test("GET /health returns ok", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/health");
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, "ok");
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/status returns dashboard data", async () => {
  const { app, store, teamDir } = setup();
  try {
    const body = await (await app.request("/api/status")).json();
    assertEquals(body.running, true);
    assertEquals(body.defaultWorkflow, "default");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/stories creates a story", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/stories", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ id: "s1", title: "Story 1", description: "Test", workflow: "default", tasks: [{ title: "T1", description: "D1" }] }),
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.story.tasks.length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/stories rejects duplicate", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", []);
    const res = await app.request("/api/stories", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ id: "s1", title: "Dup", description: "D", workflow: "default" }),
    });
    assertEquals(res.status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("agent contract: register -> next-work -> claim -> COMPLETE", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);

    const reg = await app.request("/api/agents/register", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ id: "a1", name: "swift-ripley", directory: "/tmp/repo" }),
    });
    assertEquals((await reg.json()).success, true);

    const nw = await (await app.request("/api/agents/next-work?agentId=a1")).json();
    assertEquals(typeof nw.workItem.id, "string");
    assertEquals(nw.workItem.title, "T1");
    const wid = nw.workItem.id;

    const claim = await (await app.request(`/api/agents/claim/${wid}`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ agentId: "a1" }),
    })).json();
    assertEquals(claim.success, true);
    assertEquals(typeof claim.prompt, "string");
    assertEquals(claim.prompt.includes("T1"), true);

    const done = await (await app.request(`/api/agents/work-items/${wid}/state`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ agentId: "a1", state: "COMPLETE", result: "did it" }),
    })).json();
    assertEquals(done.success, true);
    assertEquals(store.getTask("s1-1")!.status, "review");
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/work-items filters by state", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const res = await (await app.request("/api/work-items?state=READY")).json();
    assertEquals(res.total, 1);
    assertEquals(res.items[0].ref.workDefId, "s1-1");
  } finally { cleanup(teamDir, store); }
});

Deno.test("WorkDef routes: create (solitary) enqueues; save-without-enqueue does not", async () => {
  const { app, store, teamDir } = setup();
  try {
    const created = await (await app.request("/api/work-defs", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "One shot", goal: "do a thing", acceptanceCriteria: "- MUST work" }),
    })).json();
    assertEquals(created.success, true);
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);

    await app.request("/api/work-defs", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Saved only", goal: "later", acceptanceCriteria: "-", enqueue: false }),
    });
    // Still just the one READY item (the second was saved without enqueueing).
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);
    assertEquals(store.getWorkDefs().length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("WorkDef routes: scheduled requires a valid cron", async () => {
  const { app, store, teamDir } = setup();
  try {
    const bad = await app.request("/api/work-defs", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Sched", goal: "g", acceptanceCriteria: "a", type: "Scheduled", cron: "not a cron" }),
    });
    assertEquals(bad.status, 400);

    const ok = await app.request("/api/work-defs", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Sched", goal: "g", acceptanceCriteria: "a", type: "Scheduled", cron: "0 9 * * *" }),
    });
    assertEquals(ok.status, 201);
  } finally { cleanup(teamDir, store); }
});

Deno.test("WorkDef routes: ref-based attachments (upload, list, serve, delete) work for standalone work", async () => {
  const { app, store, teamDir } = setup();
  try {
    const created = await (await app.request("/api/work-defs", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Solo", goal: "g", acceptanceCriteria: "-", enqueue: false }),
    })).json();
    const id = created.workDef.id;

    // Upload
    const up = await (await app.request(`/api/work-defs/${id}/attachments`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ name: "patch.diff", content: "--- a\n+++ b\n" }),
    })).json();
    assertEquals(up.success, true);
    assertEquals(up.type, "diff");
    const storedName = up.storedName;

    // List
    const list = await (await app.request(`/api/work-defs/${id}/attachments`)).json();
    assertEquals(list.attachments.length, 1);
    assertEquals(list.attachments[0].name, "patch.diff");

    // Serve raw content with a diff mime type
    const raw = await app.request(`/api/work-defs/${id}/attachments/${encodeURIComponent(storedName)}`);
    assertEquals(raw.status, 200);
    assertEquals(raw.headers.get("content-type"), "text/x-diff");
    assertEquals((await raw.text()).includes("+++ b"), true);

    // Delete
    const del = await app.request(`/api/work-defs/${id}/attachments/${encodeURIComponent(storedName)}`, { method: "DELETE" });
    assertEquals(del.status, 200);
    const after = await (await app.request(`/api/work-defs/${id}/attachments`)).json();
    assertEquals(after.attachments.length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("WorkDef routes: comment carries attachment metadata; token-usage records cost", async () => {
  const { app, store, teamDir } = setup();
  try {
    const created = await (await app.request("/api/work-defs", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Solo", goal: "g", acceptanceCriteria: "-", enqueue: false }),
    })).json();
    const id = created.workDef.id;

    // Comment with an attachment badge is preserved on the ref.
    await app.request(`/api/work-defs/${id}/comment`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ from: "lead", body: "see diff", attachments: [{ name: "r.review.json", size: 3, type: "review" }] }),
    });
    const comments = store.getCommentsForRef({ workDefId: id });
    assertEquals(comments.length, 1);
    assertEquals(comments[0]!.attachments?.[0]?.name, "r.review.json");

    // Token usage is accepted for a standalone WorkDef and reports a cost.
    const tu = await (await app.request(`/api/work-defs/${id}/token-usage`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ inputTokens: 100, outputTokens: 50, model: "gpt-4o" }),
    })).json();
    assertEquals(tu.success, true);
    assertEquals(typeof tu.costUsd, "number");
    assertEquals(store.getTokenUsageSummaryForRef({ workDefId: id })!.totalInputTokens, 100);
  } finally { cleanup(teamDir, store); }
});

Deno.test("work-item cancel (READY) and re-enqueue by ref", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const wid = store.getWorkItems({ states: ["READY"] }).items[0]!.id;

    const cancel = await (await app.request(`/api/work-items/${wid}/cancel`, { method: "POST" })).json();
    assertEquals(cancel.success, true);
    assertEquals(store.getWorkItem(wid)!.state, "CANCELED");

    const re = await (await app.request("/api/work-items/re-enqueue", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ ref: { workDefId: "s1-1" } }),
    })).json();
    assertEquals(re.success, true);
    assertEquals(store.getWorkItems({ states: ["READY"] }).total, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST/GET agent comments roundtrip (by work item)", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const wid = store.getWorkItems({ states: ["READY"] }).items[0]!.id;
    await app.request(`/api/agents/comments/${wid}`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ agentId: "a1", body: "working on it" }),
    });
    const got = await (await app.request(`/api/agents/comments/${wid}`)).json();
    assertEquals(got.comments.length, 1);
    assertEquals(got.comments[0].body, "working on it");
    // The comment lives on the task ref.
    assertEquals(store.getComments("s1-1").length, 1);
  } finally { cleanup(teamDir, store); }
});
