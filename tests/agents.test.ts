/**
 * tests/agents.test.ts — Verifies /api/agents/* (the WorkItem-centric contract)
 * plus the WorkItem queue lifecycle (see docs/DESIGN.md "The WorkItem").
 *
 * - Admission (CONWIP) pulls one task per story from todo and enqueues a READY WorkItem
 * - Agents register (with a directory), poll next-work, claim, and set COMPLETE/FAILED
 * - COMPLETE advances the task; FAILED leaves it stuck; the daemon owns the prompt
 * - Directory affinity biases matching; judgment moves + rework re-enqueue
 */

import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { withTeam, post } from "./_team.ts";
import { Store } from "../daemon/store.ts";
import { type WorkflowConfig } from "../shared/types.ts";

/** The READY WorkItem id for a task (the one admission enqueued). */
function workItemFor(store: Store, taskId: string): string {
  return store.getActiveWorkItem(taskId)!.id;
}

// The default workflow: in_progress (teammate) → review (manual).

// --- Registration ---

test("POST /api/agents/register creates an agent (with a directory)", async () => {
  await withTeam({}, async ({ app, store }) => {
    const res = await post(app, "/api/agents/register", { id: "agent-1", name: "swift-neo", directory: "/tmp/repo" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.config.defaultWorkflow, "default");
    assertEquals(store.getMember("agent-1")?.directory, "/tmp/repo");
  });
});

test("POST /api/agents/register rejects missing fields", async () => {
  await withTeam({}, async ({ app }) => {
    assertEquals((await post(app, "/api/agents/register", { id: "a1" })).status, 400);
  });
});

// --- Heartbeat ---

test("POST /api/agents/heartbeat updates status", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    assertEquals((await post(app, "/api/agents/heartbeat", { id: "a1", status: "working" })).status, 200);
    assertEquals(store.getMember("a1")?.status, "working");
  });
});

// --- Admission (CONWIP) enqueues a READY WorkItem ---

test("createStory admits the first task and enqueues a READY WorkItem; the rest wait", () => {
  return withTeam({}, ({ store }) => {
    store.createStory("s1", "S1", "D", "open", [], [
      { title: "T1", description: "D1" }, { title: "T2", description: "D2" },
    ], "default");
    assertEquals(store.getTask("s1-1")!.status, "in_progress");
    assertEquals(store.getActiveWorkItem("s1-1")!.state, "READY");
    assertEquals(store.getTask("s1-2")!.status, "todo");
    assertEquals(store.getActiveWorkItem("s1-2"), null);
  });
});

test("pending stories admit nothing until activated", () => {
  return withTeam({}, ({ store }) => {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default", true);
    assertEquals(store.getTask("s1-1")?.status, "todo");
    store.updateStoryDetails("s1", { pending: false });
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
  });
});

// --- Next Work ---

test("GET /api/agents/next-work returns the ready WorkItem", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const body = await (await app.request("/api/agents/next-work?agentId=a1")).json();
    assertEquals(body.workItem.id, workItemFor(store, "s1-1"));
    assertEquals(body.workItem.title, "T1");
  });
});

test("GET /api/agents/next-work returns null when paused", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    await post(app, "/api/control/pause", {});
    assertEquals((await (await app.request("/api/agents/next-work?agentId=a1")).json()).workItem, null);
  });
});

test("GET /api/agents/next-work returns null when the item is claimed", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    await post(app, `/api/agents/claim/${workItemFor(store, "s1-1")}`, { agentId: "a1" });
    assertEquals((await (await app.request("/api/agents/next-work?agentId=a2")).json()).workItem, null);
  });
});

test("next-work never offers a task in a manual state", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE", result: "did it" });
    assertEquals(store.getTask("s1-1")?.status, "review");
    assertEquals((await (await app.request("/api/agents/next-work?agentId=a1")).json()).workItem, null);
  });
});

// --- Claim ---

test("POST /api/agents/claim/:workItemId leases the item and returns the prompt", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    const body = await (await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" })).json();
    assertEquals(body.success, true);
    assertEquals(store.getWorkItem(wid)!.state, "IN_PROGRESS");
    assertEquals(store.getMember("a1")?.status, "working");
  });
});

test("POST /api/agents/claim rejects double claim", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    assertEquals((await post(app, `/api/agents/claim/${wid}`, { agentId: "a2" })).status, 409);
  });
});

