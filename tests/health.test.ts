/**
 * tests/health.test.ts — Verifies the /health endpoint responds correctly.
 *
 * The enhanced health endpoint returns uptime, agent count, queue depth,
 * memory usage, and last git commit time.
 */

import { assertEquals, assertExists } from "@std/assert";
import { createApp } from "../daemon/app.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";

// Use a temp directory so we get a full app with store
const testDir = Deno.makeTempDirSync({ prefix: "mpt-health-test-" });
Deno.writeTextFileSync(`${testDir}/config.json`, JSON.stringify(DEFAULT_CONFIG));

const { app, store } = createApp(testDir);

Deno.test("GET /health returns ok status with metrics", async () => {
  const res = await app.request("/health");
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.service, "my-pizza-team");

  // Uptime should be a non-negative number
  assertEquals(typeof body.uptime, "number");
  assertEquals(body.uptime >= 0, true);

  // Agents count
  assertEquals(typeof body.agents, "number");
  assertEquals(body.agents >= 0, true);

  // Queue depth
  assertEquals(typeof body.queueDepth, "number");
  assertEquals(body.queueDepth >= 0, true);

  // Memory usage object
  assertExists(body.memory);
  assertEquals(typeof body.memory.rss, "number");
  assertEquals(typeof body.memory.heapUsed, "number");
  assertEquals(typeof body.memory.heapTotal, "number");

  // lastCommitTime is string or null (null since temp dir isn't a git repo)
  assertEquals(body.lastCommitTime, null);
});

Deno.test("GET /health backward compat - still has status and service", async () => {
  const res = await app.request("/health");
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.service, "my-pizza-team");
});

// Cleanup
Deno.test({
  name: "cleanup health test",
  fn() {
    store?.close();
    Deno.removeSync(testDir, { recursive: true });
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
