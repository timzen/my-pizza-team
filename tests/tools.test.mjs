// Smoke test for LLM tools
// Run with: node tests/tools.test.mjs
//
// Verifies the tools module exports role-specific registration functions
// and implements all required tools via the daemon API.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "../src/tools.ts"),
  "utf-8"
);

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

console.log("Tools module source checks:");

// ─── Exports ─────────────────────────────────────────────────────

test("exports registerLeaderTools", () => {
  assert.ok(src.includes("export function registerLeaderTools("));
});

test("exports registerTeammateTools", () => {
  assert.ok(src.includes("export function registerTeammateTools("));
});

test("exports registerAssistantTools", () => {
  assert.ok(src.includes("export function registerAssistantTools("));
});

test("does NOT export old registerTools function", () => {
  assert.ok(!src.includes("export function registerTools("));
});

// ─── Tool names (new naming convention) ──────────────────────────

test("has create_story tool (not team_add_story)", () => {
  assert.ok(src.includes('name: "create_story"'));
  assert.ok(!src.includes('name: "team_add_story"'));
});

test("has edit_story tool (not team_edit_story)", () => {
  assert.ok(src.includes('name: "edit_story"'));
  assert.ok(!src.includes('name: "team_edit_story"'));
});

test("has add_task tool (not team_add_task)", () => {
  assert.ok(src.includes('name: "add_task"'));
  assert.ok(!src.includes('name: "team_add_task"'));
});

test("has queue_request tool (not team_queue_request)", () => {
  assert.ok(src.includes('name: "queue_request"'));
  assert.ok(!src.includes('name: "team_queue_request"'));
});

test("has team_status tool", () => {
  assert.ok(src.includes('name: "team_status"'));
});

test("has read_scratchpad tool", () => {
  assert.ok(src.includes('name: "read_scratchpad"'));
});

test("has upload_attachment tool", () => {
  assert.ok(src.includes('name: "upload_attachment"'));
});

// ─── Leader tools composition ────────────────────────────────────

test("registerLeaderTools includes create_story", () => {
  const leaderFn = src.slice(src.indexOf("function registerLeaderTools"), src.indexOf("function registerTeammateTools"));
  assert.ok(leaderFn.includes("registerCreateStory"));
});

test("registerLeaderTools includes edit_story", () => {
  const leaderFn = src.slice(src.indexOf("function registerLeaderTools"), src.indexOf("function registerTeammateTools"));
  assert.ok(leaderFn.includes("registerEditStory"));
});

test("registerLeaderTools includes add_task", () => {
  const leaderFn = src.slice(src.indexOf("function registerLeaderTools"), src.indexOf("function registerTeammateTools"));
  assert.ok(leaderFn.includes("registerAddTask"));
});

test("registerLeaderTools includes team_status", () => {
  const leaderFn = src.slice(src.indexOf("function registerLeaderTools"), src.indexOf("function registerTeammateTools"));
  assert.ok(leaderFn.includes("registerTeamStatus"));
});

test("registerLeaderTools includes list_workflows and list_context", () => {
  const leaderFn = src.slice(src.indexOf("function registerLeaderTools"), src.indexOf("function registerTeammateTools"));
  assert.ok(leaderFn.includes("registerListWorkflows"));
  assert.ok(leaderFn.includes("registerListContext"));
});

// ─── Teammate tools composition ──────────────────────────────────

test("registerTeammateTools includes upload_attachment", () => {
  const teammateFn = src.slice(src.indexOf("function registerTeammateTools"), src.indexOf("function registerAssistantTools"));
  assert.ok(teammateFn.includes("registerUploadAttachment"));
});

test("registerTeammateTools does NOT include create_story", () => {
  const teammateFn = src.slice(src.indexOf("function registerTeammateTools"), src.indexOf("function registerAssistantTools"));
  assert.ok(!teammateFn.includes("registerCreateStory"));
});

// ─── Assistant tools composition ─────────────────────────────────

test("registerAssistantTools includes create_story", () => {
  const assistantFn = src.slice(src.indexOf("function registerAssistantTools"), src.indexOf("// ═══════════════════════════════════════════════════════════════════════\n// TOOL IMPLEMENTATIONS"));
  assert.ok(assistantFn.includes("registerCreateStory"));
});