test("claim prompt includes state role, lead comments, and completion guidance", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    store.addCommentForRef({ workDefId: "s1-1" }, "lead", "Please check the edge cases");
    const body = await (await post(app, `/api/agents/claim/${workItemFor(store, "s1-1")}`, { agentId: "a1" })).json();
    assertStringIncludes(body.prompt, "Your Role: in_progress");
    assertStringIncludes(body.prompt, "Comments from Team Lead");
    assertStringIncludes(body.prompt, "Please check the edge cases");
    assertStringIncludes(body.prompt, "advances automatically");
  });
});

test("claim prompt includes the story's working directory instruction", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default", false, "/tmp/proj");
    const body = await (await post(app, `/api/agents/claim/${workItemFor(store, "s1-1")}`, { agentId: "a1" })).json();
    assertStringIncludes(body.prompt, "Working Directory");
    assertStringIncludes(body.prompt, "/tmp/proj");
    assertStringIncludes(body.prompt, "AGENTS.md");
  });
});

// --- Set state (COMPLETE advances; FAILED leaves stuck) ---

test("state=COMPLETE advances to the next state and clears the lease", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    const body = await (await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE" })).json();
    assertEquals(body.success, true);
    assertEquals(body.newStatus, "review");
    assertEquals(body.completed, false);
    assertEquals(store.getTask("s1-1")!.status, "review");
    // The daemon posts no completion comment (the agent owns its comments).
    assertEquals(store.getCommentsForRef({ workDefId: "s1-1" }).length, 0);
    assertEquals(store.getWorkItem(wid)!.state, "COMPLETE");
    assertEquals(store.getAssignment("s1-1"), null);
    assertEquals(store.getMember("a1")?.status, "idle");
  });
});

test("state=COMPLETE in the last state completes the task and admits the next one", async () => {
  const soloAgent: WorkflowConfig = { states: [{ name: "work", type: "teammate" }] };
  await withTeam({ workflows: { default: soloAgent } }, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [
      { title: "T1", description: "D1" }, { title: "T2", description: "D2" },
    ], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    const body = await (await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE" })).json();
    assertEquals(body.completed, true);
    assertEquals(store.getTask("s1-1")?.status, "done");
    // CONWIP token freed → T2 admitted with its own READY WorkItem.
    assertEquals(store.getTask("s1-2")?.status, "work");
    assertEquals(store.getActiveWorkItem("s1-2")!.state, "READY");
  });
});

test("state setter rejects an agent that doesn't hold the item", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    assertEquals((await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a2", state: "COMPLETE" })).status, 403);
  });
});

test("state=FAILED leaves the task stuck with no active WorkItem", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    // "Giving up" = the agent posts a comment then fails the item (two primitives).
    await post(app, `/api/agents/comments/${wid}`, { agentId: "a1", body: "Need the API key" });
    await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "FAILED" });
    assertEquals(store.getWorkItem(wid)!.state, "FAILED");
    assertEquals(store.getTask("s1-1")!.status, "in_progress");
    assertEquals(store.getActiveWorkItem("s1-1"), null);
    assertEquals(store.getCommentsForRef({ workDefId: "s1-1" }).some(c => c.body.includes("Need the API key")), true);
  });
});

// --- Full lifecycle + rework ---

test("Full lifecycle: admit → claim → complete → human ships it → next admitted", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "Story", "Desc", "open", [], [
      { title: "Task1", description: "Do it" }, { title: "Task2", description: "Then this" },
    ], "default");

    let body = await (await app.request("/api/agents/next-work?agentId=a1")).json();
    const wid = body.workItem.id;
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE", result: "Code written" });
    assertEquals(store.getTask("s1-1")?.status, "review");

    // CONWIP: Task2 still waits.
    assertEquals(store.getTask("s1-2")?.status, "todo");
    assertEquals((await (await app.request("/api/agents/next-work?agentId=a1")).json()).workItem, null);

    // Human ships it → token freed → Task2 admitted.
    await post(app, "/api/tasks/s1-1/move", { status: "done" });
    assertEquals(store.getTask("s1-2")?.status, "in_progress");
    body = await (await app.request("/api/agents/next-work?agentId=a1")).json();
    assertEquals(body.workItem.id, workItemFor(store, "s1-2"));
  });
});

