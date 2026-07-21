/**
 * tests/agents.test.ts — Verifies /api/agents/* endpoints.
 *
 * Tests the work-model lifecycle (docs/WORK-MODEL.md):
 * - Admission (CONWIP) pulls one task per story from todo into the first state
 * - Agents poll for ready agent-state tasks, claim (lease), and mark done
 * - The daemon advances completed work mechanically; workers never move tasks
 * - Return puts a claimed task back to ready (+ comment)
 * - Judgment moves (humans/leader) can put a task anywhere; rework resets substatus
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
  // Materialize any test-provided workflows onto disk (the real mechanism).
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

// The default workflow: in_progress (agent) → review (manual), between the
// implicit todo/done buckets.

// --- Registration ---

Deno.test("POST /api/agents/register creates an agent", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/agents/register", { id: "agent-1", name: "swift-neo", capabilities: {} });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.config.defaultWorkflow, "default");
    assertEquals(store.getMembers().length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/register rejects missing fields", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/agents/register", { id: "a1" });
    assertEquals(res.status, 400);
  } finally { cleanup(teamDir, store); }
});

// --- Heartbeat ---

Deno.test("POST /api/agents/heartbeat updates status", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    const res = await post(app, "/api/agents/heartbeat", { id: "a1", status: "working" });
    assertEquals(res.status, 200);
    const member = store.getMember("a1");
    assertEquals(member?.status, "working");
  } finally { cleanup(teamDir, store); }
});

// --- Admission (CONWIP) ---

Deno.test("createStory admits the first task into the first active state; the rest wait in todo", async () => {
  const { store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [
      { title: "T1", description: "D1" },
      { title: "T2", description: "D2" },
    ], undefined, "default");
    const t1 = store.getTask("s1-1")!;
    const t2 = store.getTask("s1-2")!;
    assertEquals(t1.status, "in_progress");
    assertEquals(t1.substatus, "ready");
    assertEquals(t2.status, "todo");
    assertEquals(t2.substatus, null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("paused stories admit nothing until unpaused", async () => {
  const { store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default", undefined, true);
    assertEquals(store.getTask("s1-1")?.status, "todo");
    store.updateStoryDetails("s1", { paused: false });
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
    assertEquals(store.getTask("s1-1")?.substatus, "ready");
  } finally { cleanup(teamDir, store); }
});

// --- Next Work ---

Deno.test("GET /api/agents/next-work returns the ready agent-state task", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    const res = await app.request("/api/agents/next-work?agentId=a1");
    const body = await res.json();
    assertEquals(body.task?.id, "s1-1");
    assertEquals(body.task?.storyId, "s1");
    assertEquals(body.task?.title, "T1");
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/agents/next-work returns null when paused", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/control/pause", {});
    const res = await app.request("/api/agents/next-work?agentId=a1");
    const body = await res.json();
    assertEquals(body.task, null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/agents/next-work returns null when task is claimed", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    store.registerMember("a2", "trinity", {}, {});
    const res = await app.request("/api/agents/next-work?agentId=a2");
    const body = await res.json();
    assertEquals(body.task, null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("next-work never offers a task in a manual state", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    // Drive the task to the manual review state.
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    await post(app, "/api/agents/done/s1-1", { agentId: "a1", result: "did it" });
    assertEquals(store.getTask("s1-1")?.status, "review");
    // It sits with the human; no agent work available.
    const res = await app.request("/api/agents/next-work?agentId=a1");
    assertEquals((await res.json()).task, null);
  } finally { cleanup(teamDir, store); }
});

// --- Claim ---

Deno.test("POST /api/agents/claim/:taskId leases the task (no state change)", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    const res = await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    // Claim never moves the task — it flips substatus to claimed.
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
    assertEquals(store.getTask("s1-1")?.substatus, "claimed");
    assertEquals(body.task.status, "in_progress");
    assertEquals(store.getMember("a1")?.status, "working");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/claim/:taskId rejects double claim", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.registerMember("a2", "trinity", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const res = await post(app, "/api/agents/claim/s1-1", { agentId: "a2" });
    assertEquals(res.status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/claim rejects a task waiting in todo", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [
      { title: "T1", description: "D1" },
      { title: "T2", description: "D2" },
    ], undefined, "default");
    const res = await post(app, "/api/agents/claim/s1-2", { agentId: "a1" });
    assertEquals(res.status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("claim prompt includes state role, lead comments, and completion guidance", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    store.addComment("s1-1", "lead", "Please check the edge cases");
    const res = await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const body = await res.json();
    assertStringIncludes(body.prompt, "Your Role: in_progress");
    assertStringIncludes(body.prompt, "Comments from Team Lead");
    assertStringIncludes(body.prompt, "Please check the edge cases");
    assertStringIncludes(body.prompt, "the task advances automatically");
  } finally { cleanup(teamDir, store); }
});

Deno.test("claim prompt includes the story's working directory instruction", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default", undefined, undefined, "/tmp/proj");
    const res = await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const body = await res.json();
    assertStringIncludes(body.prompt, "Working Directory");
    assertStringIncludes(body.prompt, "/tmp/proj");
    assertStringIncludes(body.prompt, "AGENTS.md");
  } finally { cleanup(teamDir, store); }
});

// --- Done (mechanical advance) ---

Deno.test("POST /api/agents/done/:taskId advances to the next state and clears the lease", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const res = await post(app, "/api/agents/done/s1-1", { agentId: "a1", result: "Done working" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.newStatus, "review");
    assertEquals(body.completed, false);
    const task = store.getTask("s1-1")!;
    assertEquals(task.status, "review");
    assertEquals(task.substatus, null);       // manual state: no substatus
    assertEquals(task.result, "Done working");
    assertEquals(store.getAssignment("s1-1"), null);
    assertEquals(store.getMember("a1")?.status, "idle");
  } finally { cleanup(teamDir, store); }
});

Deno.test("done in the last state completes the task and admits the next one", async () => {
  const soloAgent: WorkflowConfig = { states: [{ name: "work", type: "agent" }] };
  const { app, store, teamDir } = setup({ workflows: { default: soloAgent } });
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [
      { title: "T1", description: "D1" },
      { title: "T2", description: "D2" },
    ], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const res = await post(app, "/api/agents/done/s1-1", { agentId: "a1", result: "All done" });
    const body = await res.json();
    assertEquals(body.completed, true);
    assertEquals(body.newStatus, "done");
    assertEquals(store.getTask("s1-1")?.status, "done");
    // CONWIP token freed → T2 admitted.
    assertEquals(store.getTask("s1-2")?.status, "work");
    assertEquals(store.getTask("s1-2")?.substatus, "ready");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/done/:taskId rejects if not owned", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    const res = await post(app, "/api/agents/done/s1-1", { agentId: "a1" });
    assertEquals(res.status, 403);
  } finally { cleanup(teamDir, store); }
});

Deno.test("release stays as a deprecated alias for done", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const res = await post(app, "/api/agents/release/s1-1", { agentId: "a1", result: "via alias" });
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.newStatus, "review");
  } finally { cleanup(teamDir, store); }
});

// --- Return ---

Deno.test("POST /api/agents/return/:taskId puts the task back to ready with a comment", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const res = await post(app, "/api/agents/return/s1-1", { agentId: "a1", comment: "Need the API key" });
    assertEquals((await res.json()).success, true);
    const task = store.getTask("s1-1")!;
    assertEquals(task.status, "in_progress");   // stays in state
    assertEquals(task.substatus, "ready");      // available again
    assertEquals(store.getAssignment("s1-1"), null);
    const comments = store.getComments("s1-1");
    assertEquals(comments.some(c => c.body.includes("Need the API key")), true);
  } finally { cleanup(teamDir, store); }
});

// --- Full lifecycle + rework ---

Deno.test("Full lifecycle: admit → claim → done → human ships it → next task admitted", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "Story", "Desc", "open", [], [
      { title: "Task1", description: "Do it" },
      { title: "Task2", description: "Then this" },
    ], undefined, "default");

    // 1. Agent polls and finds the admitted task.
    let res = await app.request("/api/agents/next-work?agentId=a1");
    assertEquals((await res.json()).task?.id, "s1-1");

    // 2. Claim → work → done: advances to the manual review state.
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    await post(app, "/api/agents/done/s1-1", { agentId: "a1", result: "Code written" });
    assertEquals(store.getTask("s1-1")?.status, "review");

    // 3. CONWIP: Task2 still waits — the token is held by Task1 in review.
    assertEquals(store.getTask("s1-2")?.status, "todo");
    res = await app.request("/api/agents/next-work?agentId=a1");
    assertEquals((await res.json()).task, null);

    // 4. Human ships it (judgment move to done) → token freed → Task2 admitted.
    await post(app, "/api/tasks/s1-1/move", { status: "done" });
    assertEquals(store.getTask("s1-1")?.status, "done");
    assertEquals(store.getTask("s1-2")?.status, "in_progress");
    assertEquals(store.getTask("s1-2")?.substatus, "ready");

    res = await app.request("/api/agents/next-work?agentId=a1");
    assertEquals((await res.json()).task?.id, "s1-2");
  } finally { cleanup(teamDir, store); }
});

Deno.test("Rework flow: human sends the task back; re-entry ≡ first entry", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.createStory("s1", "Story", "Desc", "open", [], [
      { title: "Task1", description: "Do it" },
      { title: "Task2", description: "Next" },
    ], undefined, "default");

    // Work Task1 into review.
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    await post(app, "/api/agents/done/s1-1", { agentId: "a1", result: "First attempt" });
    assertEquals(store.getTask("s1-1")?.status, "review");

    // Human reviews, adds a comment, sends it back.
    store.addComment("s1-1", "lead", "Please fix the edge case in parser.ts");
    await post(app, "/api/tasks/s1-1/move", { status: "in_progress" });
    const task = store.getTask("s1-1")!;
    assertEquals(task.status, "in_progress");
    assertEquals(task.substatus, "ready");   // re-entry resets, same as first entry

    // CONWIP held: Task2 still in todo (rework doesn't free the token).
    assertEquals(store.getTask("s1-2")?.status, "todo");

    // Agent re-discovers it exactly like new work; prompt carries the feedback.
    const res = await app.request("/api/agents/next-work?agentId=a1");
    assertEquals((await res.json()).task?.id, "s1-1");
    const claimRes = await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    assertStringIncludes((await claimRes.json()).prompt, "Please fix the edge case in parser.ts");
  } finally { cleanup(teamDir, store); }
});

Deno.test("Shelving: moving the active task to todo admits the next instead", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S", "D", "open", [], [
      { title: "T1", description: "D1" },
      { title: "T2", description: "D2" },
    ], undefined, "default");
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
    // Human shelves T1 → it must not bounce back; T2 takes its place.
    await post(app, "/api/tasks/s1-1/move", { status: "todo" });
    assertEquals(store.getTask("s1-1")?.status, "todo");
    assertEquals(store.getTask("s1-2")?.status, "in_progress");
  } finally { cleanup(teamDir, store); }
});

Deno.test("move rejects a state not in the workflow", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    const res = await post(app, "/api/tasks/s1-1/move", { status: "nonsense" });
    assertEquals(res.status, 400);
  } finally { cleanup(teamDir, store); }
});

// --- Comments ---

Deno.test("POST/GET /api/agents/comments/:taskId roundtrip", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/comments/s1-1", { agentId: "a1", body: "Status update: halfway done" });
    const res = await app.request("/api/agents/comments/s1-1");
    const body = await res.json();
    assertEquals(body.comments.length, 1);
    assertEquals(body.comments[0].from, "a1");
    assertEquals(body.comments[0].body, "Status update: halfway done");
  } finally { cleanup(teamDir, store); }
});

// --- List / Delete ---

Deno.test("GET /api/agents lists all registered agents", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    store.registerMember("a2", "trinity", {}, {});
    const res = await app.request("/api/agents");
    const body = await res.json();
    assertEquals(body.agents.length, 2);
    assertEquals(body.agents[0].name, "neo");
  } finally { cleanup(teamDir, store); }
});

Deno.test("DELETE /api/agents/:id removes an agent", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", {}, {});
    const res = await app.request("/api/agents/a1", { method: "DELETE" });
    assertEquals(res.status, 200);
    assertEquals(store.getMembers().length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("DELETE /api/agents/:id returns 404 for unknown", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/agents/nope", { method: "DELETE" });
    assertEquals(res.status, 404);
  } finally { cleanup(teamDir, store); }
});

// --- Capability-based work matching (skills; directory is story data now) ---

Deno.test("next-work: skill requirement needs matching capability (presence-only)", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], { python: null }, "default");

    store.registerMember("no-py", "neo", {}, {});
    let res = await app.request("/api/agents/next-work?agentId=no-py");
    assertEquals((await res.json()).task, null);

    store.registerMember("py", "trinity", { python: "3.11" }, {});
    res = await app.request("/api/agents/next-work?agentId=py");
    assertEquals((await res.json()).task.id, "s1-1");
  } finally { cleanup(teamDir, store); }
});

Deno.test("next-work: story directory does not gate matching (agents cd to it)", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default", undefined, undefined, "/tmp/project");
    store.registerMember("anywhere", "neo", {}, {});
    const res = await app.request("/api/agents/next-work?agentId=anywhere");
    assertEquals((await res.json()).task.id, "s1-1");
  } finally { cleanup(teamDir, store); }
});

Deno.test("next-work: paused stories are never handed out", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default", undefined, true);
    store.registerMember("a1", "neo", {}, {});
    const res = await app.request("/api/agents/next-work?agentId=a1");
    assertEquals((await res.json()).task, null);

    // Un-pausing admits + makes it workable.
    store.updateStoryDetails("s1", { paused: false });
    const res2 = await app.request("/api/agents/next-work?agentId=a1");
    assertEquals((await res2.json()).task.id, "s1-1");
  } finally { cleanup(teamDir, store); }
});

// --- assigned-story work mode ---

Deno.test("assigned-story: only works its assigned story", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("mine", "Mine", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    store.createStory("other", "Other", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    store.registerMember("a1", "neo", {}, {}, undefined, "assigned-story", "mine");
    const res = await app.request("/api/agents/next-work?agentId=a1");
    assertEquals((await res.json()).task.storyId, "mine");
  } finally { cleanup(teamDir, store); }
});

Deno.test("assigned-story: archives story and dismisses agent when exhausted", async () => {
  const soloAgent: WorkflowConfig = { states: [{ name: "work", type: "agent" }] };
  const { app, store, teamDir } = setup({ workflows: { default: soloAgent } });
  try {
    store.createStory("mine", "Mine", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    store.registerMember("a1", "neo", {}, {}, undefined, "assigned-story", "mine");

    // Claim + done drives the only task to the done bucket.
    await post(app, "/api/agents/claim/mine-1", { agentId: "a1" });
    await post(app, "/api/agents/done/mine-1", { agentId: "a1", result: "done" });

    // No more work: daemon archives the story and dismisses the agent.
    const res = await app.request("/api/agents/next-work?agentId=a1");
    const body = await res.json();
    assertEquals(body.task, null);
    assertEquals(body.dismiss, true);
    assertEquals(store.getStory("mine"), null); // archived
  } finally { cleanup(teamDir, store); }
});
