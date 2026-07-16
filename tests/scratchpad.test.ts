/**
 * tests/scratchpad.test.ts — Verifies the scratch pad: TODO.jsonl + NOTES.md
 * persistence, todo add/toggle/delete (with completion stamping), and routes.
 */

import { assertEquals, assertExists } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import * as path from "@std/path";

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-scratch-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const store = new Store(teamDir, DEFAULT_CONFIG);
  const app = buildApp(store, DEFAULT_CONFIG, teamDir);
  return { app, store, teamDir };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

Deno.test("Scratchpad: empty by default", () => {
  const { store, teamDir } = setup();
  try {
    const sp = store.getScratchpad();
    assertEquals(sp.todos, []);
    assertEquals(sp.notes, "");
  } finally { cleanup(teamDir, store); }
});

Deno.test("Scratchpad: add, toggle (stamps completed), reopen, delete", () => {
  const { store, teamDir } = setup();
  try {
    store.addScratchpadTodo("send an email");
    let todos = store.getScratchpad().todos;
    assertEquals(todos.length, 1);
    assertEquals(todos[0]!.status, "open");
    assertEquals(todos[0]!.item, "send an email");
    assertEquals(todos[0]!.created.length, 10); // YYYY-MM-DD
    assertEquals(todos[0]!.completed, "");

    // Complete it → completed date stamped.
    store.updateScratchpadTodo(0, { status: "done" });
    todos = store.getScratchpad().todos;
    assertEquals(todos[0]!.status, "done");
    assertEquals(todos[0]!.completed.length, 10);

    // Reopen → completed cleared.
    store.updateScratchpadTodo(0, { status: "open" });
    assertEquals(store.getScratchpad().todos[0]!.completed, "");

    // Delete.
    const after = store.deleteScratchpadTodo(0);
    assertEquals(after, []);
    assertEquals(store.deleteScratchpadTodo(0), null); // out of range
  } finally { cleanup(teamDir, store); }
});

Deno.test("Scratchpad: notes round-trip on disk", () => {
  const { store, teamDir } = setup();
  try {
    store.setScratchpadNotes("# Plan\n\n- ship it");
    assertEquals(store.getScratchpad().notes, "# Plan\n\n- ship it");
    // Written to NOTES.md at the team dir root.
    assertExists(Deno.statSync(path.join(teamDir, "NOTES.md")));
  } finally { cleanup(teamDir, store); }
});

Deno.test("Scratchpad: todos persist as JSONL and reload", () => {
  const { store, teamDir } = setup();
  try {
    store.addScratchpadTodo("one");
    store.addScratchpadTodo("two");
    // Raw file is one JSON object per line.
    const raw = Deno.readTextFileSync(path.join(teamDir, "TODO.jsonl")).trim().split("\n");
    assertEquals(raw.length, 2);
    assertEquals(JSON.parse(raw[0]!).item, "one");

    // A fresh store reads the same data back.
    const store2 = new Store(teamDir, DEFAULT_CONFIG);
    assertEquals(store2.getScratchpad().todos.map((t) => t.item), ["one", "two"]);
    store2.close();
  } finally { cleanup(teamDir, store); }
});

Deno.test("Scratchpad routes: GET, add, toggle, delete, notes", async () => {
  const { app, teamDir, store } = setup();
  try {
    const post = (url: string, body: unknown) => app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const put = (url: string, body: unknown) => app.request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    let res = await post("/api/scratchpad/todos", { item: "buy milk" });
    assertEquals(res.status, 201);

    res = await app.request("/api/scratchpad");
    let sp = await res.json();
    assertEquals(sp.todos.length, 1);

    res = await put("/api/scratchpad/todos/0", { status: "done" });
    sp = await res.json();
    assertEquals(sp.todos[0].status, "done");

    res = await put("/api/scratchpad/notes", { content: "hello" });
    assertEquals((await res.json()).success, true);
    assertEquals(store.getScratchpad().notes, "hello");

    res = await app.request("/api/scratchpad/todos/0", { method: "DELETE" });
    assertEquals((await res.json()).todos.length, 0);

    // 404 on out-of-range update.
    res = await put("/api/scratchpad/todos/5", { status: "done" });
    assertEquals(res.status, 404);
  } finally { cleanup(teamDir, store); }
});
