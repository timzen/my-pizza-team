/**
 * tests/agents.test.ts — Verifies /api/agents/* endpoints.
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-agents-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, DEFAULT_CONFIG);
  const app = buildApp(store, DEFAULT_CONFIG, teamDir);
  return { app, store, teamDir };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

function post(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

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

Deno.test("GET /api/agents/next-work returns available task", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const res = await app.request("/api/agents/next-work?agentId=a1");
    const body = await res.json();
    assertEquals(body.task?.id, "s1-1");
    assertEquals(body.task?.storyId, "s1");
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/agents/next-work returns null when paused", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    await post(app, "/api/control/pause", {});
    const res = await app.request("/api/agents/next-work?agentId=a1");
    const body = await res.json();
    assertEquals(body.task, null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/claim/:taskId claims and transitions", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const res = await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(store.getTask("s1-1")?.status, "in_progress");
    assertEquals(store.getMember("a1")?.status, "working");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/claim/:taskId rejects double claim", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.registerMember("a2", "trinity", "/tmp", "a2");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const res = await post(app, "/api/agents/claim/s1-1", { agentId: "a2" });
    const body = await res.json();
    assertEquals(body.success, false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/complete/:taskId transitions to review", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.registerMember("a1", "neo", "/tmp", "a1");
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    await post(app, "/api/agents/claim/s1-1", { agentId: "a1" });
    const res = await post(app, "/api/agents/complete/s1-1", { agentId: "a1", result: "Done!" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(store.getTask("s1-1")?.status, "review");
    assertEquals(store.getTask("s1-1")?.result, "Done!");
    assertEquals(store.getMember("a1")?.status, "idle");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST/GET /api/agents/messages/:taskId roundtrip", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    await post(app, "/api/agents/messages/s1-1", { agentId: "a1", body: "Need help!" });
    const res = await app.request("/api/agents/messages/s1-1");
    const body = await res.json();
    assertEquals(body.messages.length, 1);
    assertEquals(body.messages[0].from, "a1");
    assertEquals(body.messages[0].body, "Need help!");
  } finally { cleanup(teamDir, store); }
});

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
