/**
 * tests/assistant.test.ts — Verifies the assistant chat (chat v2).
 *
 * The chat mirrors the assistant's Pi session: posting a message always succeeds
 * (no turns, no composer lock), the agent pulls an inbox and acks receipts
 * (queued → delivered → read), its prose is mirrored back as bubbles, and
 * sessions are snapshotted to markdown so they can be resumed. See
 * docs/ASSISTANT_CHAT_V2.md.
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, ASSISTANT_DIR, ASSISTANT_SESSIONS_DIR, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

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

function post(app: ReturnType<typeof buildApp>, url: string, body?: unknown) {
  return app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
}

function put(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return app.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// ─── Sending ─────────────────────────────────────────────────────────

Deno.test("POST /api/assistant/messages appends a queued user message and opens a session", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await post(app, "/api/assistant/messages", { content: "Hi there" });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.userMessage.role, "user");
    assertEquals(body.userMessage.origin, "web");
    assertEquals(body.userMessage.delivery, "queued");

    // A session is created on demand and named after the first message.
    const session = store.getActiveAssistantSession();
    assertExists(session);
    assertEquals(session.status, "active");
    assertEquals(session.title, "Hi there");
    assertEquals(store.getAssistantMessages().length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST requires content", async () => {
  const { app, store, teamDir } = setup();
  try {
    assertEquals((await post(app, "/api/assistant/messages", {})).status, 400);
  } finally { cleanup(teamDir, store); }
});

Deno.test("sending never blocks: many messages queue up while the agent works", async () => {
  const { app, store, teamDir } = setup();
  try {
    // No turn, no lock: three sends in a row all land, in order.
    for (const text of ["one", "two", "three"]) {
      assertEquals((await post(app, "/api/assistant/messages", { content: text })).status, 201);
    }
    const inbox = store.getAssistantInbox();
    assertEquals(inbox.map((m) => m.content), ["one", "two", "three"]);

    // Even mid-run (agent already handed the first message) sending is accepted.
    store.ackAssistantInbox([inbox[0]!.id], "delivered");
    assertEquals((await post(app, "/api/assistant/messages", { content: "four" })).status, 201);
    assertEquals(store.getAssistantInbox().length, 3); // two, three, four
  } finally { cleanup(teamDir, store); }
});

Deno.test("replyTo quotes the original for the UI and for the agent", async () => {
  const { app, store, teamDir } = setup();
  try {
    const first = await (await post(app, "/api/assistant/messages", { content: "which stories are blocked?" })).json();
    await post(app, "/api/assistant/bubbles", { content: "auth-refresh and billing-sync." });
    const bubble = store.getAssistantMessages().find((m) => m.role === "assistant")!;

    const reply = await (await post(app, "/api/assistant/messages", { content: "nudge the reviewers", replyTo: bubble.id })).json();
    assertEquals(reply.userMessage.replyTo, bubble.id);
    assertEquals(reply.userMessage.quoted.content, "auth-refresh and billing-sync.");

    // The agent-facing inbox carries the quote so it knows what's being answered.
    const item = store.getAssistantInbox().find((m) => m.id === reply.userMessage.id)!;
    assertEquals(item.quoted, "auth-refresh and billing-sync.");
    assertExists(first.userMessage.id);
  } finally { cleanup(teamDir, store); }
});

// ─── Inbox + receipts ────────────────────────────────────────────────

Deno.test("receipts advance queued → delivered → read and never go backwards", async () => {
  const { app, store, teamDir } = setup();
  try {
    // The inbox is only served to the designated chat agent (the leader).
    await post(app, "/api/agents/register", { id: "leader", name: "leader", directory: teamDir, hostId: "h1" });
    const sent = await (await post(app, "/api/assistant/messages", { content: "status?" })).json();
    const id = sent.userMessage.id;

    const inbox = await (await app.request("/api/assistant/inbox?agentId=leader")).json();
    assertEquals(inbox.messages.length, 1);

    await post(app, "/api/assistant/inbox/ack", { ids: [id], state: "delivered" });
    assertEquals(store.getAssistantMessage(id)!.delivery, "delivered");
    // Delivered messages leave the inbox — they must not be re-sent to Pi.
    assertEquals(store.getAssistantInbox().length, 0);

    // No ids + 'read' promotes everything delivered (what agent_start sends).
    await post(app, "/api/assistant/inbox/ack", { state: "read" });
    assertEquals(store.getAssistantMessage(id)!.delivery, "read");

    // Regression: a late 'delivered' ack can't un-read a message.
    await post(app, "/api/assistant/inbox/ack", { ids: [id], state: "delivered" });
    assertEquals(store.getAssistantMessage(id)!.delivery, "read");
  } finally { cleanup(teamDir, store); }
});

Deno.test("terminal-origin messages are mirrored in as already-read", async () => {
  const { app, store, teamDir } = setup();
  try {
    // Typed in the agent's tmux pane: it is already in the agent's context, so
    // it must never be replayed to Pi via the inbox.
    const res = await post(app, "/api/assistant/messages", { content: "hey from tmux", origin: "tui" });
    const body = await res.json();
    assertEquals(body.userMessage.origin, "tui");
    assertEquals(body.userMessage.delivery, "read");
    assertEquals(store.getAssistantInbox().length, 0);
  } finally { cleanup(teamDir, store); }
});

// ─── Mirroring out ───────────────────────────────────────────────────

Deno.test("bubbles mirror the agent's reply; failures render as failed bubbles", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "hi" });
    assertEquals((await post(app, "/api/assistant/bubbles", { content: "Hey!" })).status, 201);
    await post(app, "/api/assistant/bubbles", { content: "Two stories are blocked." });
    await post(app, "/api/assistant/bubbles", { content: "boom", failed: true });

    const bubbles = store.getAssistantMessages().filter((m) => m.role === "assistant");
    assertEquals(bubbles.map((b) => b.content), ["Hey!", "Two stories are blocked.", "boom"]);
    assertEquals(bubbles.map((b) => b.state), ["ok", "ok", "failed"]);
    assertEquals(bubbles[0]!.origin, "agent");
    assertEquals((await post(app, "/api/assistant/bubbles", {})).status, 400);
  } finally { cleanup(teamDir, store); }
});

Deno.test("thoughts are ephemeral, capped, and drive the thinking indicator", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "hi" });
    await post(app, "/api/assistant/thoughts", { clear: true, thinking: true });
    await post(app, "/api/assistant/thoughts", { chunk: "let me check " });
    await post(app, "/api/assistant/thoughts", { chunk: "the board" });

    let peek = await (await app.request("/api/assistant/thoughts")).json();
    assertEquals(peek.thinking, true);
    assertEquals(peek.chunks.join(""), "let me check the board");

    // The buffer survives the run ending, so you can peek after the reply lands.
    await post(app, "/api/assistant/thoughts", { thinking: false });
    peek = await (await app.request("/api/assistant/thoughts")).json();
    assertEquals(peek.thinking, false);
    assertEquals(peek.chunks.length, 2);

    // Ring buffer: oldest chunks are dropped rather than growing without bound.
    for (let i = 0; i < 250; i++) store.appendAssistantThought(`chunk-${i}`);
    peek = await (await app.request("/api/assistant/thoughts")).json();
    assertEquals(peek.chunks.length <= 200, true);
    assertEquals(peek.chunks.at(-1), "chunk-249");

    // Reasoning is never persisted as conversation.
    assertEquals(store.getAssistantMessages().filter((m) => m.role !== "user").length, 0);
  } finally { cleanup(teamDir, store); }
});

// ─── SSE stream ──────────────────────────────────────────────────────

Deno.test("SSE stream pushes a hello frame and then new messages", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/assistant/stream");
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const hello = decoder.decode((await reader.read()).value);
    assertStringIncludes(hello, '"type":"hello"');

    await post(app, "/api/assistant/messages", { content: "streamed" });
    // Posting also opens a session, so a `session` frame may arrive first.
    let frames = "";
    while (!frames.includes('"type":"message"')) {
      frames += decoder.decode((await reader.read()).value);
    }
    assertStringIncludes(frames, "streamed");

    await reader.cancel();
  } finally { cleanup(teamDir, store); }
});

// ─── Sessions ────────────────────────────────────────────────────────

Deno.test("new chat ends + snapshots the session instead of deleting it", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "first conversation" });
    await post(app, "/api/assistant/bubbles", { content: "Reply in the first conversation." });
    const first = store.getActiveAssistantSession()!;

    const res = await post(app, "/api/assistant/sessions/new");
    assertEquals(res.status, 201);

    // The old session is ended, snapshotted, and still listed.
    const ended = store.getAssistantSession(first.id)!;
    assertEquals(ended.status, "ended");
    assertExists(ended.endedAt);
    const snapshotFile = path.join(teamDir, ASSISTANT_DIR, ASSISTANT_SESSIONS_DIR, `${first.id}.md`);
    const snapshot = Deno.readTextFileSync(snapshotFile);
    assertStringIncludes(snapshot, "first conversation");
    assertStringIncludes(snapshot, "Reply in the first conversation.");

    // The new session is empty apart from its marker, and history is intact.
    const active = store.getActiveAssistantSession()!;
    assertEquals(active.id === first.id, false);
    assertEquals(store.getAssistantMessages(active.id).map((m) => m.role), ["system"]);
    assertEquals(store.getAssistantMessages(first.id).length, 2);
    assertEquals(store.listAssistantSessions().length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET messages?sessionId= reads an earlier session; snapshot is downloadable", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "old talk" });
    const old = store.getActiveAssistantSession()!;
    await post(app, "/api/assistant/sessions/new");
    await post(app, "/api/assistant/messages", { content: "new talk" });

    const res = await app.request(`/api/assistant/messages?sessionId=${encodeURIComponent(old.id)}`);
    const body = await res.json();
    assertEquals(body.session.id, old.id);
    assertEquals(body.messages.map((m: { content: string }) => m.content), ["old talk"]);

    assertEquals((await app.request("/api/assistant/messages?sessionId=nope")).status, 404);
    const md = await (await app.request(`/api/assistant/sessions/${encodeURIComponent(old.id)}/snapshot`)).text();
    assertStringIncludes(md, "old talk");
  } finally { cleanup(teamDir, store); }
});

Deno.test("resume reopens a session and asks the agent to switch its Pi session", async () => {
  const { app, store, teamDir } = setup();
  try {
    // An online leader is needed for the directive to be routable (it is the chat agent).
    await post(app, "/api/agents/register", { id: "leader", name: "leader", directory: teamDir, hostId: "h1" });
    await post(app, "/api/assistant/messages", { content: "the first chat" });
    await post(app, "/api/assistant/session", { piSessionPath: "/tmp/pi-session-a.jsonl" });
    const first = store.getActiveAssistantSession()!;
    assertEquals(first.piSessionPath, "/tmp/pi-session-a.jsonl");

    await post(app, "/api/assistant/sessions/new");
    const res = await post(app, `/api/assistant/sessions/${encodeURIComponent(first.id)}/resume`);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.contextRestored, true);
    assertEquals(store.getActiveAssistantSession()!.id, first.id);

    // The ask is addressed to the agent itself (session APIs, not keystrokes),
    // so it must NOT be handed to the leader's queue.
    const selfDirectives = store.getMemberDirectives("leader");
    assertEquals(selfDirectives.some((d) => d.action === "resume-session"), true);
    assertEquals(selfDirectives.find((d) => d.action === "resume-session")!.params.piSessionPath, "/tmp/pi-session-a.jsonl");
    assertEquals(store.getLeaderDirectives("h1").some((d) => d.action === "resume-session"), false);

    assertEquals((await post(app, "/api/assistant/sessions/nope/resume")).status, 404);
  } finally { cleanup(teamDir, store); }
});

Deno.test("resume without a recorded Pi session reports degraded context", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/assistant/messages", { content: "no pi session recorded" });
    const first = store.getActiveAssistantSession()!;
    await post(app, "/api/assistant/sessions/new");

    const body = await (await post(app, `/api/assistant/sessions/${encodeURIComponent(first.id)}/resume`)).json();
    assertEquals(body.success, true);
    assertEquals(body.contextRestored, false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("DELETE a message removes it from the transcript", async () => {
  const { app, store, teamDir } = setup();
  try {
    const sent = await (await post(app, "/api/assistant/messages", { content: "oops" })).json();
    assertEquals((await app.request(`/api/assistant/messages/${sent.userMessage.id}`, { method: "DELETE" })).status, 200);
    assertEquals(store.getAssistantMessages().length, 0);
    assertEquals((await app.request("/api/assistant/messages/nope", { method: "DELETE" })).status, 404);
  } finally { cleanup(teamDir, store); }
});

// ─── Persona ─────────────────────────────────────────────────────────

Deno.test("persona: defaults to none, can be set and cleared", async () => {
  const { app, store, teamDir } = setup();
  try {
    let body = await (await app.request("/api/assistant/persona")).json();
    assertEquals(body.personaId, null);
    // Framing is always vended, with the default persona behind it.
    assertStringIncludes(body.systemPrompt, "You are in a live chat");
    assertStringIncludes(body.systemPrompt, "team assistant");

    await post(app, "/api/context", { title: "Pizzaiolo", content: "You are a gruff pizzaiolo.", tags: ["persona"] });
    const entries = await (await app.request("/api/context")).json();
    const id = entries.entries[0].id;

    const setRes = await put(app, "/api/assistant/persona", { personaId: id });
    assertEquals(setRes.status, 200);
    body = await setRes.json();
    assertEquals(body.personaId, id);
    assertStringIncludes(body.systemPrompt, "gruff pizzaiolo");
    assertStringIncludes(body.systemPrompt, "You are in a live chat");
    assertEquals(store.getAssistantPersonaId(), id);

    body = await (await put(app, "/api/assistant/persona", { personaId: null })).json();
    assertEquals(body.personaId, null);
    assertEquals((await put(app, "/api/assistant/persona", { personaId: "missing" })).status, 404);
  } finally { cleanup(teamDir, store); }
});

Deno.test("persona swap ends the session (snapshotted) instead of wiping the chat", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/agents/register", { id: "leader", name: "leader", directory: teamDir, hostId: "h1" });
    await post(app, "/api/assistant/messages", { content: "talking to the default" });
    const before = store.getActiveAssistantSession()!;

    await post(app, "/api/context", { title: "Pizzaiolo", content: "Gruff.", tags: ["persona"] });
    const entries = await (await app.request("/api/context")).json();
    await put(app, "/api/assistant/persona", { personaId: entries.entries[0].id });

    // Old conversation preserved; a new session opened under the new persona.
    assertEquals(store.getAssistantSession(before.id)!.status, "ended");
    assertEquals(store.getAssistantMessages(before.id).length, 1);
    const active = store.getActiveAssistantSession()!;
    assertEquals(active.id === before.id, false);
    assertEquals(active.personaTitle, "Pizzaiolo");
    assertStringIncludes(store.getAssistantMessages(active.id)[0]!.content, "Pizzaiolo");

    // The agent is asked to roll its Pi session so its context matches.
    assertEquals(store.getMemberDirectives("leader").some((d) => d.action === "new-session"), true);
  } finally { cleanup(teamDir, store); }
});

// ─── Migration ───────────────────────────────────────────────────────

Deno.test("v1 turn-model rows migrate into one ended legacy session", async () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-asst-migrate-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  try {
    // Hand-build a v1 database: turn table + status column, no sessions.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(teamDir, "state.db"));
    db.exec(`
      CREATE TABLE assistant_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, role TEXT, content TEXT,
        status TEXT DEFAULT 'done', turn_id TEXT, created_at INTEGER
      );
      CREATE TABLE assistant_turns (id TEXT PRIMARY KEY, status TEXT, claimed_at INTEGER, created_at INTEGER);
      INSERT INTO assistant_messages (id, role, content, status, turn_id, created_at) VALUES
        ('m1', 'user', 'old question', 'read', 't1', 1000),
        ('m2', 'assistant', 'old answer', 'done', 't1', 2000),
        ('m3', 'user', 'never answered', 'sent', NULL, 3000);
      INSERT INTO assistant_turns (id, status, created_at) VALUES ('t1', 'done', 1000);
    `);
    db.close();

    const store = new Store(teamDir, DEFAULT_CONFIG);
    try {
      const sessions = store.listAssistantSessions();
      assertEquals(sessions.length, 1);
      assertEquals(sessions[0]!.status, "ended");
      assertEquals(sessions[0]!.messageCount, 3);

      const messages = store.getAssistantMessages(sessions[0]!.id);
      assertEquals(messages.map((m) => m.content), ["old question", "old answer", "never answered"]);
      assertEquals(messages[0]!.delivery, "read");
      assertEquals(messages[1]!.state, "ok");
      // A stale unanswered message must not be replayed into the new session.
      assertEquals(messages[2]!.delivery, "read");
      assertEquals(store.getAssistantInbox().length, 0);

      // The transcript is snapshotted so it shows up as browsable history.
      assertStringIncludes(
        Deno.readTextFileSync(path.join(teamDir, ASSISTANT_DIR, ASSISTANT_SESSIONS_DIR, `${sessions[0]!.id}.md`)),
        "old answer",
      );
    } finally { store.close(); }
  } finally {
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
  }
});

// ─── Chat agent designation ──────────────────────────────────────────

Deno.test("the leader is the chat agent; the inbox is gated on designation", async () => {
  const { app, store, teamDir } = setup();
  try {
    // No leader online: the message still queues, but nobody is designated.
    const queued = await (await post(app, "/api/assistant/messages", { content: "anyone?" })).json();
    assertEquals(queued.chatAgent, null);
    assertEquals(store.getAssistantInbox().length, 1);

    await post(app, "/api/agents/register", { id: "leader", name: "leader", directory: teamDir, hostId: "h1" });
    assertEquals(store.getChatAgent()?.id, "leader");

    // Only the designated agent may pull, and it sees the backlog.
    const mine = await (await app.request("/api/assistant/inbox?agentId=leader")).json();
    assertEquals(mine.chat, true);
    assertEquals(mine.messages.length, 1);

    // Anyone else is told to stay quiet and gets nothing.
    const other = await (await app.request("/api/assistant/inbox?agentId=teammate-1")).json();
    assertEquals(other.chat, false);
    assertEquals(other.messages.length, 0);
    // A missing agentId must not leak the inbox either.
    assertEquals((await (await app.request("/api/assistant/inbox")).json()).chat, false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("designation is sticky, and hands off only when the leader goes offline", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/agents/register", { id: "leader-a", name: "leader", directory: teamDir, hostId: "h1" });
    await post(app, "/api/agents/register", { id: "leader-b", name: "leader", directory: teamDir, hostId: "h2" });
    const first = store.getChatAgent()!.id;

    // A second leader must not steal the conversation mid-flight.
    assertEquals(store.getChatAgent()!.id, first);
    assertEquals(store.isChatAgent(first), true);
    assertEquals(store.isChatAgent(first === "leader-a" ? "leader-b" : "leader-a"), false);

    // When it drops, the other leader takes over so the chat keeps working.
    store.removeMember(first);
    const second = store.getChatAgent()!.id;
    assertEquals(second === first, false);
    assertEquals(store.isChatAgent(second), true);
  } finally { cleanup(teamDir, store); }
});

Deno.test("session directives are addressed to the chat agent (the leader)", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/agents/register", { id: "leader", name: "leader", directory: teamDir, hostId: "h1" });
    await post(app, "/api/assistant/messages", { content: "first chat" });
    await post(app, "/api/assistant/sessions/new");

    // The leader realizes these itself via Pi's session APIs, so they must land
    // on its self-directive queue and not in the tmux-driven leader queue.
    assertEquals(store.getMemberDirectives("leader").some((d) => d.action === "new-session"), true);
    assertEquals(store.getLeaderDirectives("h1").some((d) => d.action === "new-session"), false);
  } finally { cleanup(teamDir, store); }
});

Deno.test("spawning always mints a teammate name (no reserved assistant identity)", async () => {
  const { app, store, teamDir } = setup();
  try {
    await post(app, "/api/agents/register", { id: "leader", name: "leader", directory: teamDir, hostId: "h1" });
    // `reason: "assistant"` used to mint the singleton name; now it's just a spawn.
    await post(app, "/api/hosts/h1/leader/directives", { action: "spawn", params: { reason: "assistant" } });
    await post(app, "/api/hosts/h1/leader/directives", { action: "spawn", params: {} });
    const names = store.getPendingSpawnRequests().map((r) => r.name);
    assertEquals(names.length, 2);
    assertEquals(names.includes("assistant"), false);
    assertEquals(new Set(names).size, 2, "spawn names must be unique");
  } finally { cleanup(teamDir, store); }
});
