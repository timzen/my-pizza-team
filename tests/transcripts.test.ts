/**
 * tests/transcripts.test.ts — Live teammate transcripts (docs/DESIGN.md "Watching and Pairing with a Teammate").
 *
 * Covers the watch-only model: entries are recorded only while a member is
 * watched (with a grace window after the last viewer leaves), a `watch` marker
 * opens each watching period, keyed entries upsert in place, the ring cap, and
 * the agent-facing routes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { TeammateTranscripts, WATCH_GRACE_MS, type TranscriptEntry } from "../daemon/store/transcripts.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { type TeamConfig } from "../shared/types.ts";
import * as path from "node:path";

/** A transcript store with a controllable clock. */
function clocked() {
  let t = 1_000_000;
  const tx = new TeammateTranscripts(() => t);
  return { tx, advance: (ms: number) => { t += ms; } };
}

test("unwatched: entries are dropped, nothing is buffered", () => {
  const { tx } = clocked();
  assertEquals(tx.isWatched("t1"), false);
  assertEquals(tx.record("t1", [{ kind: "run", state: "start" }]), 0);
  assertEquals(tx.getEntries("t1").length, 0);
});

test("watching opens with a marker, then records and pushes entries", () => {
  const { tx } = clocked();
  const seen: TranscriptEntry[] = [];
  tx.watch("t1", (e) => seen.push(e.entry));
  assertEquals(tx.isWatched("t1"), true);
  tx.record("t1", [{ kind: "user", text: "do the thing", origin: "extension" }]);
  const kinds = tx.getEntries("t1").map((e) => e.kind);
  assertEquals(kinds, ["watch", "user"]);
  assertEquals(seen.map((e) => e.kind), ["watch", "user"]);
});

test("keyed entries upsert in place (streaming message, tool end)", () => {
  const { tx } = clocked();
  tx.watch("t1", () => {});
  tx.record("t1", [{ kind: "message", key: "msg:1", text: "Hel" }]);
  tx.record("t1", [{ kind: "tool", key: "tool:a", name: "bash", args: { command: "ls" }, state: "running" }]);
  tx.record("t1", [{ kind: "message", key: "msg:1", text: "Hello" }]);
  tx.record("t1", [{ kind: "tool", key: "tool:a", name: "bash", state: "done", result: "a.txt" }]);
  const entries = tx.getEntries("t1");
  assertEquals(entries.length, 3); // watch, message, tool
  const msg = entries[1] as TranscriptEntry & { text?: string };
  assertEquals(msg.text, "Hello");
  const tool = entries[2] as TranscriptEntry & { args?: unknown; state?: string; result?: string };
  assertEquals(tool.state, "done");
  assertEquals(tool.args, { command: "ls" }); // merged, not replaced
  assertEquals(tool.result, "a.txt");
  assertEquals(entries[1]!.seq < entries[2]!.seq, true); // position kept
});

test("a tool end whose start was missed lands standalone (no args)", () => {
  const { tx } = clocked();
  tx.watch("t1", () => {});
  tx.record("t1", [{ kind: "tool", key: "tool:z", name: "read", state: "done", result: "…" }]);
  const tool = tx.getEntries("t1")[1] as TranscriptEntry & { args?: unknown };
  assertEquals(tool.kind, "tool");
  assertEquals(tool.args, undefined);
});

test("grace window: a page hop keeps watching and adds no second marker", () => {
  const { tx, advance } = clocked();
  const stop = tx.watch("t1", () => {});
  stop();
  advance(WATCH_GRACE_MS - 1);
  assertEquals(tx.isWatched("t1"), true);
  tx.watch("t1", () => {});
  assertEquals(tx.getEntries("t1").filter((e) => e.kind === "watch").length, 1);
});

test("after the grace window: unwatched; the buffer survives; re-watch marks the gap", () => {
  const { tx, advance } = clocked();
  const stop = tx.watch("t1", () => {});
  tx.record("t1", [{ kind: "run", state: "start" }]);
  stop();
  advance(WATCH_GRACE_MS + 1);
  assertEquals(tx.isWatched("t1"), false);
  assertEquals(tx.getEntries("t1").length, 2); // kept across the disconnect
  tx.watch("t1", () => {});
  assertEquals(tx.getEntries("t1").map((e) => e.kind), ["watch", "run", "watch"]);
});

