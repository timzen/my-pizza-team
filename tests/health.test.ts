/**
 * tests/health.test.ts — Verifies the /health endpoint responds correctly.
 */

import { assertEquals } from "@std/assert";
import { app } from "../daemon/app.ts";

Deno.test("GET /health returns ok status", async () => {
  const res = await app.request("/health");
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.service, "my-pizza-team");
});
