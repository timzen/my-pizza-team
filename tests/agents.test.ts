/**
 * tests/agents.test.ts — Verifies /api/agents/* (the WorkItem-centric contract)
 * plus the WorkItem queue lifecycle (see docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md).
 *
 * - Admission (CONWIP) pulls one task per story from todo and enqueues a READY WorkItem
 * - Agents register (with a directory), poll next-work, claim, and set COMPLETE/FAILED
 * - COMPLETE advances the task; FAILED leaves it stuck; the daemon owns the prompt
 * - Directory affinity biases matching; judgment moves + rework re-enqueue
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig, type WorkflowConfig } from "../shared/types.ts";
import * as path from "@std/path";

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-agents-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const store = new Store(teamDir, config);
  if (configOverride?.workflows) {
    for (const [name, wf] of Object.entries(configOverride.workflows)) store.saveWorkflow(name, wf);
  }
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir, config };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

function post(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** The READY WorkItem id for a task (the one admission enqueued). */
function workItemFor(store: Store, taskId: string): string {
  return store.getActiveWorkItemForTask(taskId)!.id;
}

// The default workflow: in_progress (agent) → review (manual).

// --- Registration ---

Deno.test("POST /api/agents/register creates an agent (with a directory)", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/agents/register", { id: "agent-1", name: "swift-neo", directory: "/tmp/repo" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.config.defaultWorkflow, "default");
    assertEquals(store.getMember("agent-1")?.directory, "/tmp/repo");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/register rejects missing fields", async () => {
  const { app, store, teamDir } = setup();
  try {
    assertEquals((await post(app, "/api/agents/register", { id: "a1" })).status, 400);
  } finally { cleanup(teamDir, store); }
});

// --- Heartbeat ---

Deno.test("POST /api/agents/heartbeat updates status", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    assertEquals((await post(app, "/api/agents/heartbeat", { id: "a1", status: "working" })).status, 200);
    assertEquals(store.getMember("a1")?.status, "working");
  } finally { cleanup(teamDir, store); }
});

// --- Admission (CONWIP) enqueues a READY WorkItem ---

Deno.test("createStory admits the first task and enqueues a READY WorkItem; the rest wait", () => {
  const { store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [
      { title: "T1", description: "D1" }, { title: "T2", description: "D2" },
    ], "default");
    assertEquals(store.getTask("s1-1")!.status, "in_progress");
    assertEquals(store.getActiveWorkItemForTask("s1-1")!.state, "READY");
    assertEquals(store.getTask("s1-2")!.status, "todo");
    assertEquals(store.getActiveWorkItemForTask("s1-2"), null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("paused stories admit nothing until unpaused", () => {
  const { store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default", undefined, true);
    assertEquals(store.getTask("s1-1")?.status, "todo");
    store.updateStoryDetails("s1", { paused: false });
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
  } finally { cleanup(teamDir, store); }
});

// --- Next Work ---

Deno.test("GET /api/agents/next-work returns the ready WorkItem", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const body = await (await app.request("/api/agents/next-work?agentId=a1")).json();
    assertEquals(body.workItem.id, workItemFor(store, "s1-1"));
    assertEquals(body.workItem.title, "T1");
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/agents/next-work returns null when paused", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    await post(app, "/api/control/pause", {});
    assertEquals((await (await app.request("/api/agents/next-work?agentId=a1")).json()).workItem, null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/agents/next-work returns null when the item is claimed", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    await post(app, `/api/agents/claim/${workItemFor(store, "s1-1")}`, { agentId: "a1" });
    assertEquals((await (await app.request("/api/agents/next-work?agentId=a2")).json()).workItem, null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("next-work never offers a task in a manual state", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE", result: "did it" });
    assertEquals(store.getTask("s1-1")?.status, "review");
    assertEquals((await (await app.request("/api/agents/next-work?agentId=a1")).json()).workItem, null);
  } finally { cleanup(teamDir, store); }
});

// --- Claim ---

Deno.test("POST /api/agents/claim/:workItemId leases the item and returns the prompt", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    const body = await (await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" })).json();
    assertEquals(body.success, true);
    assertEquals(store.getWorkItem(wid)!.state, "IN_PROGRESS");
    assertEquals(store.getMember("a1")?.status, "working");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/claim rejects double claim", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    assertEquals((await post(app, `/api/agents/claim/${wid}`, { agentId: "a2" })).status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("claim prompt includes state role, lead comments, and completion guidance", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    store.addComment("s1-1", "lead", "Please check the edge cases");
    const body = await (await post(app, `/api/agents/claim/${workItemFor(store, "s1-1")}`, { agentId: "a1" })).json();
    assertStringIncludes(body.prompt, "Your Role: in_progress");
    assertStringIncludes(body.prompt, "Comments from Team Lead");
    assertStringIncludes(body.prompt, "Please check the edge cases");
    assertStringIncludes(body.prompt, "the task advances automatically");
  } finally { cleanup(teamDir, store); }
});

Deno.test("claim prompt includes the story's working directory instruction", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default", undefined, false, "/tmp/proj");
    const body = await (await post(app, `/api/agents/claim/${workItemFor(store, "s1-1")}`, { agentId: "a1" })).json();
    assertStringIncludes(body.prompt, "Working Directory");
    assertStringIncludes(body.prompt, "/tmp/proj");
    assertStringIncludes(body.prompt, "AGENTS.md");
  } finally { cleanup(teamDir, store); }
});

// --- Set state (COMPLETE advances; FAILED leaves stuck) ---

Deno.test("state=COMPLETE advances to the next state and clears the lease", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    const body = await (await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE", result: "Done working" })).json();
    assertEquals(body.success, true);
    assertEquals(body.newStatus, "review");
    assertEquals(body.completed, false);
    assertEquals(store.getTask("s1-1")!.status, "review");
    assertEquals(store.getTask("s1-1")!.result, "Done working");
    assertEquals(store.getWorkItem(wid)!.state, "COMPLETE");
    assertEquals(store.getAssignment("s1-1"), null);
    assertEquals(store.getMember("a1")?.status, "idle");
  } finally { cleanup(teamDir, store); }
});

