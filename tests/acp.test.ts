/**
 * tests/acp.test.ts — agent/acp.ts against the fake ACP agent: the handshake,
 * sessions and modes, a turn with streamed updates, answering a permission request,
 * refusing an agent-specific request, and an agent that dies mid-turn.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { AcpConnection, permissionOutcome } from "../agent/acp.ts";

const FAKE = new URL("./fixtures/fake-acp-agent.ts", import.meta.url).pathname;
const spawnFake = () => AcpConnection.spawn([Deno.execPath(), "run", "--allow-run", FAKE], { cwd: Deno.cwd() });

Deno.test("a turn: streamed updates, a permission request we answer, usage, end_turn", async () => {
  const acp = spawnFake();
  try {
    const updates: string[] = [];
    let text = "";
    acp.onNotification((m) => {
      if (m.method !== "session/update") return;
      const u = m.params.update as { sessionUpdate: string; content?: { text?: string } };
      updates.push(u.sessionUpdate);
      if (u.sessionUpdate === "agent_message_chunk") text += u.content?.text ?? "";
    });
    let asked = 0;
    acp.onRequest((m) => {
      if (m.method !== "session/request_permission") return undefined; // → "not supported"
      asked++;
      return permissionOutcome(m.params, true);
    });

    const init = await acp.initialize();
    assertEquals(init.agentInfo?.name, "fake");
    const { sessionId } = await acp.newSession(Deno.cwd());
    await acp.setMode(sessionId, "autonomous");
    const result = await acp.prompt(sessionId, "do the thing");

    assertEquals(result.stopReason, "end_turn");
    assertEquals(result.usage?.cachedReadTokens, 300);
    assertEquals(asked, 1);
    assert(text.includes("permission=opt-allow"), text);
    assert(text.includes("mode=autonomous"), text);
    assert(text.includes("vendor=refused"), "an unknown agent request is answered 'not supported'");
    assertEquals(updates.filter((u) => u === "tool_call").length, 1);
    assert(updates.includes("usage_update"));
  } finally { acp.close(); await acp.exited; }
});

Deno.test("an agent that dies mid-turn rejects the open prompt", async () => {
  const acp = spawnFake();
  try {
    await acp.initialize();
    const { sessionId } = await acp.newSession(Deno.cwd());
    await assertRejects(() => acp.prompt(sessionId, "FAKE-EXIT"), Error, "agent exited");
    assertEquals(await acp.exited, 3);
  } finally { acp.close(); }
});

Deno.test("permissionOutcome never picks an 'always' option", () => {
  const options = [
    { optionId: "a", kind: "allow_always" }, { optionId: "b", kind: "allow_once" },
    { optionId: "c", kind: "reject_once" },
  ];
  assertEquals(permissionOutcome({ options }, true), { outcome: { outcome: "selected", optionId: "b" } });
  assertEquals(permissionOutcome({ options }, false), { outcome: { outcome: "selected", optionId: "c" } });
  assertEquals(permissionOutcome({ options: [{ optionId: "a", kind: "allow_always" }] }, true), { outcome: { outcome: "cancelled" } });
});
