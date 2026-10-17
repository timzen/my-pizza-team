/**
 * tests/status.test.ts — GET /api/status reports whether task distribution is
 * paused, so the UI can show the pause toggle's real state and explain stalled
 * queue items (the Queue tab's banner), plus the cheap counts behind the NavBar's
 * Pizza Team badges (`queuedCount`, `unreadInboxCount`).
 */

import { assertEquals } from "@std/assert";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";
import { badgeLabel } from "../ui/src/lib/inbox.ts";

Deno.test("status: `paused` follows control/pause and control/resume", async () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-status-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), minTeammates: 0 };
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

Deno.test("status: queuedCount and unreadInboxCount track READY and unread finished WorkItems", async () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-status-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), minTeammates: 0 };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  const counts = async () => {
    const body = await (await app.request("/api/status")).json();
    return { queued: body.queuedCount, unread: body.unreadInboxCount };
  };
  try {
    assertEquals(await counts(), { queued: 0, unread: 0 });

    // Three Solitary WorkDefs → three READY WorkItems.
    for (const title of ["A", "B", "C"]) {
      store.createWorkDef({ title, goal: "g", acceptanceCriteria: "a", directory: "/tmp/repo" }, true);
    }
    assertEquals(await counts(), { queued: 3, unread: 0 });

    // Claimed (IN_PROGRESS) is no longer queued, and not yet in the Inbox.
    store.registerMember("m1", "swift-ripley", "/tmp/repo");
    const [first, second] = store.getWorkItems({ states: ["READY"] }).items;
    assertEquals(store.claimWorkItem(first!.id, "m1"), true);
    assertEquals(await counts(), { queued: 2, unread: 0 });

    // Finished (COMPLETE or FAILED) lands unread in the Inbox.
    assertEquals(store.setWorkItemState(first!.id, "COMPLETE").ok, true);
    assertEquals(store.claimWorkItem(second!.id, "m1"), true);
    assertEquals(store.setWorkItemState(second!.id, "FAILED").ok, true);
    assertEquals(await counts(), { queued: 1, unread: 2 });

    // Reading clears it from the unread count; marking unread brings it back.
    await app.request(`/api/work-items/${first!.id}/read`, { method: "POST" });
    assertEquals(await counts(), { queued: 1, unread: 1 });
    await app.request(`/api/work-items/${first!.id}/read?read=false`, { method: "POST" });
    assertEquals(await counts(), { queued: 1, unread: 2 });

    // Canceled work is discarded — neither queued nor in the Inbox.
    const [third] = store.getWorkItems({ states: ["READY"] }).items;
    assertEquals(store.cancelWorkItem(third!.id), true);
    assertEquals(await counts(), { queued: 0, unread: 2 });
  } finally {
    store.close();
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("status: badgeLabel hides zero/unknown and caps at 99+", () => {
  assertEquals(badgeLabel(0), null);
  assertEquals(badgeLabel(undefined), null);
  assertEquals(badgeLabel(null), null);
  assertEquals(badgeLabel(1), "1");
  assertEquals(badgeLabel(99), "99");
  assertEquals(badgeLabel(100), "99+");
});
