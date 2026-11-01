/**
 * tests/session-stats.test.ts — POST /api/agents/:id/session-stats and its echo
 * in GET /api/agents: a harness reports its context-window fill and session cost
 * after every turn, the Team tab reads them back (shared/types.ts
 * MemberSessionStats). Nonsense numbers become null rather than a fake 0%, and a
 * re-registration (a fresh session) clears them.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, post } from "./_team.ts";
import { buildApp } from "../daemon/server.ts";

/** The `session` field GET /api/agents reports for one agent. */
async function sessionOf(app: ReturnType<typeof buildApp>, id: string) {
  const body = await (await app.request("/api/agents")).json();
  return body.agents.find((a: { id: string }) => a.id === id)?.session;
}

test("session stats: reported stats come back on GET /api/agents", async () => {
  await withTeam({}, async ({ app }) => {
    await post(app, "/api/agents/register", { id: "t1", name: "swift-neo", directory: "/tmp/repo" });
    assertEquals(await sessionOf(app, "t1"), null); // nothing reported yet

    const res = await post(app, "/api/agents/t1/session-stats", {
      contextTokens: 84_000, contextWindow: 200_000, contextPercent: 42, costUsd: 1.25,
      model: { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
    });
    assertEquals(res.status, 200);
    const s = await sessionOf(app, "t1");
    assertEquals([s.contextTokens, s.contextWindow, s.contextPercent, s.costUsd], [84_000, 200_000, 42, 1.25]);
    assertEquals(s.model, { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" });
    assertEquals(typeof s.at, "number");
  });
});

test("session stats: unknown numbers are null, never a fake 0%", async () => {
  await withTeam({}, async ({ app }) => {
    await post(app, "/api/agents/register", { id: "t1", name: "swift-neo" });
    // Just after compaction Pi knows the window but not the tokens.
    await post(app, "/api/agents/t1/session-stats", { contextTokens: null, contextWindow: 200_000, contextPercent: null, costUsd: 0.5 });
    let s = await sessionOf(app, "t1");
    assertEquals([s.contextTokens, s.contextWindow, s.contextPercent, s.costUsd], [null, 200_000, null, 0.5]);

    // Garbage in: negatives, strings, NaN; percent is clamped to 100; cost defaults to 0.
    await post(app, "/api/agents/t1/session-stats", { contextTokens: -1, contextWindow: "big", contextPercent: 140 });
    s = await sessionOf(app, "t1");
    assertEquals([s.contextTokens, s.contextWindow, s.contextPercent, s.costUsd], [null, null, 100, 0]);
    assertEquals(s.model, null); // no model reported

    // A model needs an id; its name falls back to the id.
    await post(app, "/api/agents/t1/session-stats", { model: { id: "local-llama" } });
    assertEquals((await sessionOf(app, "t1")).model, { id: "local-llama", name: "local-llama", provider: "" });
    await post(app, "/api/agents/t1/session-stats", { model: { name: "no id", provider: 7 } });
    assertEquals((await sessionOf(app, "t1")).model, null);
  });
});

test("session stats: an unknown agent is a 404", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await post(app, "/api/agents/ghost/session-stats", { costUsd: 1 });
    assertEquals(res.status, 404);
  });
});

test("session stats: re-registering (a fresh session) clears them", async () => {
  await withTeam({}, async ({ app }) => {
    await post(app, "/api/agents/register", { id: "t1", name: "swift-neo" });
    await post(app, "/api/agents/t1/session-stats", { contextTokens: 1000, contextWindow: 200_000, contextPercent: 0.5, costUsd: 3 });
    await post(app, "/api/agents/register", { id: "t1", name: "swift-neo" });
    assertEquals(await sessionOf(app, "t1"), null);
  });
});
