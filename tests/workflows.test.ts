/**
 * tests/workflows.test.ts — Tests for workflow-specific API endpoints.
 *
 * Verifies GET /api/workflows, GET /api/workflows/:name, the state persona
 * selection (PUT /api/workflows/:name/states/:state), and that the old
 * instruction-file routes answer 410.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { after, test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { createApp } from "../daemon/app.ts";

import * as path from "node:path";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-workflows-test-"));
fs.writeFileSync(`${testDir}/config.json`, JSON.stringify(TEST_CONFIG));

// Create a workflow directory with a workflow.json
const wfDir = path.join(testDir, "workflows", "default");
fs.mkdirSync(wfDir, { recursive: true });
fs.writeFileSync(
  path.join(wfDir, "workflow.json"),
  JSON.stringify(TEST_CONFIG.workflows!["default"], null, 2)
);

const { app, store } = await createApp(testDir);
// The store's background timers would keep `node --test` from exiting.
after(() => {
  store?.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test("GET /api/workflows returns workflow summaries", async () => {
  const res = await app.request("/api/workflows");
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(Array.isArray(body), true);
  assertEquals(body.length >= 1, true);

  const defaultWf = body.find((w: { name: string }) => w.name === "default");
  assertEquals(defaultWf.name, "default");
  // Default workflow: in_progress (agent) → review (manual); todo/done are
  // implicit buckets, not states.
  assertEquals(defaultWf.stateCount, 2);
  assertEquals(defaultWf.agentCount, 1);
  assertEquals(defaultWf.manualCount, 1);
  assertEquals(defaultWf.isDefault, true);
});

test("GET /api/workflows/:name returns full workflow config", async () => {
  const res = await app.request("/api/workflows/default");
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(Array.isArray(body.states), true);
  assertEquals(body.states.length, 2);
  assertEquals(body.states[0].name, "in_progress");
  assertEquals(body.states[0].type, "agent");
  assertEquals(body.states[1].type, "manual");
});

test("GET /api/workflows/:name returns 404 for unknown workflow", async () => {
  const res = await app.request("/api/workflows/nonexistent");
  assertEquals(res.status, 404);
});

test("the workflow instruction-file routes are gone (410), naming the replacement", async () => {
  for (const method of ["GET", "PUT"]) {
    const res = await app.request("/api/workflows/default/instructions/in_progress", {
      method, headers: { "Content-Type": "application/json" }, body: method === "PUT" ? JSON.stringify({ content: "x" }) : undefined,
    });
    assertEquals(res.status, 410);
    assertEquals((await res.json()).error.includes("/api/workflows/:name/states/:state"), true);
  }
  assertEquals(fs.existsSync(path.join(testDir, "workflows", "default", "in_progress.md")), false);
});

test("PUT /api/workflows/:name/states/:state selects (and clears) a state's persona", async () => {
  const json = (body: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await (await app.request("/api/personas", { ...json({ title: "Implementer", content: "You implement." }), method: "POST" })).json();
  const id = created.persona.id as string;

  let res = await app.request("/api/workflows/default/states/in_progress", json({ persona: id }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).workflow.states[0].persona, id);
  const onDisk = JSON.parse(fs.readFileSync(path.join(wfDir, "workflow.json"), "utf8"));
  assertEquals(onDisk.states[0].persona, id);
  assertEquals(store!.getStatePersona("default", "in_progress"), "You implement.");

  // A manual state has no teammate, so no persona; unknown ids and states are refused.
  assertEquals((await app.request("/api/workflows/default/states/review", json({ persona: id }))).status, 400);
  assertEquals((await app.request("/api/workflows/default/states/in_progress", json({ persona: "nope" }))).status, 400);
  assertEquals((await app.request("/api/workflows/default/states/nope", json({ persona: id }))).status, 404);
  assertEquals((await app.request("/api/workflows/nope/states/in_progress", json({ persona: id }))).status, 404);

  res = await app.request("/api/workflows/default/states/in_progress", json({ persona: null }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).workflow.states[0].persona, undefined);
  assertEquals(store!.getStatePersona("default", "in_progress"), undefined);
});
