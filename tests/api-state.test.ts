/**
 * tests/api-state.test.ts — Background polling never disturbs the reader
 * (ui/src/lib/api-state.ts, ui/src/lib/structural.ts, ui/src/lib/list-keys.ts;
 * docs/DESIGN.md "Polling Never Disturbs the Reader").
 *
 * The rules under test: `useApi`'s state machine reports `loading` only until a
 * url/deps first answers (never on a poll), an unchanged poll keeps the very
 * same state and data references (so React skips the render and a page's text
 * selection survives), a failed poll keeps the last good data, and lists from
 * polled data get stable keys. The hook itself is a thin React wrapper over
 * `apiReducer` + `fetchInto`, so driving those with a stub fetch exercises its
 * whole fetch/poll path; source checks pin the wiring and the page patterns.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assert, assertEquals, assertFalse } from "./_assert.ts";
import {
  apiKey, apiReducer, fetchInto, initialApiState, isLoading, type ApiAction, type ApiState,
} from "../ui/src/lib/api-state.ts";
import { jsonEqual, shareStructure } from "../ui/src/lib/structural.ts";
import { keyLookup, threadEntryKey, uniqueKeys } from "../ui/src/lib/list-keys.ts";

const read = (p: string) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf-8");

// ─── structural ────────────────────────────────────────────────────

test("jsonEqual: deep equality for JSON values", () => {
  assert(jsonEqual({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] }));
  assertFalse(jsonEqual({ a: 1 }, { a: 1, b: undefined }));
  assertFalse(jsonEqual([1, 2], [2, 1]));
  assertFalse(jsonEqual({ a: [1] }, { a: { 0: 1 } }));
  assertFalse(jsonEqual(null, {}));
  assert(jsonEqual(NaN, NaN));
});

test("shareStructure: an unchanged answer returns the previous reference", () => {
  const prev = { items: [{ id: "a", n: 1 }, { id: "b", n: 2 }], total: 2 };
  const next = JSON.parse(JSON.stringify(prev));
  assert(shareStructure(prev, next) === prev);
});

test("shareStructure: a change replaces only the parts that differ", () => {
  const prev = { items: [{ id: "a", n: 1 }, { id: "b", n: 2 }], meta: { v: 1 } };
  const next = { items: [{ id: "a", n: 1 }, { id: "b", n: 3 }], meta: { v: 1 } };
  const out = shareStructure(prev, next);
  assert(out !== prev);
  assertEquals(out, next);
  assert(out.items[0] === prev.items[0], "unchanged row keeps its reference");
  assert(out.items[1] !== prev.items[1], "changed row is new");
  assert(out.meta === prev.meta, "unchanged sibling keeps its reference");
});

test("shareStructure: added/removed keys and elements, and non-JSON values", () => {
  const prev = { a: 1, list: [1, 2, 3] };
  const grown = shareStructure(prev, { a: 1, b: 2, list: [1, 2, 3, 4] });
  assertEquals(grown, { a: 1, b: 2, list: [1, 2, 3, 4] });
  const shrunk = shareStructure(prev, { list: [1, 2] });
  assertEquals(shrunk, { list: [1, 2] });
  assert(shareStructure(null, { a: 1 }) !== null);
  const d = new Date(0);
  assert(shareStructure(new Date(0), d) === d, "non-plain objects compare by identity");
});

// ─── useApi's state machine ────────────────────────────────────────

/** A stub fetch answering each call with the next body (or an HTTP status). */
function stubFetch(answers: Array<unknown | { status: number }>) {
  let i = 0;
  return async (_url: string) => {
    const a = answers[Math.min(i++, answers.length - 1)];
    const status = a && typeof a === "object" && "status" in a ? (a as { status: number }).status : 200;
    return new Response(status === 200 ? JSON.stringify(a) : "{}", { status });
  };
}

/** One hook instance's state, driven like useApi drives it (useReducer). */
function harness<T>() {
  let state: ApiState<T> = initialApiState<T>();
  const history: ApiState<T>[] = [];
  const dispatch = (action: ApiAction<T>) => { state = apiReducer(state, action); history.push(state); };
  return { dispatch, counter: { current: 0 }, get state() { return state; }, history };
}