test("invalid entries are dropped; agents can't forge markers or seq", () => {
  const { tx } = clocked();
  tx.watch("t1", () => {});
  const n = tx.record("t1", [null, "x", { kind: "nope" }, { kind: "watch" }, { kind: "run", state: "end", seq: -5 }]);
  assertEquals(n, 1);
  const last = tx.getEntries("t1").at(-1)!;
  assertEquals(last.kind, "run");
  assertEquals(last.seq > 0, true);
});

test("the ring keeps the newest 500 entries", () => {
  const { tx } = clocked();
  tx.watch("t1", () => {});
  tx.record("t1", Array.from({ length: 600 }, () => ({ kind: "run", state: "start" })));
  const entries = tx.getEntries("t1");
  assertEquals(entries.length, 500);
  assertEquals(entries[0]!.kind, "run"); // the marker aged out
});

test("forget drops an unwatched member's transcript but not a watched one's", () => {
  const { tx, advance } = clocked();
  const stop = tx.watch("t1", () => {});
  tx.forget("t1");
  assertEquals(tx.getEntries("t1").length, 1);
  stop();
  advance(WATCH_GRACE_MS + 1);
  tx.forget("t1");
  assertEquals(tx.getEntries("t1").length, 0);
});

// ─── Routes ─────────────────────────────────────────────────────────

function setup() {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-transcript-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), minTeammates: 0 };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir };
}

test("routes: watch bit, POST batch (carries watched), GET buffer", async () => {
  const { app, store, teamDir } = setup();
  try {
    const watch0 = await (await app.request("/api/agents/t1/transcript/watch")).json();
    assertEquals(watch0.watched, false);

    const stop = store.transcripts.watch("t1", () => {});
    const watch1 = await (await app.request("/api/agents/t1/transcript/watch")).json();
    assertEquals(watch1.watched, true);

    const res = await app.request("/api/agents/t1/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ kind: "run", state: "start" }] }),
    });
    const body = await res.json();
    assertEquals(body.recorded, 1);
    assertEquals(body.watched, true);

    const buf = await (await app.request("/api/agents/t1/transcript")).json();
    assertEquals(buf.entries.map((e: TranscriptEntry) => e.kind), ["watch", "run"]);
    stop();

    const bad = await app.request("/api/agents/t1/transcript", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assertEquals(bad.status, 400);
  } finally {
    store.close();
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("routes: the SSE stream primes with hello and registers a viewer", async () => {
  const { app, store, teamDir } = setup();
  try {
    const res = await app.request("/api/agents/t1/transcript/stream");
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('"hello"')) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    assertEquals(store.transcripts.isWatched("t1"), true);
    assertEquals(text.includes('"kind":"watch"'), true);
    await reader.cancel();
  } finally {
    store.close();
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("routes: the leader's transcript is the same pipeline as any teammate's (terminal mode)", async () => {
  // assistant.chatMode "terminal" watches the leader through these very routes;
  // there's no leader-specific branch, so the same batch must land identically.
  const { app, store, teamDir } = setup();
  try {
    await app.request("/api/agents/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "leader", name: "leader" }),
    });
    await app.request("/api/agents/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "t1", name: "swift-ripley" }),
    });
    const batch = [
      { kind: "session" },
      { kind: "user", text: "hi", origin: "web" },
      { kind: "run", state: "start" },
      { kind: "message", key: "msg:i1:1", text: "Hello", thinking: "hmm" },
      { kind: "tool", key: "tool:c1", name: "bash", args: { command: "ls" }, state: "done", result: "a.txt" },
      { kind: "tool", key: "tool:c2", name: "read", args: { path: "x" }, state: "error", result: "ENOENT" },
      { kind: "run", state: "end" },
    ];
    const strip = (entries: TranscriptEntry[]) => entries.map(({ seq: _s, at: _a, ...rest }) => rest);
    const results: Record<string, unknown[]> = {};
    for (const id of ["t1", "leader"]) {
      // Unwatched: nothing recorded — same watch semantics (no backfill).
      const before = await (await app.request(`/api/agents/${id}/transcript`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: batch }),
      })).json();
      assertEquals(before.recorded, 0, id);
      const stop = store.transcripts.watch(id, () => {});
      const res = await (await app.request(`/api/agents/${id}/transcript`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: batch }),
      })).json();
      assertEquals(res.recorded, batch.length, id);
      results[id] = strip((await (await app.request(`/api/agents/${id}/transcript`)).json()).entries);
      stop();
    }
    assertEquals(results.leader, results.t1);
  } finally {
    store.close();
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
