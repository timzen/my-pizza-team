/**
 * tests/http.test.ts — The routes' shared request parsing and error replies
 * (daemon/routes/http.ts + `app.onError` in daemon/server.ts): malformed JSON is
 * a JSON 400 on every route — ones that used to throw (a plain-text 500) and ones
 * that used to treat it as `{}` alike — an empty body still reads as `{}`, and an
 * unexpected throw is a JSON 500.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, JSON_HEADERS, type App } from "./_team.ts";

const INVALID = { success: false, error: "Invalid JSON body" };

async function send(app: App, method: string, url: string, body?: string) {
  const res = await app.request(url, { method, headers: JSON_HEADERS, body });
  return { status: res.status, type: res.headers.get("content-type") ?? "", json: await res.json() as Record<string, unknown> };
}

test("malformed JSON is a JSON 400 on a route that used to throw (POST /api/stories)", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await send(app, "POST", "/api/stories", "{not json");
    assertEquals(res.status, 400);
    assertEquals(res.type.startsWith("application/json"), true);
    assertEquals(res.json, INVALID);
  });
});

test("malformed JSON is a 400 on a route that used to read it as {} (POST /api/thoughts)", async () => {
  await withTeam({}, async ({ app, store }) => {
    const res = await send(app, "POST", "/api/thoughts", "{\"body\": ");
    assertEquals(res.status, 400);
    assertEquals(res.json, INVALID);
    assertEquals(store.getThoughts().length, 0);
  });
});

test("malformed JSON is a 400 behind a feature gate that already read the body (POST /api/work-defs)", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await send(app, "POST", "/api/work-defs", "[oops");
    assertEquals(res.status, 400);
    assertEquals(res.json, INVALID);
  });
});

test("malformed JSON is a 400 on PUT /api/config, not the save's catch-all message", async () => {
  await withTeam({}, async ({ app }) => {
    const res = await send(app, "PUT", "/api/config", "nope");
    assertEquals(res.status, 400);
    assertEquals(res.json, INVALID);
  });
});

test("an empty body still reads as {}: the route's own field checks answer", async () => {
  await withTeam({}, async ({ app }) => {
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
  await withTeam({}, async ({ app }) => {
    const res = await send(app, "POST", "/api/thoughts/positions", JSON.stringify({}));
    assertEquals(res.status, 400);
    assertEquals(res.json, { success: false, error: "Field 'moves' (array) is required", updated: [] });
  });
});

test("an unexpected throw is a logged JSON 500", async () => {
  await withTeam({}, async ({ app }) => {
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
