/**
 * tests/agents.test.ts — Verifies /api/agents/* endpoints.
 *
 * Tests the multi-transition agent lifecycle:
 * - Agents poll for unclaimed tasks with teammate-allowed transitions
 * - Claim assigns ownership without changing state
 * - Transition advances state (auto-releases on done)
 * - Release lets agents park tasks when blocked by lead-only transitions
 * - Comments are task-level, loaded at work start
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig, type WorkflowConfig } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-agents-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const store = new Store(teamDir, config);
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

// --- Registration ---

Deno.test("POST /api/agents/register creates an agent", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/agents/register", { id: "agent-1", name: "swift-neo", cwd: "/tmp" });
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
    store.registerMember("a1", "neo", "/tmp", "a1");
    const res = await post(app, "/api/agents/heartbeat", { id: "a1", status: "working" });
    assertEquals(res.status, 200);
    const member = store.getMember("a1");
    assertEquals(member?.status, "working");
  } finally { cleanup(teamDir, store); }
});

// --- Next Work ---

Deno.test("GET /api/agents/next-work returns unclaimed task with teammate transitions", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    const res = await app.request("/api/agents/next-work?agentId=a1");
    const body = await res.json();
    assertEquals(body.task?.id, "s1-1");
    assertEquals(body.task?.storyId, "s1");
    assertEquals(body.task?.status, "todo");
    // Should include available transitions
    assertEquals(Array.isArray(body.task?.availableTransitions), true);
    assertEquals(body.task.availableTransitions.length > 0, true);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/agents/next-work returns null when paused", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
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
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    // Claim the task
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    // Another agent should see no work
    store.registerMember("a2", "trinity", "/tmp", "a2");
    const res = await app.request("/api/agents/next-work?agentId=a2");
    const body = await res.json();
    assertEquals(body.task, null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/agents/next-work includes comments from lead", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    // Lead adds a comment
    store.addComment("s1-1", "lead", "Please check the edge cases");
    const res = await app.request("/api/agents/next-work?agentId=a1");
    const body = await res.json();
    assertEquals(body.task?.comments?.length, 1);
    assertEquals(body.task.comments[0].from, "lead");
    assertEquals(body.task.comments[0].body, "Please check the edge cases");
  } finally { cleanup(teamDir, store); }
});

// --- Claim ---

Deno.test("POST /api/agents/claim/:taskId assigns and transitions to working state", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    const res = await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    // Task should transition to first teammate state (in_progress)
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
    assertEquals(body.task.status, "in_progress");
    // Agent should be marked as working
    assertEquals(store.getMember("a1")?.status, "working");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/claim/:taskId rejects double claim", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.registerMember("a2", "trinity", "/tmp", "a2");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const res = await post(app, "/api/agents/claim/s1-1", { agentId: "a2" });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.success, false);
  } finally { cleanup(teamDir, store); }
});

// --- Release ---

Deno.test("POST /api/agents/release/:taskId advances state and releases", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    // Task is now in_progress. Release should advance to next state (needs_input or review)
    const res = await post(app, "/api/agents/release/s1-1", { agentId: "a1", result: "Done working" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(store.getAssignment("s1-1"), null);
    assertEquals(store.getMember("a1")?.status, "idle");
    assertEquals(store.getTask("s1-1")?.result, "Done working");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/release/:taskId completes task when reaching done state", async () => {
  const customWorkflow: WorkflowConfig = {
    states: ["todo", "in_progress", "done"],
    transitions: {
      todo: { in_progress: "any" },
      in_progress: { done: "teammate" },
    },
  };
  const { app, store, teamDir } = setup({
    workflows: { default: customWorkflow },
  });
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    // Task is now in_progress. Release should advance to done.
    const res = await post(app, "/api/agents/release/s1-1", { agentId: "a1", result: "All done" });
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.completed, true);
    assertEquals(body.newStatus, "done");
    assertEquals(store.getTask("s1-1")?.status, "done");
    assertEquals(store.getAssignment("s1-1"), null);
    assertEquals(store.getMember("a1")?.status, "idle");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/release/:taskId rejects if not owned", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], undefined, "default");
    const res = await post(app, "/api/agents/release/s1-1", { agentId: "a1" });
    assertEquals(res.status, 403);
  } finally { cleanup(teamDir, store); }
});

// --- Full lifecycle ---

Deno.test("Full lifecycle: claim → release → lead moves → claim again", async () => {
  // Workflow: todo→coding(any) → testing(teammate) → review(lead) → done(lead)
  const customWorkflow: WorkflowConfig = {
    states: ["todo", "coding", "testing", "review", "done"],
    transitions: {
      todo: { coding: "any" },
      coding: { testing: "teammate" },
      testing: { review: "teammate" },
      review: { done: "lead", coding: "lead" },
    },
  };
  const { app, store, teamDir } = setup({
    workflows: { default: customWorkflow },
  });
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "Story", "Desc", "open", [], [{ title: "Task1", description: "Do it" }], undefined, "default");

    // 1. Agent polls and finds work
    let res = await app.request("/api/agents/next-work?agentId=a1");
    let body = await res.json();
    assertEquals(body.task?.id, "s1-1");
    assertEquals(body.task?.status, "todo");

    // 2. Agent claims — transitions todo→coding
    res = await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.task.status, "coding");
    assertEquals(store.getTask("s1-1")?.status, "coding");

    // 3. Agent releases — transitions coding→testing
    res = await post(app, "/api/agents/release/s1-1", { agentId: "a1", result: "Code written" });
    body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.newStatus, "testing");
    assertEquals(body.completed, false);
    assertEquals(store.getMember("a1")?.status, "idle");

    // 4. Agent polls again — finds task in testing (has teammate transition)
    res = await app.request("/api/agents/next-work?agentId=a1");
    body = await res.json();
    assertEquals(body.task?.id, "s1-1");
    assertEquals(body.task?.status, "testing");

    // 5. Agent claims — transitions testing→review
    res = await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.task.status, "review");

    // 6. Agent releases — only lead transitions from review, moves to first available
    res = await post(app, "/api/agents/release/s1-1", { agentId: "a1", result: "Tests passing" });
    body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.newStatus, "done"); // first transition from review
    assertEquals(store.getMember("a1")?.status, "idle");

  } finally { cleanup(teamDir, store); }
});

Deno.test("Rework flow: lead sends task back, agent re-claims with comments", async () => {
  const customWorkflow: WorkflowConfig = {
    states: ["todo", "coding", "review", "done"],
    transitions: {
      todo: { coding: "any" },
      coding: { review: "teammate" },
      review: { done: "lead", coding: "lead" },
    },
  };
  const { app, store, teamDir } = setup({
    workflows: { default: customWorkflow },
  });
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "Story", "Desc", "open", [], [{ title: "Task1", description: "Do it" }], undefined, "default");

    // Agent claims (todo→coding) and releases (coding→review)
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    await post(app, "/api/agents/release/s1-1", { agentId: "a1", result: "First attempt" });
    assertEquals(store.getTask("s1-1")?.status, "review");

    // Lead reviews, adds comment, sends back to coding
    store.addComment("s1-1", "lead", "Please fix the edge case in parser.ts");
    await post(app, "/api/tasks/s1-1/move", { status: "coding" });
    assertEquals(store.getTask("s1-1")?.status, "coding");

    // Agent polls — finds task in coding with comments
    const res = await app.request("/api/agents/next-work?agentId=a1");
    const body = await res.json();
    assertEquals(body.task?.id, "s1-1");
    assertEquals(body.task?.status, "coding");
    assertEquals(body.task?.comments?.length, 1);
    assertEquals(body.task?.comments[0].body, "Please fix the edge case in parser.ts");

    // Agent claims again (coding→review)
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    assertEquals(store.getTask("s1-1")?.status, "review");
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
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.registerMember("a2", "trinity", "/home", "a2");
    const res = await app.request("/api/agents");
    const body = await res.json();
    assertEquals(body.agents.length, 2);
    assertEquals(body.agents[0].name, "neo");
  } finally { cleanup(teamDir, store); }
});

Deno.test("DELETE /api/agents/:id removes an agent", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    const res = await app.request("/api/agents/a1", { method: "DELETE" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
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
