/**
 * tests/auth.test.ts — Tests for API token authentication.
 *
 * Verifies that:
 * - Without a token, all endpoints are accessible (auth disabled)
 * - With a token, /health is public but API routes require auth
 * - Bearer tokens, Basic auth, and query params are all accepted
 * - Invalid/missing tokens return 401
 * - Bind safety rejects 0.0.0.0 without a token
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { Hono } from "hono";
import {
  createAuthMiddleware,
  generateToken,
  resolveToken,
  validateBindSafety,
} from "../daemon/auth.ts";

// --- Unit tests for auth utilities ---

test("generateToken: produces 64-char hex string", () => {
  const token = generateToken();
  assertEquals(token.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(token), true);
});

test("generateToken: produces unique tokens", () => {
  const t1 = generateToken();
  const t2 = generateToken();
  assertEquals(t1 !== t2, true);
});

test("resolveToken: env takes priority over config", () => {
  const original = process.env["MPT_API_TOKEN"];
  try {
    process.env["MPT_API_TOKEN"] = "env-token";
    assertEquals(resolveToken("config-token"), "env-token");
  } finally {
    if (original) process.env["MPT_API_TOKEN"] = original;
    else delete process.env["MPT_API_TOKEN"];
  }
});

test("resolveToken: falls back to config token", () => {
  const original = process.env["MPT_API_TOKEN"];
  try {
    delete process.env["MPT_API_TOKEN"];
    assertEquals(resolveToken("my-config-token"), "my-config-token");
  } finally {
    if (original) process.env["MPT_API_TOKEN"] = original;
  }
});

test("resolveToken: returns null when nothing configured", () => {
  const original = process.env["MPT_API_TOKEN"];
  try {
    delete process.env["MPT_API_TOKEN"];
    assertEquals(resolveToken(undefined), null);
  } finally {
    if (original) process.env["MPT_API_TOKEN"] = original;
  }
});

// --- Bind safety tests ---

test("validateBindSafety: 127.0.0.1 is safe without token", () => {
  const result = validateBindSafety("127.0.0.1", null);
  assertEquals(result.safe, true);
});

test("validateBindSafety: localhost is safe without token", () => {
  const result = validateBindSafety("localhost", null);
  assertEquals(result.safe, true);
});

test("validateBindSafety: 0.0.0.0 is unsafe without token", () => {
  const result = validateBindSafety("0.0.0.0", null);
  assertEquals(result.safe, false);
  assertEquals(typeof result.reason, "string");
});

test("validateBindSafety: 0.0.0.0 is safe WITH token", () => {
  const result = validateBindSafety("0.0.0.0", "my-secret-token");
  assertEquals(result.safe, true);
});

// --- Middleware integration tests ---

function createTestApp(token: string | null): Hono {
  const app = new Hono();
  const middleware = createAuthMiddleware(token);
  if (middleware) {
    app.use("*", middleware);
  }
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/api/status", (c) => c.json({ data: "secret" }));
  app.post("/api/stories", (c) => c.json({ created: true }));
  return app;
}

test("auth middleware: null token means no auth required", async () => {
  const app = createTestApp(null);
  const res = await app.request("/api/status");
  assertEquals(res.status, 200);
});

test("auth middleware: /health is always public", async () => {
  const app = createTestApp("secret123");
  const res = await app.request("/health");
  assertEquals(res.status, 200);
});

test("auth middleware: API routes return 401 without token", async () => {
  const app = createTestApp("secret123");
  const res = await app.request("/api/status");
  assertEquals(res.status, 401);
});

test("auth middleware: Bearer token grants access", async () => {
  const app = createTestApp("secret123");
  const res = await app.request("/api/status", {
    headers: { Authorization: "Bearer secret123" },
  });
  assertEquals(res.status, 200);
});

test("auth middleware: wrong Bearer token returns 401", async () => {
  const app = createTestApp("secret123");
  const res = await app.request("/api/status", {
    headers: { Authorization: "Bearer wrong" },
  });
  assertEquals(res.status, 401);
});

test("auth middleware: Basic auth (password=token) works", async () => {
  const app = createTestApp("secret123");
  const encoded = btoa("user:secret123");
  const res = await app.request("/api/status", {
    headers: { Authorization: `Basic ${encoded}` },
  });
  assertEquals(res.status, 200);
});

test("auth middleware: Basic auth with wrong password returns 401", async () => {
  const app = createTestApp("secret123");
  const encoded = btoa("user:wrong");
  const res = await app.request("/api/status", {
    headers: { Authorization: `Basic ${encoded}` },
  });
  assertEquals(res.status, 401);
});

test("auth middleware: query param token works", async () => {
  const app = createTestApp("secret123");
  const res = await app.request("/api/status?token=secret123");
  assertEquals(res.status, 200);
});

test("auth middleware: POST with Bearer token works", async () => {
  const app = createTestApp("secret123");
  const res = await app.request("/api/stories", {
    method: "POST",
    headers: {
      Authorization: "Bearer secret123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 200);
});