test("an unchanged poll keeps the same state and data reference, and never sets loading", async () => {
  const url = "/api/workflows/default";
  const key = apiKey(url, []);
  const h = harness<{ states: Array<{ name: string }> }>();
  const body = { states: [{ name: "in_progress" }, { name: "review" }] };
  const fetchImpl = stubFetch([body, body, body]);

  assert(isLoading(h.state, key, url), "loading before the first answer");
  await fetchInto(url, key, h.dispatch, h.counter, fetchImpl);
  const loaded = h.state;
  assertFalse(isLoading(loaded, key, url));
  assertEquals(loaded.data, body);

  // Two poll intervals (and a manual refetch is the same call).
  const before = h.history.length;
  await fetchInto(url, key, h.dispatch, h.counter, fetchImpl);
  await fetchInto(url, key, h.dispatch, h.counter, fetchImpl);
  assert(h.state === loaded, "unchanged polls return the very same state (React skips the render)");
  assert(h.state.data === loaded.data, "same data reference");
  for (const s of h.history.slice(before)) {
    assert(s === loaded, "no intermediate state either: no loading flip, no cleared data/error");
    assertFalse(isLoading(s, key, url));
  }
});

test("a WorkflowDetailPage-style gate stays mounted across polls", async () => {
  // The page renders `if (loading && !data) return <Loading/>` — it must render
  // its content after every state the polls produce once data has loaded.
  const url = "/api/workflows/default";
  const key = apiKey(url, []);
  const h = harness<{ states: string[] }>();
  const fetchImpl = stubFetch([{ states: ["a"] }, { states: ["a"] }, { states: ["a", "b"] }, { status: 500 }, { states: ["a", "b"] }]);
  await fetchInto(url, key, h.dispatch, h.counter, fetchImpl);
  const firstLoaded = h.history.length;
  for (let i = 0; i < 4; i++) await fetchInto(url, key, h.dispatch, h.counter, fetchImpl);
  for (const s of h.history.slice(firstLoaded - 1)) {
    const showsSpinner = isLoading(s, key, url) && !s.data;
    assertFalse(showsSpinner, "content stays mounted");
    assert(s.data !== null, "data never cleared by a poll");
  }
  assertEquals(h.state.data, { states: ["a", "b"] });
  assertEquals(h.state.error, null, "a good answer clears the poll's error");
});

test("a failed poll keeps the last good data and reports the error beside it", async () => {
  const url = "/api/sources";
  const key = apiKey(url, []);
  const h = harness<{ n: number }>();
  const fetchImpl = stubFetch([{ n: 1 }, { status: 503 }, { status: 503 }]);
  await fetchInto(url, key, h.dispatch, h.counter, fetchImpl);
  const data = h.state.data;
  await fetchInto(url, key, h.dispatch, h.counter, fetchImpl);
  assertEquals(h.state.error, "HTTP 503");
  assert(h.state.data === data);
  assertFalse(h.state.loading);
  const failed = h.state;
  await fetchInto(url, key, h.dispatch, h.counter, fetchImpl);
  assert(h.state === failed, "the same error again changes nothing");
});

test("a url/deps change is a new key: loading until it answers, previous data kept meanwhile", async () => {
  const h = harness<{ id: string }>();
  const k1 = apiKey("/api/personas/a", ["a"]);
  const k2 = apiKey("/api/personas/b", ["b"]);
  await fetchInto("/api/personas/a", k1, h.dispatch, h.counter, stubFetch([{ id: "a" }]));
  // The render right after the change, before the effect dispatches `start`.
  assert(isLoading(h.state, k2, "/api/personas/b"));
  h.dispatch({ type: "start", key: k2 });
  assert(h.state.loading);
  assertEquals(h.state.data, { id: "a" });
  // A late answer for the old key is dropped.
  h.dispatch({ type: "success", key: k1, data: { id: "stale" } });
  assertEquals(h.state.data, { id: "a" });
  h.dispatch({ type: "success", key: k2, data: { id: "b" } });
  assertFalse(h.state.loading);
  assertEquals(h.state.data, { id: "b" });
});

test("out-of-order answers: only the newest request applies", async () => {
  const url = "/api/x";
  const key = apiKey(url, []);
  const h = harness<{ v: number }>();
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  const first = fetchInto(url, key, h.dispatch, h.counter, async () => { await slow; return new Response(JSON.stringify({ v: 1 })); });
  await fetchInto(url, key, h.dispatch, h.counter, async () => new Response(JSON.stringify({ v: 2 })));
  release();
  await first;
  assertEquals(h.state.data, { v: 2 });
});

