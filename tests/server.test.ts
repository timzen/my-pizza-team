/**
 * tests/server.test.ts — Verifies API routes via Hono's app.request() test helper.
 * Tests the full request/response contract without starting a real server.
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

Deno.test("GET /health returns ok", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/health");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.status, "ok");
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/status returns dashboard data", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/status");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.running, true);
    assertEquals(body.defaultWorkflow, "default");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/stories creates a story", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/stories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "s1", title: "Story 1", description: "Test", workflow: "default", tasks: [{ title: "T1", description: "D1" }] }),
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.story.id, "s1");
    assertEquals(body.story.tasks.length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/stories rejects duplicate", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", []);
    const res = await app.request("/api/stories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "s1", title: "Dup", description: "D", workflow: "default" }),
    });
    assertEquals(res.status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/stories returns all stories", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const res = await app.request("/api/stories");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.stories.length, 1);
    assertEquals(body.stories[0].tasks.length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST/GET comments roundtrip", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }]);
    await app.request("/api/tasks/s1-1/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "teammate-1", body: "Hello!" }),
    });
    const res = await app.request("/api/tasks/s1-1/comments");
    const body = await res.json();
    assertEquals(body.comments.length, 1);
    assertEquals(body.comments[0].from, "teammate-1");
  } finally { cleanup(teamDir, store); }
});
