/**
 * tests/http.test.ts — The routes' shared request parsing and error replies
 * (daemon/routes/http.ts + `app.onError` in daemon/server.ts): malformed JSON is
 * a JSON 400 on every route — ones that used to throw (a plain-text 500) and ones
 * that used to treat it as `{}` alike — an empty body still reads as `{}`, and an
 * unexpected throw is a JSON 500.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INVALID = { success: false, error: "Invalid JSON body" };

/** Run `fn` against a fresh team's app, cleaning up after. */
async function withApp(fn: (app: ReturnType<typeof buildApp>, store: Store) => Promise<void>): Promise<void> {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-http-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = structuredClone(TEST_CONFIG);
  const store = new Store(teamDir, config);
  try {
    await fn(buildApp(store, config, teamDir), store);
  } finally {
    store.close();
    fs.rmSync(teamDir, { recursive: true, force: true });
  }
}

async function send(app: ReturnType<typeof buildApp>, method: string, url: string, body?: string) {
  const res = await app.request(url, { method, headers: JSON_HEADERS, body });
  return { status: res.status, type: res.headers.get("content-type") ?? "", json: await res.json() as Record<string, unknown> };
}

test("malformed JSON is a JSON 400 on a route that used to throw (POST /api/stories)", async () => {
  await withApp(async (app) => {
    const res = await send(app, "POST", "/api/stories", "{not json");
    assertEquals(res.status, 400);
    assertEquals(res.type.startsWith("application/json"), true);
    assertEquals(res.json, INVALID);
  });
});

test("malformed JSON is a 400 on a route that used to read it as {} (POST /api/thoughts)", async () => {
  await withApp(async (app, store) => {
    const res = await send(app, "POST", "/api/thoughts", "{\"body\": ");
    assertEquals(res.status, 400);
    assertEquals(res.json, INVALID);
    assertEquals(store.getThoughts().length, 0);
  });
});

test("malformed JSON is a 400 behind a feature gate that already read the body (POST /api/work-defs)", async () => {
  await withApp(async (app) => {
    const res = await send(app, "POST", "/api/work-defs", "[oops");
    assertEquals(res.status, 400);
    assertEquals(res.json, INVALID);
  });
});

test("malformed JSON is a 400 on PUT /api/config, not the save's catch-all message", async () => {
  await withApp(async (app) => {
    const res = await send(app, "PUT", "/api/config", "nope");
    assertEquals(res.status, 400);
    assertEquals(res.json, INVALID);
  });
});

test("an empty body still reads as {}: the route's own field checks answer", async () => {
  await withApp(async (app) => {
    // Used to throw on the empty body; now its validation reports the field.
    const story = await send(app, "POST", "/api/stories");
    assertEquals(story.status, 400);
    assertEquals(story.json, { success: false, error: "Field 'id' is required" });
    // Already read failures as {}; unchanged.
    const ready = await send(app, "POST", "/api/readiness", "  ");
    assertEquals(ready.status, 400);
    assertEquals(ready.json, { success: false, error: "Field 'ready' (boolean) is required" });
  });
});

test("valid JSON is unaffected, and error replies keep their extra fields", async () => {
  await withApp(async (app) => {
    const res = await send(app, "POST", "/api/thoughts/positions", JSON.stringify({}));
    assertEquals(res.status, 400);
    assertEquals(res.json, { success: false, error: "Field 'moves' (array) is required", updated: [] });
  });
});

test("an unexpected throw is a logged JSON 500", async () => {
  await withApp(async (app) => {
    app.get("/api/__boom", () => { throw new Error("kaboom"); });
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a); };
    try {
      const res = await send(app, "GET", "/api/__boom");
      assertEquals(res.status, 500);
      assertEquals(res.json, { success: false, error: "Internal server error" });
    } finally {
      console.error = orig;
    }
    assertEquals(logged.length, 1);
    assertEquals(String(logged[0]![0]).includes("GET /api/__boom"), true);
  });
});
