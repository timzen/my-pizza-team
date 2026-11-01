/**
 * tests/pairing.test.ts — Pairing with a teammate from the web UI
 * (docs/DESIGN.md "Watching and Pairing with a Teammate"): pair → message → release, the draining agent poll,
 * and the route guards (teammates only; messages only while paired).
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, jsonInit } from "./_team.ts";
import { TeammatePairing } from "../daemon/store/pairing.ts";

test("pairing: pair → send → poll drains messages exactly once", () => {
  const p = new TeammatePairing(() => 1000);
  assertEquals(p.send("t1", "hi", "queue"), null); // not paired
  p.pair("t1");
  p.send("t1", "hi", "queue");
  p.send("t1", "stop that", "steer");
  const first = p.poll("t1");
  assertEquals(first.paired, true);
  assertEquals(first.messages.map((m) => [m.text, m.mode]), [["hi", "queue"], ["stop that", "steer"]]);
  assertEquals(p.poll("t1").messages.length, 0);
});

test("pairing: release is handed over once, ends the pairing, drops unsent messages", () => {
  const p = new TeammatePairing();
  p.pair("t1");
  p.send("t1", "never delivered", "queue");
  p.release("t1", "complete");
  assertEquals(p.getState("t1"), { paired: false, since: null, pendingRelease: "complete" });
  const polled = p.poll("t1");
  assertEquals(polled.release, "complete");
  assertEquals(polled.messages.length, 0);
  assertEquals(p.poll("t1").release, null);
});

test("pairing: a release works even if the pairing was never seen (daemon restart)", () => {
  const p = new TeammatePairing();
  p.release("t1", "resume");
  assertEquals(p.poll("t1").release, "resume");
});

test("pairing: re-pairing supersedes an unconsumed release", () => {
  const p = new TeammatePairing();
  p.pair("t1");
  p.release("t1", "fail");
  p.pair("t1");
  const polled = p.poll("t1");
  assertEquals(polled.paired, true);
  assertEquals(polled.release, null);
});

// ─── Routes ─────────────────────────────────────────────────────────

test("routes: pair / message / release round-trip through the agent poll", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app }) => {
    await app.request("/api/agents/register", jsonInit("POST", { id: "t1", name: "swift-ripley" }));

    assertEquals((await app.request("/api/agents/t1/messages", jsonInit("POST", { text: "hi" }))).status, 409);
    assertEquals((await app.request("/api/agents/t1/pair", { method: "POST" })).status, 200);
    assertEquals((await (await app.request("/api/agents/t1/pairing/state")).json()).paired, true);

    assertEquals((await app.request("/api/agents/t1/messages", jsonInit("POST", { text: "  " }))).status, 400);
    assertEquals((await app.request("/api/agents/t1/messages", jsonInit("POST", { text: "look at auth.ts", mode: "steer" }))).status, 201);

    const polled = await (await app.request("/api/agents/t1/pairing")).json();
    assertEquals(polled.paired, true);
    assertEquals(polled.messages[0].text, "look at auth.ts");
    assertEquals(polled.messages[0].mode, "steer");

    assertEquals((await app.request("/api/agents/t1/release", jsonInit("POST", { action: "bogus" }))).status, 400);
    assertEquals((await app.request("/api/agents/t1/release", jsonInit("POST", { action: "complete" }))).status, 200);
    const after = await (await app.request("/api/agents/t1/pairing")).json();
    assertEquals(after.paired, false);
    assertEquals(after.release, "complete");
  });
});

test("routes: only connected teammates can be paired", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app }) => {
    assertEquals((await app.request("/api/agents/ghost/pair", { method: "POST" })).status, 404);
    await app.request("/api/agents/register", jsonInit("POST", { id: "leader", name: "leader" }));
    assertEquals((await app.request("/api/agents/leader/pair", { method: "POST" })).status, 400);
  });
});

test("routes: the leader's composer (assistant terminal mode) feeds the assistant inbox, no pairing", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app }) => {
    // Before the leader connects, a message queues — like the chat composer.
    assertEquals((await app.request("/api/agents/leader/messages", jsonInit("POST", { text: "early" }))).status, 201);
    await app.request("/api/agents/register", jsonInit("POST", { id: "leader", name: "leader" }));
    // No Pair step: the leader has no work loop to pause.
    const steer = await app.request("/api/agents/leader/messages", jsonInit("POST", { text: "look at auth.ts", mode: "steer" }));
    assertEquals(steer.status, 201);
    assertEquals((await steer.json()).message.origin, "web");
    assertEquals((await app.request("/api/agents/leader/messages", jsonInit("POST", { text: "  " }))).status, 400);
    // A chat-composer message carries no mode (the leader steers it, as before).
    await app.request("/api/assistant/messages", jsonInit("POST", { content: "from the chat" }));

    const inbox = await (await app.request("/api/assistant/inbox?agentId=leader")).json();
    assertEquals(
      inbox.messages.map((m: { content: string; mode: unknown }) => [m.content, m.mode]),
      [["early", "queue"], ["look at auth.ts", "steer"], ["from the chat", null]],
    );
    // Nothing went to the pairing channel, and pair/release stay teammate-only.
    assertEquals((await (await app.request("/api/agents/leader/pairing")).json()).messages.length, 0);
    assertEquals((await app.request("/api/agents/leader/pair", { method: "POST" })).status, 400);
    assertEquals((await app.request("/api/agents/leader/release", jsonInit("POST", { action: "resume" }))).status, 400);
    // Teammates still need a pairing first.
    await app.request("/api/agents/register", jsonInit("POST", { id: "t1", name: "swift-ripley" }));
    assertEquals((await app.request("/api/agents/t1/messages", jsonInit("POST", { text: "hi" }))).status, 409);
  });
});