test("a null url fetches nothing and isn't loading", async () => {
  const key = apiKey(null, []);
  const h = harness<unknown>();
  assertFalse(isLoading(h.state, key, null));
  let called = false;
  await fetchInto(null, key, h.dispatch, h.counter, async () => { called = true; return new Response("{}"); });
  assertFalse(called);
  assertFalse(h.state.loading);
  assertEquals(h.state.data, null);
});

test("useApi is wired to the reducer and fetchInto (no loading flips of its own)", () => {
  const src = read("hooks/useApi.ts");
  assert(src.includes("useReducer("), "state lives in the reducer");
  assert(src.includes("apiReducer"));
  assert(src.includes("fetchInto"));
  assertFalse(/setLoading\(|setData\(|setError\(/.test(src), "no ad-hoc state setters");
});

// ─── stable keys ───────────────────────────────────────────────────

test("uniqueKeys: natural keys, duplicates numbered in order", () => {
  assertEquals(uniqueKeys(["a", "b", "a", "a"], (x) => x), ["a", "b", "a#2", "a#3"]);
  const comments = [{ from: "x", at: "1" }, { from: "y", at: "2" }, { from: "x", at: "1" }];
  assertEquals(uniqueKeys(comments, threadEntryKey), ["1|x", "2|y", "1|x#2"]);
});

test("keyLookup: a newest-first list keeps each row's key when a comment lands", () => {
  const c1 = { from: "x", at: "1" }, c2 = { from: "y", at: "2" };
  const before = keyLookup([c1, c2], threadEntryKey);
  const c3 = { from: "z", at: "3" };
  const after = keyLookup([c1, c2, c3], threadEntryKey);
  // Rendered newest first: an index key would move every row; these don't.
  assertEquals([c2, c1].map(before), [c2, c1].map(after));
  assertEquals(after(c3), "3|z");
});

// ─── page and component patterns ───────────────────────────────────

/** Every .tsx under ui/src, relative to it. */
function tsxFiles(dir = ""): string[] {
  const root = new URL(`../ui/src/${dir}`, import.meta.url);
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return tsxFiles(rel);
    return e.name.endsWith(".tsx") ? [rel] : [];
  });
}

test("no page replaces loaded content with a spinner on `loading` alone", () => {
  for (const f of tsxFiles()) {
    const src = read(f);
    // `if (loading) return …` unmounted the whole page; gate on `!data` too.
    assertFalse(/if \(loading\) return/.test(src), `${f}: gate the placeholder on !data`);
  }
});

test("MarkdownView's components map is module-level (a per-render map remounts the document)", () => {
  const src = read("components/ui/markdown-view.tsx");
  const fnStart = src.indexOf("export function MarkdownView");
  assert(fnStart > 0);
  const body = src.slice(fnStart);
  assertFalse(/components=\{\{/.test(body), "no inline components object");
  assertFalse(/remarkPlugins=\{\[/.test(body), "no inline plugin array");
  assert(/^const COMPONENTS\b/m.test(src.slice(0, fnStart)));
});

test("thread and triage lists from polled data are not keyed by index", () => {
  for (const f of ["pages/TaskDetailPage.tsx", "pages/WorkDefDetailPage.tsx", "components/triage/TriageAnalysis.tsx", "pages/PersonasPage.tsx"]) {
    const src = read(f);
    assertFalse(/key=\{(i|j|idx|index)\}/.test(src), `${f}: index key`);
  }
  // UsagePage keeps index keys only for its fixed calendar labels; the runs list is keyed.
  assert(read("pages/UsagePage.tsx").includes("key={runKeys[i]}"));
});

test("stream rows are memoized so one frame re-renders one row", () => {
  assert(/const EntryRow = memo\(/.test(read("components/transcript/TranscriptView.tsx")));
  assert(/export const MessageBubble = memo\(/.test(read("components/assistant/MessageBubble.tsx")));
  assert(read("hooks/useAssistantStream.ts").includes("shareStructure(prev, data.messages"));
  assert(read("hooks/useTranscriptStream.ts").includes("shareStructure(prev, event.entries)"));
});
