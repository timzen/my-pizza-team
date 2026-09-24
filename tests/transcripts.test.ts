/**
 * tests/transcripts.test.ts — Live teammate transcripts (docs/TEAMMATE_CHAT.md §3).
 *
 * Covers the watch-only model: entries are recorded only while a member is
 * watched (with a grace window after the last viewer leaves), a `watch` marker
 * opens each watching period, keyed entries upsert in place, the ring cap, and
 * the agent-facing routes.
 */

import { assertEquals } from "@std/assert";
import { TeammateTranscripts, WATCH_GRACE_MS, type TranscriptEntry } from "../daemon/store/transcripts.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

/** A transcript store with a controllable clock. */
function clocked() {
  let t = 1_000_000;
  const tx = new TeammateTranscripts(() => t);
  return { tx, advance: (ms: number) => { t += ms; } };
}

Deno.test("unwatched: entries are dropped, nothing is buffered", () => {
  const { tx } = clocked();
  assertEquals(tx.isWatched("t1"), false);
  assertEquals(tx.record("t1", [{ kind: "run", state: "start" }]), 0);
  assertEquals(tx.getEntries("t1").length, 0);
});

Deno.test("watching opens with a marker, then records and pushes entries", () => {
  const { tx } = clocked();
  const seen: TranscriptEntry[] = [];
  tx.watch("t1", (e) => seen.push(e.entry));
  assertEquals(tx.isWatched("t1"), true);
  tx.record("t1", [{ kind: "user", text: "do the thing", origin: "extension" }]);
  const kinds = tx.getEntries("t1").map((e) => e.kind);
  assertEquals(kinds, ["watch", "user"]);
  assertEquals(seen.map((e) => e.kind), ["watch", "user"]);
});

Deno.test("keyed entries upsert in place (streaming message, tool end)", () => {
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

Deno.test("a tool end whose start was missed lands standalone (no args)", () => {
  const { tx } = clocked();
  tx.watch("t1", () => {});
  tx.record("t1", [{ kind: "tool", key: "tool:z", name: "read", state: "done", result: "…" }]);
  const tool = tx.getEntries("t1")[1] as TranscriptEntry & { args?: unknown };
  assertEquals(tool.kind, "tool");
  assertEquals(tool.args, undefined);
});

Deno.test("grace window: a page hop keeps watching and adds no second marker", () => {
  const { tx, advance } = clocked();
  const stop = tx.watch("t1", () => {});
  stop();
  advance(WATCH_GRACE_MS - 1);
  assertEquals(tx.isWatched("t1"), true);
  tx.watch("t1", () => {});
  assertEquals(tx.getEntries("t1").filter((e) => e.kind === "watch").length, 1);
});

Deno.test("after the grace window: unwatched; the buffer survives; re-watch marks the gap", () => {
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

Deno.test("invalid entries are dropped; agents can't forge markers or seq", () => {
  const { tx } = clocked();
  tx.watch("t1", () => {});
  const n = tx.record("t1", [null, "x", { kind: "nope" }, { kind: "watch" }, { kind: "run", state: "end", seq: -5 }]);
  assertEquals(n, 1);
  const last = tx.getEntries("t1").at(-1)!;
  assertEquals(last.kind, "run");
  assertEquals(last.seq > 0, true);
});

Deno.test("the ring keeps the newest 500 entries", () => {
  const { tx } = clocked();
  tx.watch("t1", () => {});
  tx.record("t1", Array.from({ length: 600 }, () => ({ kind: "run", state: "start" })));
  const entries = tx.getEntries("t1");
  assertEquals(entries.length, 500);
  assertEquals(entries[0]!.kind, "run"); // the marker aged out
});

Deno.test("forget drops an unwatched member's transcript but not a watched one's", () => {
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
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-transcript-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir };
}

Deno.test("routes: watch bit, POST batch (carries watched), GET buffer", async () => {
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
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("routes: the SSE stream primes with hello and registers a viewer", async () => {
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
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});