test("registerAssistantTools includes list_workflows and list_context (read-only planning tools)", () => {
  const assistantFn = src.slice(src.indexOf("function registerAssistantTools"), src.indexOf("// ═══════════════════════════════════════════════════════════════════════\n// TOOL IMPLEMENTATIONS"));
  assert.ok(assistantFn.includes("registerListWorkflows"));
  assert.ok(assistantFn.includes("registerListContext"));
});

test("registerAssistantTools includes read_scratchpad", () => {
  const assistantFn = src.slice(src.indexOf("function registerAssistantTools"), src.indexOf("// TOOL IMPLEMENTATIONS"));
  assert.ok(assistantFn.includes("registerReadScratchpad"));
});

test("registerAssistantTools does NOT include team_status", () => {
  const assistantFn = src.slice(src.indexOf("function registerAssistantTools"), src.indexOf("// ═══════════════════════════════════════════════════════════════════════\n// TOOL IMPLEMENTATIONS"));
  assert.ok(!assistantFn.includes("registerTeamStatus"));
});

test("registerAssistantTools does NOT include upload_attachment", () => {
  const assistantFn = src.slice(src.indexOf("function registerAssistantTools"), src.indexOf("// ═══════════════════════════════════════════════════════════════════════\n// TOOL IMPLEMENTATIONS"));
  assert.ok(!assistantFn.includes("registerUploadAttachment"));
});

// ─── Daemon API usage ────────────────────────────────────────────

test("create_story calls client.createStory", () => {
  assert.ok(src.includes("client.createStory("));
});

test("edit_story calls client.updateStory", () => {
  assert.ok(src.includes("client.updateStory("));
});

test("story tools use the capability model (directory/skills/paused), not dir", () => {
  assert.ok(src.includes("buildRequirements("));
  assert.ok(src.includes("paused:"));
  assert.ok(src.includes("skills:"));
  assert.ok(!/dir:/.test(src)); // no legacy dir field
});

test("skills accept name:value entries (value-bound capabilities)", () => {
  // buildRequirements must split on the first colon: `java:8` -> { java: "8" },
  // bare `python` -> { python: null }.
  assert.ok(src.includes('entry.indexOf(":")'));
  assert.ok(src.includes("entry.slice(0, i)"));
});

test("add_task calls client.createTask", () => {
  assert.ok(src.includes("client.createTask("));
});

test("list_workflows calls client.listWorkflows", () => {
  assert.ok(src.includes('name: "list_workflows"'));
  assert.ok(src.includes("client.listWorkflows()"));
});

test("list_context calls client.listContext", () => {
  assert.ok(src.includes('name: "list_context"'));
  assert.ok(src.includes("client.listContext()"));
});

test("create_story and add_task accept and forward a context param", () => {
  // Planners attach context-library entries by id to a story or task.
  assert.ok(src.includes("context: params.context"));
  assert.ok(src.includes("params.storyId, params.title, params.description, params.context"));
});

test("queue_request calls client.enqueueAssistantRequest", () => {
  assert.ok(src.includes("client.enqueueAssistantRequest("));
});

test("context tools are gone (daemon vends context, agents don't CRUD it)", () => {
  assert.ok(!src.includes("registerSaveContext"));
  assert.ok(!src.includes("registerSearchContext"));
  assert.ok(!src.includes("client.saveNote("));
  assert.ok(!src.includes("client.searchNotes("));
});

test("team_status calls client.getStatus", () => {
  assert.ok(src.includes("client.getStatus()"));
});

test("upload_attachment calls client.uploadAttachment", () => {
  assert.ok(src.includes("client.uploadAttachment("));
});

test("upload_attachment calls client.postComment for the message", () => {
  assert.ok(src.includes("client.postComment(taskId"));
});

// ─── No server-side deps ─────────────────────────────────────────

test("does not import Store or better-sqlite3", () => {
  assert.ok(!src.includes("Store"));
  assert.ok(!src.includes("better-sqlite3"));
});

test("uses TypeBox for parameter schemas", () => {
  assert.ok(src.includes('import { Type } from "typebox"'));
  assert.ok(src.includes("Type.Object("));
  assert.ok(src.includes("Type.String("));
  assert.ok(src.includes("Type.Optional("));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
