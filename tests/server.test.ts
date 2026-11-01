/**
 * tests/server.test.ts — Verifies API routes via Hono's app.request() test
 * helper (no real server). Covers stories/tasks, the WorkItem-centric agent
 * contract, the WorkItem queue, and WorkDefs.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, JSON_HEADERS } from "./_team.ts";

test("GET /health returns ok", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await app.request("/health");
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, "ok");
  });
});

test("GET /api/status returns dashboard data", async () => {
  await withTeam({}, async ({ app }) => {
    const body = await (await app.request("/api/status")).json();
    assertEquals(body.running, true);
    assertEquals(body.defaultWorkflow, "default");
  });
});

test("POST /api/stories creates a story", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await app.request("/api/stories", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ id: "s1", title: "Story 1", description: "Test", workflow: "default", tasks: [{ title: "T1", description: "D1" }] }),
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.story.tasks.length, 1);
  });
});

test("POST /api/stories rejects duplicate", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("s1", "S1", "D", "open", []);
    const res = await app.request("/api/stories", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ id: "s1", title: "Dup", description: "D", workflow: "default" }),
    });
    assertEquals(res.status, 409);
  });
});

test("agent contract: register -> next-work -> claim -> COMPLETE", async () => {
  await withTeam({}, async ({ app, store }) => {
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
  });
});

test("GET /api/work-items filters by state", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const res = await (await app.request("/api/work-items?state=READY")).json();
    assertEquals(res.total, 1);
    assertEquals(res.items[0].ref.workDefId, "s1-1");
  });
});

test("WorkDef routes: create (solitary) enqueues; save-without-enqueue does not", async () => {
  await withTeam({}, async ({ app, store }) => {
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
  });
});

test("WorkDef routes: scheduled requires a valid cron", async () => {
  await withTeam({}, async ({ app }) => {
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
  });
});

test("WorkDef routes: ref-based attachments (upload, list, serve, delete) work for standalone work", async () => {
  await withTeam({}, async ({ app }) => {
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
  });
});

test("WorkDef routes: comment carries attachment metadata; token-usage records cost", async () => {
  await withTeam({}, async ({ app, store }) => {
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
    assertEquals(store.getTokenUsageSummary({ workDefId: id })!.totalInputTokens, 100);

    // A harness-reported costUsd is stored verbatim (not re-estimated).
    await app.request(`/api/work-defs/${id}/token-usage`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ inputTokens: 10, outputTokens: 5, model: "gpt-4o", costUsd: 0.42 }),
    });
    // 0.42 (reported) + the first entry's small estimate; the reported one must
    // land exactly, so the total exceeds 0.42.
    const summary = store.getTokenUsageSummary({ workDefId: id })!;
    assertEquals(summary.totalCostUsd >= 0.42, true);
  });
});

test("work-item cancel (READY) and re-enqueue by ref", async () => {
  await withTeam({}, async ({ app, store }) => {
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
  });
});

test("POST/GET agent comments roundtrip (by work item)", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const wid = store.getWorkItems({ states: ["READY"] }).items[0]!.id;
    await app.request(`/api/agents/comments/${wid}`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ agentId: "a1", body: "working on it" }),
    });
    const got = await (await app.request(`/api/agents/comments/${wid}`)).json();
    assertEquals(got.comments.length, 1);
    assertEquals(got.comments[0].body, "working on it");
    // The comment lives on the task ref.
    assertEquals(store.getCommentsForRef({ workDefId: "s1-1" }).length, 1);
  });
});

// ─── Thoughts board ──────────────────────────────────────────────────

test("Thoughts API: create, list, patch, archive, delete", async () => {
  await withTeam({}, async ({ app, store }) => {
    // Create
    const created = await (await app.request("/api/thoughts", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ content: "idea one", color: "blue" }),
    })).json();
    assertEquals(created.success, true);
    assertEquals(created.thought.content, "idea one");
    const id = created.thought.id;

    // List (active default)
    const list = await (await app.request("/api/thoughts")).json();
    assertEquals(list.thoughts.length, 1);
    assertEquals(Array.isArray(list.groups), true);

    // Patch content + pin
    const patched = await (await app.request(`/api/thoughts/${id}`, {
      method: "PATCH", headers: JSON_HEADERS,
      body: JSON.stringify({ content: "idea one (edited)", pinned: true }),
    })).json();
    assertEquals(patched.thought.pinned, true);
    assertEquals(patched.thought.content, "idea one (edited)");

    // Archive → excluded from active list
    await app.request(`/api/thoughts/${id}/archive`, { method: "POST" });
    const activeOnly = await (await app.request("/api/thoughts?status=active")).json();
    assertEquals(activeOnly.thoughts.length, 0);

    // Delete (direct)
    const del = await app.request(`/api/thoughts/${id}`, { method: "DELETE" });
    assertEquals(del.status, 200);
    assertEquals(store.getThought(id), null);
  });
});

test("Thoughts API: x/y must be provided together", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await app.request("/api/thoughts", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ content: "x", x: 10 }),
    });
    assertEquals(res.status, 400);
  });
});

test("Thoughts API: batch positions + groups", async () => {
  await withTeam({}, async ({ app, store }) => {
    const a = (await (await app.request("/api/thoughts", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ content: "a" }) })).json()).thought;
    const b = (await (await app.request("/api/thoughts", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ content: "b" }) })).json()).thought;

    // Batch move
    const moved = await (await app.request("/api/thoughts/positions", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ moves: [{ id: a.id, x: 5, y: 6 }, { id: b.id, x: 7, y: 8 }] }),
    })).json();
    assertEquals(moved.updated.length, 2);

    // Create a group with members
    const grp = await (await app.request("/api/thought-groups", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Ideas", memberIds: [a.id, b.id] }),
    })).json();
    assertEquals(grp.success, true);
    assertEquals(store.getThought(a.id)!.groupId, grp.group.id);

    // Rename
    const renamed = await (await app.request(`/api/thought-groups/${grp.group.id}`, {
      method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ title: "Ideas v2" }),
    })).json();
    assertEquals(renamed.group.title, "Ideas v2");

    // Ungroup clears membership
    await app.request(`/api/thought-groups/${grp.group.id}`, { method: "DELETE" });
    assertEquals(store.getThought(a.id)!.groupId, null);
  });
});

// ─── Agent dismiss vs. re-register (daemon restart safety) ───────────

test("Heartbeat: unknown member is told to re-register (not dismissed)", async () => {
  await withTeam({}, async ({ app, store }) => {
    // Never-registered id → reregister, not dismissed (mirrors a restart wipe).
    const res = await (await app.request("/api/agents/heartbeat", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: "ghost", status: "idle" }),
    })).json();
    assertEquals(res.dismissed, undefined);
    assertEquals(res.reregister, true);

    // A registered member heartbeats normally.
    store.registerMember("m1", "m1", "/tmp/repo");
    const ok = await (await app.request("/api/agents/heartbeat", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: "m1", status: "idle" }),
    })).json();
    assertEquals(ok.success, true);
  });
});

test("Heartbeat: an explicitly dismissed member is told to shut down", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("m1", "m1", "/tmp/repo");
    // UI dismiss (?dismiss=true) tombstones the id.
    await app.request("/api/agents/m1?dismiss=true", { method: "DELETE" });
    const res = await (await app.request("/api/agents/heartbeat", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: "m1", status: "idle" }),
    })).json();
    assertEquals(res.dismissed, true);
    assertEquals(res.reregister, undefined);

    // Re-registering clears the tombstone (so a reused id isn't stuck dismissed).
    store.registerMember("m1", "m1", "/tmp/repo");
    const after = await (await app.request("/api/agents/heartbeat", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: "m1", status: "idle" }),
    })).json();
    assertEquals(after.success, true);
  });
});

test("Heartbeat: a plain deregister (no dismiss) → re-register, not dismissed", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("m1", "m1", "/tmp/repo");
    await app.request("/api/agents/m1", { method: "DELETE" }); // clean self-deregister
    const res = await (await app.request("/api/agents/heartbeat", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: "m1", status: "idle" }),
    })).json();
    assertEquals(res.reregister, true);
    assertEquals(res.dismissed, undefined);
  });
});