Deno.test("state=COMPLETE in the last state completes the task and admits the next one", async () => {
  const soloAgent: WorkflowConfig = { states: [{ name: "work", type: "agent" }] };
  const { app, store, teamDir } = setup({ workflows: { default: soloAgent } });
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [
      { title: "T1", description: "D1" }, { title: "T2", description: "D2" },
    ], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    const body = await (await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE", result: "All done" })).json();
    assertEquals(body.completed, true);
    assertEquals(store.getTask("s1-1")?.status, "done");
    // CONWIP token freed → T2 admitted with its own READY WorkItem.
    assertEquals(store.getTask("s1-2")?.status, "work");
    assertEquals(store.getActiveWorkItemForTask("s1-2")!.state, "READY");
  } finally { cleanup(teamDir, store); }
});

Deno.test("state setter rejects an agent that doesn't hold the item", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    assertEquals((await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a2", state: "COMPLETE" })).status, 403);
  } finally { cleanup(teamDir, store); }
});

Deno.test("state=FAILED leaves the task stuck with no active WorkItem", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    // "Giving up" = the agent posts a comment then fails the item (two primitives).
    await post(app, `/api/agents/comments/${wid}`, { agentId: "a1", body: "Need the API key" });
    await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "FAILED" });
    assertEquals(store.getWorkItem(wid)!.state, "FAILED");
    assertEquals(store.getTask("s1-1")!.status, "in_progress");
    assertEquals(store.getActiveWorkItemForTask("s1-1"), null);
    assertEquals(store.getComments("s1-1").some(c => c.body.includes("Need the API key")), true);
  } finally { cleanup(teamDir, store); }
});

// --- Full lifecycle + rework ---

Deno.test("Full lifecycle: admit → claim → complete → human ships it → next admitted", async () => {
  const { app, store, teamDir } = setup();
  try {
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
  } finally { cleanup(teamDir, store); }
});

