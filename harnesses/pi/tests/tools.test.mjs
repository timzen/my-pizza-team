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

test("exports registerLeaderTools (the chat agent's tool set)", () => {
  assert.ok(src.includes("export function registerLeaderTools("));
  // The assistant role is gone: the leader answers the chat.
  assert.ok(!src.includes("registerAssistantTools"));
});

test("exports registerTeammateTools", () => {
  assert.ok(src.includes("export function registerTeammateTools("));
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

test("no queue_request tool (the leader is the chat; it would message itself)", () => {
  // The doc comment explains the removal, so assert on the registration instead.
  assert.ok(!src.includes('name: "queue_request"'));
  assert.ok(!src.includes("registerQueueRequest"));
  assert.ok(!src.includes("enqueueAssistantRequest"));
});

test("has team_status tool", () => {
  assert.ok(src.includes('name: "team_status"'));
});

test("has thought-reading tools (list_thoughts / get_thought / list_thought_groups)", () => {
  assert.ok(src.includes('name: "list_thoughts"'));
  assert.ok(src.includes('name: "get_thought"'));
  assert.ok(src.includes('name: "list_thought_groups"'));
});

test("has thought-writing tools (create/edit/archive/group)", () => {
  assert.ok(src.includes('name: "create_thought"'));
  assert.ok(src.includes('name: "edit_thought"'));
  assert.ok(src.includes('name: "archive_thought"'));
  assert.ok(src.includes('name: "group_thoughts"'));
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
  const teammateFn = src.slice(src.indexOf("function registerTeammateTools"), src.indexOf("// ═══════════════════════════════════════════════════════════════════════\n// TOOL IMPLEMENTATIONS"));
  assert.ok(teammateFn.includes("registerUploadAttachment"));
});

test("registerTeammateTools does NOT include create_story", () => {
  const teammateFn = src.slice(src.indexOf("function registerTeammateTools"), src.indexOf("// ═══════════════════════════════════════════════════════════════════════\n// TOOL IMPLEMENTATIONS"));
  assert.ok(!teammateFn.includes("registerCreateStory"));
});

// ─── Assistant tools composition ─────────────────────────────────

test("registerLeaderTools carries the full planning surface (it is the chat agent)", () => {
  const leaderFn = src.slice(
    src.indexOf("function registerLeaderTools"),
    src.indexOf("function registerTeammateTools"),
  );
  // Board + standalone work
  for (const fn of ["registerCreateStory", "registerEditStory", "registerAddTask", "registerCreateTask", "registerCreateSchedule"]) {
    assert.ok(leaderFn.includes(fn), `missing ${fn}`);
  }
  // Read-only planning context + status
  for (const fn of ["registerListWorkflows", "registerListContext", "registerTeamStatus"]) {
    assert.ok(leaderFn.includes(fn), `missing ${fn}`);
  }
  // Thoughts: read + write (the thoughts -> work loop)
  for (const fn of ["registerListThoughtGroups", "registerListThoughts", "registerGetThought", "registerCreateThought", "registerEditThought", "registerArchiveThought", "registerGroupThoughts"]) {
    assert.ok(leaderFn.includes(fn), `missing ${fn}`);
  }
  // Not the chat agent's job: teammate-only execution tools, and no self-messaging.
  assert.ok(!leaderFn.includes("registerUploadAttachment"));
  assert.ok(!leaderFn.includes("registerQueueRequest"));
  assert.ok(!leaderFn.includes("registerReadScratchpad"));
});

test("create_story calls client.createStory", () => {
  assert.ok(src.includes("client.createStory("));
});

test("edit_story calls client.updateStory", () => {
  assert.ok(src.includes("client.updateStory("));
});

test("story tools use directory affinity (directory/paused), not a capability model", () => {
  // Matching is directory-affinity only: no skills/requirements/dir legacy.
  assert.ok(src.includes("directory:"));
  assert.ok(src.includes("paused:"));
  assert.ok(!src.includes("buildRequirements("));
  assert.ok(!src.includes("skills:"));
  assert.ok(!/\bdir:/.test(src)); // no legacy dir field
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
  assert.ok(src.includes("client.postComment(workItemId"));
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
