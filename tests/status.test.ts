/**
 * tests/status.test.ts — GET /api/status reports whether task distribution is
 * paused, so the UI can show the pause toggle's real state and explain stalled
 * queue items (the Queue tab's banner).
 */

import { assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

Deno.test("status: `paused` follows control/pause and control/resume", async () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-status-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  try {
    assertEquals((await (await app.request("/api/status")).json()).paused, false);
    await app.request("/api/control/pause", { method: "POST" });
    assertEquals((await (await app.request("/api/status")).json()).paused, true);
    await app.request("/api/control/resume", { method: "POST" });
    assertEquals((await (await app.request("/api/status")).json()).paused, false);
  } finally {
    store.close();
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});
