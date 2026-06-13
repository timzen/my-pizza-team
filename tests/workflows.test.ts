/**
 * tests/workflows.test.ts — Tests for workflow-specific API endpoints.
 *
 * Verifies GET /api/workflows, GET /api/workflows/:name,
 * GET /api/workflows/:name/instructions/:filename, and
 * PUT /api/workflows/:name/instructions/:filename.
 */

import { assertEquals } from "@std/assert";
import { createApp } from "../daemon/app.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import * as path from "jsr:@std/path@^1";

const testDir = Deno.makeTempDirSync({ prefix: "mpt-workflows-test-" });
Deno.writeTextFileSync(`${testDir}/config.json`, JSON.stringify(DEFAULT_CONFIG));

// Create a workflow directory with a workflow.json
const wfDir = path.join(testDir, "workflows", "default");
Deno.mkdirSync(wfDir, { recursive: true });
Deno.writeTextFileSync(
  path.join(wfDir, "workflow.json"),
  JSON.stringify(DEFAULT_CONFIG.workflows!["default"], null, 2)
);

const { app } = createApp(testDir);

Deno.test("GET /api/workflows returns workflow summaries", async () => {
  const res = await app.request("/api/workflows");
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(Array.isArray(body), true);
  assertEquals(body.length >= 1, true);

  const defaultWf = body.find((w: { name: string }) => w.name === "default");
  assertEquals(defaultWf.name, "default");
  assertEquals(defaultWf.stateCount, 4);
  assertEquals(typeof defaultWf.transitionCount, "number");
  assertEquals(defaultWf.transitionCount > 0, true);
  assertEquals(defaultWf.isDefault, true);
});

Deno.test("GET /api/workflows/:name returns full workflow config", async () => {
  const res = await app.request("/api/workflows/default");
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(Array.isArray(body.states), true);
  assertEquals(body.states.length, 4);
  assertEquals(typeof body.transitions, "object");
});

Deno.test("GET /api/workflows/:name returns 404 for unknown workflow", async () => {
  const res = await app.request("/api/workflows/nonexistent");
  assertEquals(res.status, 404);
});

Deno.test("GET /api/workflows/:name/instructions/:filename returns 404 when file doesn't exist", async () => {
  const res = await app.request("/api/workflows/default/instructions/todo");
  assertEquals(res.status, 404);
});

Deno.test("PUT /api/workflows/:name/instructions/:filename creates and writes file", async () => {
  const content = "# Todo Instructions\n\nWhen entering todo state, do X.";
  const res = await app.request("/api/workflows/default/instructions/todo", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);

  // Verify file was written
  const filePath = path.join(testDir, "workflows", "default", "todo.md");
  const written = Deno.readTextFileSync(filePath);
  assertEquals(written, content);
});

Deno.test("GET /api/workflows/:name/instructions/:filename reads existing file", async () => {
  // File was created by previous test
  const res = await app.request("/api/workflows/default/instructions/todo");
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.content, "# Todo Instructions\n\nWhen entering todo state, do X.");
});

Deno.test("PUT /api/workflows/:name/instructions/:filename creates directories for new workflow", async () => {
  const content = "# Review state instructions";
  const res = await app.request("/api/workflows/new-workflow/instructions/review", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  assertEquals(res.status, 200);

  const filePath = path.join(testDir, "workflows", "new-workflow", "review.md");
  const written = Deno.readTextFileSync(filePath);
  assertEquals(written, content);
});

Deno.test("PUT /api/workflows/:name/instructions/:filename returns 400 without content", async () => {
  const res = await app.request("/api/workflows/default/instructions/todo", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 400);
});
