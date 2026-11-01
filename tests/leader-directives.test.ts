/**
 * tests/leader-directives.test.ts — Tests for the leader directive queue.
 *
 * A directive is an ask to the leader: "do X about an agent" (spawn, reset-session).
 * Verifies GET/POST/PUT on /api/leader/directives.
 *
 * The queue lost its host key in P1c-1: there is exactly one leader
 * (docs/DESIGN.md "One Host, One Leader"), so there is nothing to route between.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, post } from "./_team.ts";

test("POST spawn directive generates a unique agent name in params", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await post(app, "/api/leader/directives", { action: "spawn", params: { cwd: "/tmp/project" } });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.directive.action, "spawn");
    assertEquals(body.directive.params.cwd, "/tmp/project");
    assertEquals(typeof body.directive.params.name, "string"); // daemon-generated
    assertEquals(body.directive.status, "pending");
  });
});

test("every spawn is a teammate: no reserved assistant identity", async () => {
  await withTeam({}, async ({ app }) => {
    // The chat is answered by the leader (DESIGN.md "One agent to talk to"), so
    // `reason: "assistant"` no longer mints a reserved singleton name — it is
    // just an ordinary spawn, and repeats do not coalesce onto each other.
    const first = await (await post(app, "/api/leader/directives", { action: "spawn", params: { reason: "assistant" } })).json();
    const second = await (await post(app, "/api/leader/directives", { action: "spawn", params: { reason: "assistant" } })).json();
    assertEquals(first.directive.params.name === "assistant", false);
    assertEquals(second.directive.id === first.directive.id, false);
    assertEquals(second.directive.params.name === first.directive.params.name, false);

    const list = await (await app.request("/api/leader/directives")).json();
    assertEquals(list.directives.length, 2);
  });
});

test("POST requires an action", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await post(app, "/api/leader/directives", { params: {} });
    assertEquals(res.status, 400);
  });
});

test("GET returns every pending directive, oldest first", async () => {
  // This used to assert per-host isolation (directives for leader-1 excluded
  // leader-2's). With one leader there is nothing to isolate, so what's left to
  // guarantee is FIFO order — the leader must realize asks in the order made.
  await withTeam({}, async ({ app }) => {
    await post(app, "/api/leader/directives", { action: "spawn", params: { reason: "first" } });
    await post(app, "/api/leader/directives", { action: "spawn", params: { reason: "second" } });
    await post(app, "/api/leader/directives", { action: "spawn", params: { reason: "third" } });

    const res = await app.request("/api/leader/directives");
    const body = await res.json();
    assertEquals(body.directives.length, 3);
    assertEquals(body.directives.map((d: { params: { reason: string } }) => d.params.reason), ["first", "second", "third"]);
  });
});

test("reset-session directive resolves target member metadata", async () => {
  await withTeam({}, async ({ app }) => {
    // Register an agent with opaque metadata (leader's tmux window).
    await post(app, "/api/agents/register", { id: "a1", name: "neo", metadata: { tmuxWindow: "win1" } });
    // Create a reset directive targeting that member.
    const res = await post(app, "/api/leader/directives", { action: "reset-session", memberId: "a1" });
    assertEquals(res.status, 201);

    const list = await (await app.request("/api/leader/directives")).json();
    assertEquals(list.directives.length, 1);
    assertEquals(list.directives[0].action, "reset-session");
    assertEquals(list.directives[0].memberId, "a1");
    assertEquals(list.directives[0].metadata.tmuxWindow, "win1"); // resolved, opaque
  });
});

test("PUT status=done removes a directive from the pending list", async () => {
  await withTeam({}, async ({ app }) => {
    const created = await (await post(app, "/api/leader/directives", { action: "spawn" })).json();
    const id = created.directive.id;

    const put = await app.request(`/api/leader/directives/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }),
    });
    assertEquals(put.status, 200);

    const list = await (await app.request("/api/leader/directives")).json();
    assertEquals(list.directives.length, 0);

    // PUT unknown → 404
    const missing = await app.request("/api/leader/directives/nope", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }),
    });
    assertEquals(missing.status, 404);
  });
});

test("GET /api/spawn-requests lists pending spawns with name and cwd", async () => {
  await withTeam({}, async ({ app }) => {
    await post(app, "/api/leader/directives", { action: "spawn", params: { name: "cool-chekov", cwd: "/Volumes" } });
    await post(app, "/api/leader/directives", { action: "spawn", params: { name: "bold-riker", cwd: "/tmp/x" } });
    // A non-spawn directive must not appear.
    await post(app, "/api/agents/register", { id: "a1", name: "neo", metadata: {} });
    await post(app, "/api/leader/directives", { action: "reset-session", memberId: "a1" });

    const res = await app.request("/api/spawn-requests");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.requests.length, 2);
    const names = body.requests.map((r: { name: string }) => r.name).sort();
    assertEquals(names, ["bold-riker", "cool-chekov"]);
    const first = body.requests.find((r: { name: string }) => r.name === "cool-chekov");
    assertEquals(first.cwd, "/Volumes");
    assertEquals(typeof first.id, "string");
    assertEquals(typeof first.createdAt, "string");
  });
});

test("DELETE /api/spawn-requests/:id cancels a pending spawn", async () => {
  await withTeam({}, async ({ app }) => {
    const created = await (await post(app, "/api/leader/directives", { action: "spawn", params: { name: "spock" } })).json();
    const id = created.directive.id;

    const del = await app.request(`/api/spawn-requests/${id}`, { method: "DELETE" });
    assertEquals(del.status, 200);

    // No longer pending: gone from both the host queue and the spawn list.
    const list = await (await app.request("/api/spawn-requests")).json();
    assertEquals(list.requests.length, 0);
    const hostList = await (await app.request("/api/leader/directives")).json();
    assertEquals(hostList.directives.length, 0);

    // Cancelling an unknown request → 404.
    const missing = await app.request("/api/spawn-requests/nope", { method: "DELETE" });
    assertEquals(missing.status, 404);
  });
});
