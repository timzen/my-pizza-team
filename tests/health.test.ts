/**
 * tests/health.test.ts — Verifies the /health endpoint responds correctly.
 *
 * The enhanced health endpoint returns uptime, agent count, queue depth,
 * memory usage, and last git commit time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertExists } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { createApp } from "../daemon/app.ts";

// Use a temp directory so we get a full app with store
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-health-test-"));
fs.writeFileSync(`${testDir}/config.json`, JSON.stringify(TEST_CONFIG));

const { app, store } = await createApp(testDir);

test("GET /health returns ok status with metrics", async () => {
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

test("GET /health reports tmuxSession and leader presence", async () => {
  // No members yet — no leader connected.
  let body = await (await app.request("/health")).json();
  assertEquals(body.tmuxSession, TEST_CONFIG.tmuxSession);
  assertEquals(body.leaderPresent, false);

  // A member named "leader" makes leaderPresent true.
  store!.registerMember("leader-1", "leader", "/tmp", {});
  body = await (await app.request("/health")).json();
  assertEquals(body.leaderPresent, true);

  // A non-leader member alone does not.
  store!.removeMember("leader-1");
  store!.registerMember("tm-1", "swift-ripley", "/tmp", {});
  body = await (await app.request("/health")).json();
  assertEquals(body.leaderPresent, false);
});

test("GET /health backward compat - still has status and service", async () => {
  const res = await app.request("/health");
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.service, "my-pizza-team");
});

test("GET /health reports the spawn capability and the daemon's tmux server", async () => {
  // `mpt doctor` compares tmuxSocket with its own, so windows don't open on a
  // server the user never attaches to.
  store!.setTmuxCapability({ canSpawn: false, reason: "tmux is not on this process's PATH", fix: "install tmux" });
  store!.setTmuxSocket("/tmp/tmux-501/default");
  const body = await (await app.request("/health")).json();
  assertEquals(body.spawning, { canSpawn: false, reason: "tmux is not on this process's PATH", fix: "install tmux" });
  assertEquals(body.tmuxSocket, "/tmp/tmux-501/default");
  store!.setTmuxCapability({ canSpawn: true });
  assertEquals((await (await app.request("/health")).json()).spawning, { canSpawn: true });
});

// Cleanup
test("cleanup health test", () => {
  store?.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

