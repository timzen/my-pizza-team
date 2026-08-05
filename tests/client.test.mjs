// Smoke test for DaemonClient
// Run with: node tests/client.test.mjs
//
// Tests that the DaemonClient class source has expected exports and
// method signatures matching the daemon's agent protocol.
// Does NOT require a running daemon.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const clientSrc = fs.readFileSync(
  path.join(import.meta.dirname, "../src/client.ts"),
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

console.log("DaemonClient source checks:");

// ─── Class structure ─────────────────────────────────────────────

test("exports DaemonClient class", () => {
  assert.ok(clientSrc.includes("export class DaemonClient"));
});

test("exports DaemonError class", () => {
  assert.ok(clientSrc.includes("export class DaemonError extends Error"));
});

test("constructor takes daemonUrl, agentId, options", () => {
  assert.ok(clientSrc.includes("constructor(daemonUrl: string, agentId: string, options?"));
});

test("has hostId property derived from os.hostname()", () => {
  assert.ok(clientSrc.includes("this.hostId = options?.hostId || os.hostname()"));
});

test("has authToken for future Phase 2 auth", () => {
  assert.ok(clientSrc.includes("private authToken"));
  assert.ok(clientSrc.includes("Authorization"));
});

// ─── Error handling ──────────────────────────────────────────────

test("throws DaemonError on non-2xx responses", () => {
  assert.ok(clientSrc.includes("throw new DaemonError("));
  assert.ok(clientSrc.includes("if (!res.ok)"));
});

test("DaemonError has statusCode", () => {
  assert.ok(clientSrc.includes("public statusCode: number"));
});

// ─── Health ──────────────────────────────────────────────────────

test("has checkHealth method (not checkServer)", () => {
  assert.ok(clientSrc.includes("async checkHealth()"));
  assert.ok(!clientSrc.includes("async checkServer()"));
});

test("checkHealth uses GET /health", () => {
  assert.ok(clientSrc.includes('`${this.baseUrl}/health`'));
});

// ─── Agent Protocol ──────────────────────────────────────────────

test("has register method with opts object", () => {
  assert.ok(clientSrc.includes("async register(opts:"));
});

test("register sends id, name, hostId, directory, metadata", () => {
  assert.ok(clientSrc.includes("id: this.agentId"));
  assert.ok(clientSrc.includes("name: opts.name"));
  assert.ok(clientSrc.includes("hostId: this.hostId"));
  assert.ok(clientSrc.includes("directory: opts.directory"));
  assert.ok(clientSrc.includes("metadata: opts.metadata"));
});

test("has deregister method (DELETE /api/agents/:id)", () => {
  assert.ok(clientSrc.includes("async deregister()"));
  assert.ok(clientSrc.includes("DELETE"));
  assert.ok(clientSrc.includes("/api/agents/"));
});

test("has heartbeat method (never throws)", () => {
  assert.ok(clientSrc.includes("async heartbeat("));
  // Should catch errors internally
  assert.ok(clientSrc.match(/async heartbeat[\s\S]*?catch/));
});

test("heartbeat sends { id, status, currentTask }", () => {
  assert.ok(clientSrc.includes("id: this.agentId"));
});

test("has getNextWork method", () => {
  assert.ok(clientSrc.includes("async getNextWork()"));
});

test("has claimWorkItem method", () => {
  assert.ok(clientSrc.includes("async claimWorkItem(workItemId"));
});

test("does NOT have transitionTask method (removed)", () => {
  assert.ok(!clientSrc.includes("transitionTask"));
});

test("has setWorkItemState method (single COMPLETE/FAILED state-setter)", () => {
  assert.ok(clientSrc.includes("async setWorkItemState(workItemId"));
  assert.ok(clientSrc.includes('"COMPLETE" | "FAILED"'));
  assert.ok(clientSrc.includes("/state"));
});

// ─── Comments (not messages) ─────────────────────────────────────

test("has getComments method", () => {
  assert.ok(clientSrc.includes("async getComments(workItemId"));
});

test("has postComment method with agentId", () => {
  assert.ok(clientSrc.includes("async postComment(workItemId"));
  assert.ok(clientSrc.includes("agentId: this.agentId"));
});

