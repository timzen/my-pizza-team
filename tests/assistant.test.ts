/**
 * tests/assistant.test.ts — Verifies the assistant chat conversation.
 *
 * The assistant is an append-only chat of user/assistant messages. Sending a
 * user message just appends it ('sent'). Replies are produced by a response
 * "turn": the agent polls /api/assistant/next, claims it (coalesced user
 * messages flip to 'read'), streams bubbles via .../say, then completes.
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-asst-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  // Default debounce off so turn tests aren't time-dependent; debounce tests set it.
  const config = { ...DEFAULT_CONFIG, assistantTurnDebounceSeconds: 0, ...configOverride };
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

Deno.test("POST /api/assistant/messages appends a 'sent' user message (no placeholder)", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/assistant/messages", { content: "Hi there" });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.userMessage.role, "user");
    assertEquals(body.userMessage.content, "Hi there");
    assertEquals(body.userMessage.status, "sent");
    assertEquals(body.assistantMessage, undefined); // no 1:1 placeholder anymore

    const msgs = store.getAssistantMessages();
    assertEquals(msgs.length, 1);
    assertEquals(msgs[0]!.role, "user");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST requires content", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/assistant/messages", {});
    assertEquals(res.status, 400);
  } finally { cleanup(teamDir, store); }
});

Deno.test("full turn: send → next → claim (read receipt) → say×N → complete", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "What is 2+2?" });

    // Agent polls for a response turn; prompt is the unanswered user message(s).
    let res = await app.request("/api/assistant/next");
    const { item } = await res.json();
    assertEquals(item.prompt, "What is 2+2?");

    // Claim → processing turn; the user message flips to 'read' (double check).
    res = await post(app, `/api/assistant/messages/${item.id}/claim`, {});
    assertEquals((await res.json()).success, true);
    let listed = await (await app.request("/api/assistant/messages")).json();
    assertEquals(listed.activeTurn.id, item.id);
    assertEquals(listed.messages[0].status, "read");

    // No more turns handed out while one is processing (single-flight).
    res = await app.request("/api/assistant/next");
    assertEquals((await res.json()).item, null);

    // Stream two chat bubbles into the turn.
    await post(app, `/api/assistant/messages/${item.id}/say`, { content: "Let me think…" });
    await post(app, `/api/assistant/messages/${item.id}/say`, { content: "It's 4." });

    // Complete → turn closes, composer unlocks (activeTurn null).
    res = await post(app, `/api/assistant/messages/${item.id}/complete`, { result: "ignored fallback" });
    assertEquals((await res.json()).success, true);

    listed = await (await app.request("/api/assistant/messages")).json();
    assertEquals(listed.activeTurn, null);
    // user + two assistant bubbles; fallback NOT appended because bubbles exist.
    assertEquals(listed.messages.length, 3);
    assertEquals(listed.messages[1].role, "assistant");
    assertEquals(listed.messages[1].content, "Let me think…");
    assertEquals(listed.messages[2].content, "It's 4.");
  } finally { cleanup(teamDir, store); }
});

Deno.test("complete with no bubbles appends the fallback text as one bubble", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "hello" });
    const { item } = await (await app.request("/api/assistant/next")).json();
    await post(app, `/api/assistant/messages/${item.id}/claim`, {});
    await post(app, `/api/assistant/messages/${item.id}/complete`, { result: "Hi!" });

    const { messages } = await (await app.request("/api/assistant/messages")).json();
    assertEquals(messages.length, 2);
    assertEquals(messages[1].role, "assistant");
    assertEquals(messages[1].content, "Hi!");
  } finally { cleanup(teamDir, store); }
});

Deno.test("multiple user messages coalesce into one turn", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "one" });
    await post(app, "/api/assistant/messages", { content: "two" });
    const { item } = await (await app.request("/api/assistant/next")).json();
    assertEquals(item.prompt, "one\n\ntwo");
    // Both flip to read on claim.
    await post(app, `/api/assistant/messages/${item.id}/claim`, {});
    const { messages } = await (await app.request("/api/assistant/messages")).json();
    assertEquals(messages.filter((m: { status: string }) => m.status === "read").length, 2);
  } finally { cleanup(teamDir, store); }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("pre-claim debounce: no turn until the user goes quiet", async () => {
  // 50ms window so the test stays fast but deterministic.
  const { app, store, teamDir } = setup({ assistantTurnDebounceSeconds: 0.05 });
  try {
    await post(app, "/api/assistant/messages", { content: "still typing…" });
    // Immediately: within the debounce window → held back.
    assertEquals((await (await app.request("/api/assistant/next")).json()).item, null);
    // After the quiet window elapses → offered.
    await sleep(80);
    assertEquals((await (await app.request("/api/assistant/next")).json()).item !== null, true);
  } finally { cleanup(teamDir, store); }
});

Deno.test("pre-claim debounce: a typing ping re-arms the quiet window", async () => {
  const { app, store, teamDir } = setup({ assistantTurnDebounceSeconds: 0.05 });
  try {
    await post(app, "/api/assistant/messages", { content: "msg1" });
    // User keeps typing a follow-up: the ping should push the window out even
    // though the message itself is about to age past the debounce.
    await sleep(40);
    await post(app, "/api/assistant/typing", {});
    // The message is now >50ms old, but the typing ping keeps it held.
    await sleep(20);
    assertEquals((await (await app.request("/api/assistant/next")).json()).item, null);
    // Once typing stops for the full window → offered.
    await sleep(80);
    assertEquals((await (await app.request("/api/assistant/next")).json()).item !== null, true);
  } finally { cleanup(teamDir, store); }
});

Deno.test("claim rejects a non-pending turn; say/complete reject a non-processing turn", async () => {
  const { app, store, teamDir } = setup();
  try {
    await (await post(app, "/api/assistant/messages", { content: "hey" })).json();
    const { item } = await (await app.request("/api/assistant/next")).json();
    // Complete before claim → 400
    let res = await post(app, `/api/assistant/messages/${item.id}/complete`, { result: "x" });
    assertEquals(res.status, 400);
    // Say before claim → 400
    res = await post(app, `/api/assistant/messages/${item.id}/say`, { content: "x" });
    assertEquals(res.status, 400);
    // Claim, then double-claim → 409
    await post(app, `/api/assistant/messages/${item.id}/claim`, {});
    res = await post(app, `/api/assistant/messages/${item.id}/claim`, {});
    assertEquals(res.status, 409);
  } finally { cleanup(teamDir, store); }
});

Deno.test("failed completion marks the turn failed and posts a bubble", async () => {
  const { app, store, teamDir } = setup();
  try {
    await (await post(app, "/api/assistant/messages", { content: "boom" })).json();
    const { item } = await (await app.request("/api/assistant/next")).json();
    await post(app, `/api/assistant/messages/${item.id}/claim`, {});
    await post(app, `/api/assistant/messages/${item.id}/complete`, { result: "nope", status: "failed" });
    const { messages, activeTurn } = await (await app.request("/api/assistant/messages")).json();
    assertEquals(activeTurn, null);
    assertEquals(messages[messages.length - 1].status, "failed");
  } finally { cleanup(teamDir, store); }
});

Deno.test("DELETE a message and clear the conversation", async () => {
  const { app, store, teamDir } = setup();
  try {
    const send = await (await post(app, "/api/assistant/messages", { content: "one" })).json();
    // Delete the user message (append-only chat: sending created just the one).
    let res = await app.request(`/api/assistant/messages/${send.userMessage.id}`, { method: "DELETE" });
    assertEquals(res.status, 200);
    assertEquals(store.getAssistantMessages().length, 0);

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

Deno.test("persona: defaults to none, can be set and cleared", async () => {
  const { app, store, teamDir } = setup();
  try {
    // No persona initially — the daemon supplies its default system prompt
    // (chat framing + default persona).
    let res = await app.request("/api/assistant/persona");
    let body = await res.json();
    assertEquals(body.personaId, null);
    assertEquals(body.entry, null);
    assertEquals(typeof body.systemPrompt, "string");
    assertEquals(body.systemPrompt.length > 0, true);
    // Chat framing is always present, regardless of persona.
    assertEquals(body.systemPrompt.includes("live chat"), true);
    assertEquals(body.systemPrompt.includes("send_message"), true);
    const defaultPrompt = body.systemPrompt;

    // Create a context entry to use as a persona.
    store.saveContextEntry({ title: "Pirate", description: "Talk like a pirate", tags: ["persona"], content: "Arr, ye be a pirate." });

    // Setting it returns the resolved entry; the persona body is composed behind
    // the always-present chat framing.
    res = await app.request("/api/assistant/persona", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personaId: "pirate" }) });
    body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.personaId, "pirate");
    assertEquals(body.entry.title, "Pirate");
    assertEquals(body.systemPrompt.includes("Arr, ye be a pirate."), true);
    assertEquals(body.systemPrompt.includes("send_message"), true);
    assertEquals(store.getAssistantPersonaId(), "pirate");

    // GET reflects the active persona.
    res = await app.request("/api/assistant/persona");
    body = await res.json();
    assertEquals(body.personaId, "pirate");
    assertEquals(body.systemPrompt.includes("Arr, ye be a pirate."), true);

    // Clearing (null) removes it and restores the default system prompt.
    res = await app.request("/api/assistant/persona", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personaId: null }) });
    body = await res.json();
    assertEquals(body.personaId, null);
    assertEquals(body.systemPrompt, defaultPrompt);
    assertEquals(store.getAssistantPersonaId(), null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("persona: unknown entry is rejected", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/assistant/persona", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personaId: "does-not-exist" }) });
    assertEquals(res.status, 404);
  } finally { cleanup(teamDir, store); }
});

Deno.test("persona: a deleted entry reports no active persona", async () => {
  const { app, store, teamDir } = setup();
  try {
    store.saveContextEntry({ title: "Temp Persona", tags: ["persona"], content: "x" });
    await app.request("/api/assistant/persona", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personaId: "temp-persona" }) });
    store.deleteContextEntry("temp-persona");

    const res = await app.request("/api/assistant/persona");
    const body = await res.json();
    assertEquals(body.personaId, null);
    assertEquals(body.entry, null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("persona: swapping resets an online assistant session", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/agents/register", { id: "assistant", name: "assistant", hostId: "h1", metadata: { tmuxWindow: "asst" } });
    store.saveContextEntry({ title: "Coach", tags: ["persona"], content: "Be encouraging." });

    await app.request("/api/assistant/persona", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personaId: "coach" }) });

    const res = await app.request("/api/hosts/h1/leader/directives");
    const { directives } = await res.json();
    assertEquals(directives.some((d: { action: string }) => d.action === "reset-session"), true);
  } finally { cleanup(teamDir, store); }
});
