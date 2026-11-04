/**
 * tests/leader-directives.test.ts — Tests for the leader directive queue.
 *
 * A directive is an ask: "do X about an agent" (spawn, dismiss, reset-session).
 * `spawn` and `dismiss` are the daemon's alone (daemon/spawner.ts), so GET never
 * hands them to a leader; a spawn the daemon can't realize fails on creation.
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

    const list = await (await app.request("/api/spawn-requests")).json();
    assertEquals(list.requests.length, 2);
  });
});

test("POST requires an action", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await post(app, "/api/leader/directives", { params: {} });
    assertEquals(res.status, 400);
  });
});

test("GET returns every pending leader directive, oldest first — never a spawn or dismiss", async () => {
  // This used to assert per-host isolation (directives for leader-1 excluded
  // leader-2's). With one leader there is nothing to isolate, so what's left to
  // guarantee is FIFO order — the leader must realize asks in the order made.
  await withTeam({}, async ({ app }) => {
    for (const id of ["a1", "a2", "a3"]) await post(app, "/api/agents/register", { id, name: id, metadata: {} });
    await post(app, "/api/leader/directives", { action: "reset-session", memberId: "a1" });
    await post(app, "/api/leader/directives", { action: "spawn", params: { reason: "daemon's" } });
    await post(app, "/api/leader/directives", { action: "dismiss", params: { name: "a2" } });
    await post(app, "/api/leader/directives", { action: "reset-session", memberId: "a2" });
    await post(app, "/api/leader/directives", { action: "reset-session", memberId: "a3" });

    const res = await app.request("/api/leader/directives");
    const body = await res.json();
    assertEquals(body.directives.map((d: { memberId: string }) => d.memberId), ["a1", "a2", "a3"]);
  });
});

test("a spawn the daemon can't realize fails on creation, with the reason and fix", async () => {
  // There is no leader fallback, so leaving it pending would be a silent no-op.
  await withTeam({}, async ({ app, store }) => {
    store.setTmuxCapability({ canSpawn: false, reason: "tmux is not on this process's PATH", fix: "install tmux" });
    const res = await post(app, "/api/leader/directives", { action: "spawn", params: { name: "spock" } });
    assertEquals(res.status, 201);
    assertEquals((await res.json()).directive.status, "failed");

    const body = await (await app.request("/api/spawn-requests")).json();
    assertEquals(body.requests, []);
    assertEquals(body.failed.length, 1);
    assertEquals(body.failed[0].name, "spock");
    assertEquals(body.failed[0].error, "tmux is not on this process's PATH — fix: install tmux");
  });
});

test("an unconfigured harness fails its spawn on creation too; the default harness is unaffected", async () => {
  await withTeam({ experimental: { harnesses: true } }, async ({ app }) => {
    const bad = await (await post(app, "/api/leader/directives", { action: "spawn", params: { harness: "acme" } })).json();
    assertEquals(bad.directive.status, "failed");
    const ok = await (await post(app, "/api/leader/directives", { action: "spawn" })).json();
    assertEquals(ok.directive.status, "pending");
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

    const list = await (await app.request("/api/spawn-requests")).json();
    assertEquals(list.requests.length, 0);

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
  await withTeam({}, async ({ app, store }) => {
    const created = await (await post(app, "/api/leader/directives", { action: "spawn", params: { name: "spock" } })).json();
    const id = created.directive.id;

    const del = await app.request(`/api/spawn-requests/${id}`, { method: "DELETE" });
    assertEquals(del.status, 200);

    // No longer pending: gone from both the host queue and the spawn list.
    const list = await (await app.request("/api/spawn-requests")).json();
    assertEquals(list.requests.length, 0);
    assertEquals(store.getLeaderDirectives().length, 0);

    // Cancelling an unknown request → 404.
    const missing = await app.request("/api/spawn-requests/nope", { method: "DELETE" });
    assertEquals(missing.status, 404);
  });
});
