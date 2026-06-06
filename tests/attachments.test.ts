/**
 * tests/attachments.test.ts — Tests for the file attachment endpoints.
 *
 * Verifies POST /api/tasks/:id/attachments, GET list, and GET download.
 */

import { assertEquals } from "jsr:@std/assert";
import { createApp } from "../daemon/app.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";

const testDir = Deno.makeTempDirSync({ prefix: "mpt-attach-test-" });
Deno.writeTextFileSync(`${testDir}/config.json`, JSON.stringify(DEFAULT_CONFIG));

const { app, store } = createApp(testDir);

// Create a story and task for testing via the store directly
store!.createStory("attach-story", "Test story", "desc", "open", [], [{ title: "Test task", description: "A task" }]);
const taskId = "attach-story-1";

Deno.test("POST /api/tasks/:id/attachments uploads a file", async () => {
  const res = await app.request(`/api/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "changes.diff", content: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n" }),
  });
  assertEquals(res.status, 200);
  const data = await res.json() as { success: boolean; storedName: string; type: string; size: number };
  assertEquals(data.success, true);
  assertEquals(data.type, "diff");
  assertEquals(typeof data.storedName, "string");
  assertEquals(data.size > 0, true);
});

Deno.test("POST /api/tasks/:id/attachments returns 404 for bad task", async () => {
  const res = await app.request("/api/tasks/nonexistent/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "file.txt", content: "hello" }),
  });
  assertEquals(res.status, 404);
});

Deno.test("POST /api/tasks/:id/attachments returns 400 without name", async () => {
  const res = await app.request(`/api/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "hello" }),
  });
  assertEquals(res.status, 400);
});

Deno.test("GET /api/tasks/:id/attachments lists uploaded files", async () => {
  const res = await app.request(`/api/tasks/${taskId}/attachments`);
  assertEquals(res.status, 200);
  const data = await res.json() as { attachments: Array<{ name: string; storedName: string; size: number }> };
  assertEquals(data.attachments.length >= 1, true);
  assertEquals(data.attachments[0]!.name.includes("changes"), true);
});

Deno.test("GET /api/tasks/:id/attachments/:filename downloads the file", async () => {
  // Get the stored name first
  const listRes = await app.request(`/api/tasks/${taskId}/attachments`);
  const listData = await listRes.json() as { attachments: Array<{ storedName: string }> };
  const storedName = listData.attachments[0]!.storedName;

  const res = await app.request(`/api/tasks/${taskId}/attachments/${storedName}`);
  assertEquals(res.status, 200);
  const content = await res.text();
  assertEquals(content.includes("-old"), true);
  assertEquals(content.includes("+new"), true);
});

Deno.test("GET /api/tasks/:id/attachments/:filename returns 404 for missing", async () => {
  const res = await app.request(`/api/tasks/${taskId}/attachments/nonexistent.txt`);
  assertEquals(res.status, 404);
});

// Cleanup
Deno.test({
  name: "cleanup attachments test",
  fn() {
    store?.close();
    Deno.removeSync(testDir, { recursive: true });
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
