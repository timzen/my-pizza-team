/**
 * tests/spawn-requests.test.ts — Tests for the spawn request queue endpoints.
 *
 * Verifies POST /api/spawn-requests, GET /api/spawn-requests?hostId=X,
 * and POST /api/spawn-requests/:id/ack.
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";

function setup(): { app: ReturnType<typeof buildApp>; store: Store; teamDir: string } {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-spawn-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, DEFAULT_CONFIG);
  const app = buildApp(store, DEFAULT_CONFIG, teamDir);
  return { app, store, teamDir };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
}

Deno.test("POST /api/spawn-requests creates a pending request", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/spawn-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "leader-1", cwd: "/tmp/project", reason: "need help" }),
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.request.hostId, "leader-1");
    assertEquals(body.request.cwd, "/tmp/project");
    assertEquals(body.request.reason, "need help");
    assertEquals(body.request.status, "pending");
    assertEquals(typeof body.request.id, "string");
    assertEquals(typeof body.request.createdAt, "string");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/spawn-requests requires hostId", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/spawn-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/project" }),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.success, false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/spawn-requests returns pending requests for hostId", async () => {
  const { app, store, teamDir } = setup();
  try {
    // Create two requests for the same host
    await app.request("/api/spawn-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "leader-1", reason: "first" }),
    });
    await app.request("/api/spawn-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "leader-1", reason: "second" }),
    });
    // Create one for a different host
    await app.request("/api/spawn-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "leader-2", reason: "other" }),
    });

    const res = await app.request("/api/spawn-requests?hostId=leader-1");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.requests.length, 2);
    assertEquals(body.requests[0].reason, "first");
    assertEquals(body.requests[1].reason, "second");
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/spawn-requests without hostId returns empty", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/spawn-requests");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.requests, []);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/spawn-requests/:id/ack acknowledges a request", async () => {
  const { app, store, teamDir } = setup();
  try {
    // Create a request
    const createRes = await app.request("/api/spawn-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "leader-1", reason: "spawn me" }),
    });
    const { request } = await createRes.json();

    // Ack it
    const ackRes = await app.request(`/api/spawn-requests/${request.id}/ack`, { method: "POST" });
    assertEquals(ackRes.status, 200);
    const ackBody = await ackRes.json();
    assertEquals(ackBody.success, true);

    // Should no longer appear in pending list
    const listRes = await app.request("/api/spawn-requests?hostId=leader-1");
    const listBody = await listRes.json();
    assertEquals(listBody.requests.length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/spawn-requests/:id/ack fails for non-existent request", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/spawn-requests/nonexistent/ack", { method: "POST" });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.success, false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/spawn-requests/:id/ack fails if already acked", async () => {
  const { app, store, teamDir } = setup();
  try {
    const createRes = await app.request("/api/spawn-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "leader-1" }),
    });
    const { request } = await createRes.json();

    // Ack once
    await app.request(`/api/spawn-requests/${request.id}/ack`, { method: "POST" });

    // Ack again should fail
    const res = await app.request(`/api/spawn-requests/${request.id}/ack`, { method: "POST" });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.success, false);
  } finally { cleanup(teamDir, store); }
});