test("uses /api/agents/comments/ routes (not /api/tasks/.../messages)", () => {
  assert.ok(clientSrc.includes("/api/agents/comments/"));
  // Task comments must not use a legacy "messages" route (assistant chat
  // legitimately uses /api/assistant/messages, so only forbid the task variant).
  assert.ok(!clientSrc.includes("/api/tasks/") || !/\/api\/tasks\/[^"`\s]*messages/.test(clientSrc));
});

// ─── Spawn Requests ──────────────────────────────────────────────

test("has getLeaderDirectives (uses this.hostId)", () => {
  assert.ok(clientSrc.includes("async getLeaderDirectives()"));
  assert.ok(clientSrc.includes("this.hostId"));
  assert.ok(clientSrc.includes("/leader/directives"));
});

test("has createLeaderDirective + completeLeaderDirective", () => {
  assert.ok(clientSrc.includes("async createLeaderDirective(action"));
  assert.ok(clientSrc.includes("async completeLeaderDirective(id"));
});

test("has failLeaderDirective for unrealizable directives", () => {
  assert.ok(clientSrc.includes("async failLeaderDirective(id"));
  assert.ok(clientSrc.includes('status: "failed"'));
});

// ─── Assistant Queue ─────────────────────────────────────────────

test("has getNextQueueItem (not getNextAssistantItem)", () => {
  assert.ok(clientSrc.includes("async getNextQueueItem()"));
  assert.ok(!clientSrc.includes("async getNextAssistantItem"));
});

test("has claimQueueItem (not claimAssistantItem)", () => {
  assert.ok(clientSrc.includes("async claimQueueItem(id"));
  assert.ok(!clientSrc.includes("async claimAssistantItem"));
});

test("has completeQueueItem (not completeAssistantItem)", () => {
  assert.ok(clientSrc.includes("async completeQueueItem(id"));
  assert.ok(!clientSrc.includes("async completeAssistantItem"));
});

// ─── Context Library ─────────────────────────────────────────────

// The daemon vends the assistant persona; the client reads the effective
// persona system prompt. It may also *read* the context library (list_context)
// and workflows (list_workflows) for planning, but never creates/edits context.
test("has getPersona method returning systemPrompt", () => {
  assert.ok(clientSrc.includes("async getPersona()"));
  assert.ok(clientSrc.includes("systemPrompt: string"));
});

test("has getScratchpad method (read-only)", () => {
  assert.ok(clientSrc.includes("async getScratchpad()"));
  assert.ok(clientSrc.includes('this.get("/api/scratchpad")'));
});

test("has read-only listWorkflows and listContext methods", () => {
  assert.ok(clientSrc.includes("async listWorkflows()"));
  assert.ok(clientSrc.includes('this.get<WorkflowSummary[]>("/api/workflows")'));
  assert.ok(clientSrc.includes("async listContext()"));
  assert.ok(clientSrc.includes('"/api/context"'));
});

test("createStory and createTask accept a context array", () => {
  assert.ok(clientSrc.includes("context?: string[]"));
  assert.ok(clientSrc.includes("createTask(storyId: string, title: string, description: string, context?: string[])"));
});

test("client does NOT expose context write/search methods", () => {
  assert.ok(!clientSrc.includes("async saveContext"));
  assert.ok(!clientSrc.includes("async saveNote"));
  assert.ok(!clientSrc.includes("async searchNotes"));
});

// ─── Stories / Tasks ─────────────────────────────────────────────

test("has createStory method", () => {
  assert.ok(clientSrc.includes("async createStory(story"));
});

test("has updateStory method", () => {
  assert.ok(clientSrc.includes("async updateStory(storyId"));
});

test("has createTask method (not addTask)", () => {
  assert.ok(clientSrc.includes("async createTask(storyId"));
  assert.ok(!clientSrc.includes("async addTask("));
});

test("has uploadAttachment method", () => {
  assert.ok(clientSrc.includes("async uploadAttachment(workItemId"));
});

test("has enqueueAssistantRequest method", () => {
  assert.ok(clientSrc.includes("async enqueueAssistantRequest(prompt"));
});

test("register forwards opaque metadata", () => {
  assert.ok(clientSrc.includes("metadata: opts.metadata"));
});

test("has directive poll + complete (single leader channel)", () => {
  assert.ok(clientSrc.includes("async getLeaderDirectives()"));
  assert.ok(clientSrc.includes("async completeLeaderDirective("));
});

// ─── Response types ──────────────────────────────────────────────

test("AgentNextWorkResponse is slimmed to id, storyId, title", () => {
  assert.ok(clientSrc.includes("id: string"));
  assert.ok(clientSrc.includes("storyId: string"));
  assert.ok(clientSrc.includes("title: string"));
  // Should NOT include heavy fields
  assert.ok(!clientSrc.match(/AgentNextWorkResponse[\s\S]*?availableTransitions/));
});

test("AgentClaimResponse carries the assembled prompt and task metadata", () => {
  // The daemon now delivers the full prose in `prompt`; structured task
  // metadata is minimal bookkeeping (id/storyId/status).
  assert.ok(clientSrc.includes("prompt?: string"));
  assert.ok(clientSrc.includes("status: string"));
});

test("AgentReleaseResponse includes newStatus and completed", () => {
  assert.ok(clientSrc.includes("newStatus?: string"));
  assert.ok(clientSrc.includes("completed?: boolean"));
});

test("CommentsResponse has correct shape", () => {
  assert.ok(clientSrc.includes("comments: Array<"));
});

// ─── No server-side dependencies ─────────────────────────────────

test("does not import better-sqlite3", () => {
  assert.ok(!clientSrc.includes("better-sqlite3"));
});

test("does not import hono", () => {
  assert.ok(!clientSrc.includes("hono"));
});

test("only imports os and shared/types", () => {
  const imports = clientSrc.match(/^import .+ from .+$/gm) || [];
  assert.ok(imports.length === 2, `Expected 2 imports, got ${imports.length}: ${imports.join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