test("Rework: human sends the task back; re-entry ≡ first entry (fresh WorkItem)", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "Story", "Desc", "open", [], [
      { title: "Task1", description: "Do it" }, { title: "Task2", description: "Next" },
    ], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE", result: "First attempt" });
    assertEquals(store.getTask("s1-1")?.status, "review");

    store.addCommentForRef({ workDefId: "s1-1" }, "lead", "Please fix the edge case in parser.ts");
    await post(app, "/api/tasks/s1-1/move", { status: "in_progress" });
    // Fresh READY WorkItem for the re-entry.
    const wid2 = store.getActiveWorkItem("s1-1")!.id;
    assertEquals(store.getWorkItem(wid2)!.state, "READY");
    assertEquals(wid2 !== wid, true);
    assertEquals(store.getTask("s1-2")?.status, "todo"); // rework doesn't free the token

    const claimRes = await post(app, `/api/agents/claim/${wid2}`, { agentId: "a1" });
    assertStringIncludes((await claimRes.json()).prompt, "Please fix the edge case in parser.ts");
  });
});

test("Shelving: moving the active task to todo admits the next instead", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("s1", "S", "D", "open", [], [
      { title: "T1", description: "D1" }, { title: "T2", description: "D2" },
    ], "default");
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
    await post(app, "/api/tasks/s1-1/move", { status: "todo" });
    assertEquals(store.getTask("s1-1")?.status, "todo");
    assertEquals(store.getTask("s1-2")?.status, "in_progress");
  });
});

test("move rejects a state not in the workflow", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("s1", "S", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    assertEquals((await post(app, "/api/tasks/s1-1/move", { status: "nonsense" })).status, 400);
  });
});

// --- Comments ---

test("POST/GET /api/agents/comments/:workItemId roundtrip", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/comments/${wid}`, { agentId: "a1", body: "Status update: halfway done" });
    const body = await (await app.request(`/api/agents/comments/${wid}`)).json();
    assertEquals(body.comments.length, 1);
    assertEquals(body.comments[0].body, "Status update: halfway done");
  });
});

// --- List / Delete ---

test("GET /api/agents lists all registered agents", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/home");
    const body = await (await app.request("/api/agents")).json();
    assertEquals(body.agents.length, 2);
  });
});

test("DELETE /api/agents/:id removes an agent", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.registerMember("a1", "neo", "/tmp");
    assertEquals((await app.request("/api/agents/a1", { method: "DELETE" })).status, 200);
    assertEquals(store.getMembers().length, 0);
  });
});

test("DELETE /api/agents/:id returns 404 for unknown", async () => {
  await withTeam({}, async ({ app }) => {
    assertEquals((await app.request("/api/agents/nope", { method: "DELETE" })).status, 404);
  });
});

// --- Directory-affinity matching ---

test("next-work biases to the agent's directory; unhomed work is anyone's", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("sa", "A", "D", "open", [], [{ title: "TA", description: "d" }], "default", false, "/repo/a");
    store.createStory("sc", "C", "D", "open", [], [{ title: "TC", description: "d" }], "default");

    // Agent in /repo/a gets its own repo's work (tier 1).
    const forA = await (await app.request("/api/agents/next-work?agentId=ag-a&")).json();
    // ag-a isn't registered → treat as no directory; register it properly:
    store.registerMember("ag-a", "a", "/repo/a");
    const forA2 = await (await app.request("/api/agents/next-work?agentId=ag-a")).json();
    assertEquals(!!store.getTask(store.getWorkItem(forA2.workItem.id)!.ref.workDefId), true);
    assertEquals(store.getTask(store.getWorkItem(forA2.workItem.id)!.ref.workDefId)!.storyId, "sa");
    void forA;
  });
});

test("next-work: a directory-tagged item waits for an online agent with that dir", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createStory("sb", "B", "D", "open", [], [{ title: "TB", description: "d" }], "default", false, "/repo/b");
    store.registerMember("ag-b", "b", "/repo/b");   // online, matching dir
    store.registerMember("ag-x", "x", "/repo/x");   // wrong dir

    // ag-x must not grab B's work (reserved for the present /repo/b agent).
    assertEquals((await (await app.request("/api/agents/next-work?agentId=ag-x")).json()).workItem, null);
    // ag-b gets it.
    const forB = await (await app.request("/api/agents/next-work?agentId=ag-b")).json();
    assertEquals(store.getWorkItem(forB.workItem.id) !== null, true);
  });
});
