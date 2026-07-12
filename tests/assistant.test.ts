/**
 * tests/assistant.test.ts — Verifies the assistant chat conversation.
 *
 * The assistant is a conversation of user/assistant messages. Sending a user
 * message creates a pending assistant turn; the assistant agent polls it via
 * /api/assistant/next, claims it, and completes it with a reply.
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-asst-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

function post(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

Deno.test("POST /api/assistant/messages creates a user message + pending assistant turn", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/assistant/messages", { content: "Hi there" });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.userMessage.role, "user");
    assertEquals(body.userMessage.content, "Hi there");
    assertEquals(body.assistantMessage.role, "assistant");
    assertEquals(body.assistantMessage.status, "pending");

    const msgs = store.getAssistantMessages();
    assertEquals(msgs.length, 2);
    assertEquals(msgs[0]!.role, "user");   // ordered oldest-first
    assertEquals(msgs[1]!.role, "assistant");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST requires content", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/assistant/messages", {});
    assertEquals(res.status, 400);
  } finally { cleanup(teamDir, store); }
});

Deno.test("full turn: send → next → claim → complete", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "What is 2+2?" });

    // Agent polls the pending turn; prompt is the latest user message.
    let res = await app.request("/api/assistant/next");
    const { item } = await res.json();
    assertEquals(item.prompt, "What is 2+2?");

    // Claim → processing (typing indicator in the UI).
    res = await post(app, `/api/assistant/messages/${item.id}/claim`, {});
    assertEquals((await res.json()).success, true);
    assertEquals(store.getAssistantMessage(item.id)?.status, "processing");

    // No more pending turns while processing.
    res = await app.request("/api/assistant/next");
    assertEquals((await res.json()).item, null);

    // Complete → the assistant bubble fills in.
    res = await post(app, `/api/assistant/messages/${item.id}/complete`, { result: "4" });
    assertEquals((await res.json()).success, true);

    res = await app.request("/api/assistant/messages");
    const { messages } = await res.json();
    assertEquals(messages.length, 2);
    assertEquals(messages[1].role, "assistant");
    assertEquals(messages[1].status, "done");
    assertEquals(messages[1].content, "4");
  } finally { cleanup(teamDir, store); }
});

Deno.test("claim rejects a non-pending turn; complete rejects a non-processing turn", async () => {
  const { app, store, teamDir } = setup();
  try {
    const send = await (await post(app, "/api/assistant/messages", { content: "hey" })).json();
    const id = send.assistantMessage.id;
    // Complete before claim → 400
    let res = await post(app, `/api/assistant/messages/${id}/complete`, { result: "x" });
    assertEquals(res.status, 400);
    // Claim, then double-claim → 409
    await post(app, `/api/assistant/messages/${id}/claim`, {});
    res = await post(app, `/api/assistant/messages/${id}/claim`, {});
    assertEquals(res.status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("failed completion marks the turn failed", async () => {
  const { app, store, teamDir } = setup();
  try {
    const send = await (await post(app, "/api/assistant/messages", { content: "boom" })).json();
    const id = send.assistantMessage.id;
    await post(app, `/api/assistant/messages/${id}/claim`, {});
    await post(app, `/api/assistant/messages/${id}/complete`, { result: "nope", status: "failed" });
    assertEquals(store.getAssistantMessage(id)?.status, "failed");
  } finally { cleanup(teamDir, store); }
});

Deno.test("DELETE a message and clear the conversation", async () => {
  const { app, store, teamDir } = setup();
  try {
    const send = await (await post(app, "/api/assistant/messages", { content: "one" })).json();
    // Delete the user message
    let res = await app.request(`/api/assistant/messages/${send.userMessage.id}`, { method: "DELETE" });
    assertEquals(res.status, 200);
    assertEquals(store.getAssistantMessages().length, 1);

    // Clear everything
    res = await app.request("/api/assistant/messages", { method: "DELETE" });
    assertEquals(res.status, 200);
    assertEquals(store.getAssistantMessages().length, 0);

    // Delete unknown → 404
    res = await app.request("/api/assistant/messages/nope", { method: "DELETE" });
    assertEquals(res.status, 404);
  } finally { cleanup(teamDir, store); }
});

Deno.test("clearing the conversation asks an online assistant to reset its session", async () => {
  const { app, store, teamDir } = setup();
  try {
    // An assistant agent registered on a host.
    await post(app, "/api/agents/register", { id: "assistant", name: "assistant", hostId: "h1", metadata: { tmuxWindow: "asst" } });
    await post(app, "/api/assistant/messages", { content: "hi" });

    // Clearing enqueues a reset-session intent for the assistant.
    await app.request("/api/assistant/messages", { method: "DELETE" });

    const res = await app.request("/api/hosts/h1/leader/directives");
    const { directives } = await res.json();
    assertEquals(directives.length, 1);
    assertEquals(directives[0].memberId, "assistant");
    assertEquals(directives[0].action, "reset-session");
    void store;
  } finally { cleanup(teamDir, store); }
});