Deno.test("Rework: human sends the task back; re-entry ≡ first entry (fresh WorkItem)", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.createStory("s1", "Story", "Desc", "open", [], [
      { title: "Task1", description: "Do it" }, { title: "Task2", description: "Next" },
    ], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/claim/${wid}`, { agentId: "a1" });
    await post(app, `/api/agents/work-items/${wid}/state`, { agentId: "a1", state: "COMPLETE", result: "First attempt" });
    assertEquals(store.getTask("s1-1")?.status, "review");

    store.addComment("s1-1", "lead", "Please fix the edge case in parser.ts");
    await post(app, "/api/tasks/s1-1/move", { status: "in_progress" });
    // Fresh READY WorkItem for the re-entry.
    const wid2 = store.getActiveWorkItemForTask("s1-1")!.id;
    assertEquals(store.getWorkItem(wid2)!.state, "READY");
    assertEquals(wid2 !== wid, true);
    assertEquals(store.getTask("s1-2")?.status, "todo"); // rework doesn't free the token

    const claimRes = await post(app, `/api/agents/claim/${wid2}`, { agentId: "a1" });
    assertStringIncludes((await claimRes.json()).prompt, "Please fix the edge case in parser.ts");
  } finally { cleanup(teamDir, store); }
});

Deno.test("Shelving: moving the active task to todo admits the next instead", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S", "D", "open", [], [
      { title: "T1", description: "D1" }, { title: "T2", description: "D2" },
    ], "default");
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
    await post(app, "/api/tasks/s1-1/move", { status: "todo" });
    assertEquals(store.getTask("s1-1")?.status, "todo");
    assertEquals(store.getTask("s1-2")?.status, "in_progress");
  } finally { cleanup(teamDir, store); }
});

Deno.test("move rejects a state not in the workflow", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    assertEquals((await post(app, "/api/tasks/s1-1/move", { status: "nonsense" })).status, 400);
  } finally { cleanup(teamDir, store); }
});

// --- Comments ---

Deno.test("POST/GET /api/agents/comments/:workItemId roundtrip", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const wid = workItemFor(store, "s1-1");
    await post(app, `/api/agents/comments/${wid}`, { agentId: "a1", body: "Status update: halfway done" });
    const body = await (await app.request(`/api/agents/comments/${wid}`)).json();
    assertEquals(body.comments.length, 1);
    assertEquals(body.comments[0].body, "Status update: halfway done");
  } finally { cleanup(teamDir, store); }
});

// --- List / Delete ---

Deno.test("GET /api/agents lists all registered agents", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    store.registerMember("a2", "trinity", "/home");
    const body = await (await app.request("/api/agents")).json();
    assertEquals(body.agents.length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("DELETE /api/agents/:id removes an agent", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp");
    assertEquals((await app.request("/api/agents/a1", { method: "DELETE" })).status, 200);
    assertEquals(store.getMembers().length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("DELETE /api/agents/:id returns 404 for unknown", async () => {
  const { app, store, teamDir } = setup();
  try {
    assertEquals((await app.request("/api/agents/nope", { method: "DELETE" })).status, 404);
  } finally { cleanup(teamDir, store); }
});

// --- Directory-affinity matching ---

Deno.test("next-work biases to the agent's directory; unhomed work is anyone's", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("sa", "A", "D", "open", [], [{ title: "TA", description: "d" }], "default", undefined, false, "/repo/a");
    store.createStory("sc", "C", "D", "open", [], [{ title: "TC", description: "d" }], "default");

    // Agent in /repo/a gets its own repo's work (tier 1).
    const forA = await (await app.request("/api/agents/next-work?agentId=ag-a&")).json();
    // ag-a isn't registered → treat as no directory; register it properly:
    store.registerMember("ag-a", "a", "/repo/a");
    const forA2 = await (await app.request("/api/agents/next-work?agentId=ag-a")).json();
    assertEquals(store.getWorkItem(forA2.workItem.id)!.ref.kind === "task", true);
    assertEquals((store.getWorkItem(forA2.workItem.id)!.ref as { storyId: string }).storyId, "sa");
    void forA;
  } finally { cleanup(teamDir, store); }
});

Deno.test("next-work: a directory-tagged item waits for an online agent with that dir", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("sb", "B", "D", "open", [], [{ title: "TB", description: "d" }], "default", undefined, false, "/repo/b");
    store.registerMember("ag-b", "b", "/repo/b");   // online, matching dir
    store.registerMember("ag-x", "x", "/repo/x");   // wrong dir

    // ag-x must not grab B's work (reserved for the present /repo/b agent).
    assertEquals((await (await app.request("/api/agents/next-work?agentId=ag-x")).json()).workItem, null);
    // ag-b gets it.
    const forB = await (await app.request("/api/agents/next-work?agentId=ag-b")).json();
    assertEquals(store.getWorkItem(forB.workItem.id) !== null, true);
  } finally { cleanup(teamDir, store); }
});
