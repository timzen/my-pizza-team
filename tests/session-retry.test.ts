/**
 * tests/session-retry.test.ts — Errored agent sessions are retried, not completed
 * (docs/DESIGN.md "Errored Sessions Retry").
 *
 * When a teammate's model call fails (stopReason "error": a Bedrock 503, missing
 * credentials) the harness fails the WorkItem with a `sessionError`. The daemon:
 *
 * - posts `[retry] Attempt n/N failed: …`, marks the attempt FAILED + read, and
 *   enqueues attempt n+1 held until its backoff passes and the team is ready
 * - on success of a retry, completes normally (a board task advances)
 * - once retries run out, leaves the item FAILED + unread (Inbox) with
 *   `[failed] <error> after N attempts`
 * - works the same for board tasks and Solitary/Scheduled WorkDefs
 * - a plain FAILED (the agent gave up) is never retried
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { assert, assertEquals, assertExists, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { resolveRetry, retryBackoffMs, type TeamConfig, type WorkItem } from "../shared/types.ts";
import * as path from "node:path";

const ERR = "Service unavailable: Bedrock is unable to process your request.";
const MIN = 60_000;

function setup(overrides: Partial<TeamConfig> = {}) {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-retry-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), ...overrides };
  const store = new Store(teamDir, config);
  store.registerMember("m1", "firm-odo");
  const cleanup = () => { store.close(); try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* */ } };
  return { store, config, teamDir, cleanup };
}

/** A Solitary WorkDef, claimed by m1. */
function claimedSolitary(store: Store): { defId: string; item: WorkItem } {
  const def = store.createWorkDef({ title: "Weekly update", goal: "g", acceptanceCriteria: "a" });
  const item = store.getNextWorkItem({ id: "m1" })!;
  assertEquals(item.ref.workDefId, def.id);
  assertEquals(store.claimWorkItem(item.id, "m1"), true);
  return { defId: def.id, item };
}

const bodies = (store: Store, workDefId: string) => store.getCommentsForRef({ workDefId }).map((c) => c.body);

test("resolveRetry: defaults to 3 retries at 1m/5m/15m; the last backoff repeats", () => {
  const p = resolveRetry({});
  assertEquals(p, { maxRetries: 3, backoffMinutes: [1, 5, 15] });
  assertEquals(retryBackoffMs(p, 1), 1 * MIN);
  assertEquals(retryBackoffMs(p, 3), 15 * MIN);
  assertEquals(retryBackoffMs(p, 9), 15 * MIN);
  assertEquals(resolveRetry({ retry: { maxRetries: -1, backoffMinutes: [] } }), { maxRetries: 3, backoffMinutes: [1, 5, 15] });
  assertEquals(resolveRetry({ retry: { maxRetries: 0 } }).maxRetries, 0);
});

test("session error → [retry] comment, attempt FAILED+read, a held READY retry (not COMPLETE)", () => {
  const { store, cleanup } = setup();
  try {
    const { defId, item } = claimedSolitary(store);
    const now = Date.now();
    const res = store.failWorkItemForSessionError(item.id, ERR, now);
    assertEquals(res.ok, true);
    assertExists(res.retry);
    assertEquals(res.retry.attempt, 2);
    assertEquals(res.retry.maxAttempts, 4);

    const old = store.getWorkItem(item.id)!;
    assertEquals(old.state, "FAILED");
    assertEquals(old.read, true); // not Inbox news — the retry is
    assertEquals(old.error, ERR);

    const retry = store.getWorkItem(res.retry.workItemId)!;
    assertEquals(retry.state, "READY");
    assertEquals(retry.attempt, 2);
    assertEquals(Date.parse(retry.retryAt!), now + 1 * MIN);

    const comments = bodies(store, defId);
    assert(!comments.some((b) => b.startsWith("[done]")), "an errored session must not post [done]");
    const last = comments.at(-1)!;
    assert(last.startsWith("[retry] Attempt 1/4 failed:"), last);
    assertStringIncludes(last, ERR);
    assertStringIncludes(last, "attempt 2/4");
    assertStringIncludes(last, "1m");

    // Held through its backoff, handed out after it.
    assertEquals(store.getNextWorkItem({ id: "m1" }, now + 30_000), null);
    assertEquals(store.getNextWorkItem({ id: "m1" }, now + 61_000)?.id, retry.id);
  } finally { cleanup(); }
});

test("a due retry waits for the readiness probe to report ready", () => {
  const { store, cleanup } = setup();
  try {
    const { item } = claimedSolitary(store);
    const now = Date.now();
    const res = store.failWorkItemForSessionError(item.id, "Could not load credentials from any providers", now);
    store.setTeamReadiness(false, "credentials expired");
    assertEquals(store.getNextWorkItem({ id: "m1" }, now + 2 * MIN), null);
    store.setTeamReadiness(true);
    assertEquals(store.getNextWorkItem({ id: "m1" }, now + 2 * MIN)?.id, res.retry!.workItemId);
  } finally { cleanup(); }
});

test("success after a retry → COMPLETE and the board task advances", () => {
  const { store, cleanup } = setup();
  try {
    store.createStory("rs", "Retry story", "D", "open", [], [{ title: "T1", description: "D1" }]);
    const first = store.getNextWorkItem({ id: "m1" })!;
    store.claimWorkItem(first.id, "m1");
    const now = Date.now();
    const res = store.failWorkItemForSessionError(first.id, ERR, now);
    // The task keeps its position while its retry waits.
    assertEquals(store.getTask("rs-1")!.status, "in_progress");
    assertEquals(store.getActiveWorkItemForTask("rs-1")?.id, res.retry!.workItemId);

    const second = store.getNextWorkItem({ id: "m1" }, now + 2 * MIN)!;
    assertEquals(second.id, res.retry!.workItemId);
    assertEquals(store.claimWorkItem(second.id, "m1"), true);
    const done = store.setWorkItemState(second.id, "COMPLETE");
    assertEquals(done.ok, true);
    assertEquals(store.getWorkItem(second.id)!.state, "COMPLETE");
    assertEquals(store.getTask("rs-1")!.status, "review");
  } finally { cleanup(); }
});

test("retries exhausted → FAILED, unread (Inbox), with a [failed] comment carrying the error", () => {
  const { store, cleanup } = setup({ retry: { maxRetries: 2, backoffMinutes: [1] } });
  try {
    const { defId, item } = claimedSolitary(store);
    let current = item;
    let now = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = store.failWorkItemForSessionError(current.id, ERR, now);
      assertEquals(res.retry?.attempt, attempt + 1);
      now += 2 * MIN;
      current = store.getNextWorkItem({ id: "m1" }, now)!;
      assertEquals(current.attempt, attempt + 1);
      store.claimWorkItem(current.id, "m1");
    }
    const last = store.failWorkItemForSessionError(current.id, ERR, now);
    assertEquals(last.ok, true);
    assertEquals(last.retry, undefined);

    const final = store.getWorkItem(current.id)!;
    assertEquals(final.state, "FAILED");
    assertEquals(final.read, false);
    assertEquals(store.getActiveWorkItemForTask(defId), null);
    // Exactly one unread item for this run: the final failure.
    const unread = store.getWorkItems({ states: ["COMPLETE", "FAILED"], read: false }).items;
    assertEquals(unread.map((i) => i.id), [final.id]);

    const comments = bodies(store, defId);
    assertEquals(comments.filter((b) => b.startsWith("[retry]")).length, 2);
    assertStringIncludes(comments.at(-1)!, `[failed] ${ERR} after 3 attempts`);
    assert(!comments.some((b) => b.startsWith("[done]")));
  } finally { cleanup(); }
});

test("maxRetries 0 fails on the first errored session", () => {
  const { store, cleanup } = setup({ retry: { maxRetries: 0 } });
  try {
    const { defId, item } = claimedSolitary(store);
    const res = store.failWorkItemForSessionError(item.id, ERR);
    assertEquals(res.retry, undefined);
    assertEquals(store.getWorkItem(item.id)!.state, "FAILED");
    assertStringIncludes(bodies(store, defId).at(-1)!, "after 1 attempt.");
  } finally { cleanup(); }
});

test("a plain FAILED (the agent gave up) is not retried; a successful empty completion is unaffected", () => {
  const { store, cleanup } = setup();
  try {
    const a = claimedSolitary(store);
    store.setWorkItemState(a.item.id, "FAILED");
    assertEquals(store.getActiveWorkItemForTask(a.defId), null);

    const b = claimedSolitary(store);
    assertEquals(store.setWorkItemState(b.item.id, "COMPLETE").ok, true);
    assertEquals(store.getWorkItem(b.item.id)!.state, "COMPLETE");
    assertEquals(store.getWorkItem(b.item.id)!.attempt, 1);
    assertEquals(store.getActiveWorkItemForTask(b.defId), null);
  } finally { cleanup(); }
});

test("route: FAILED + sessionError retries and reports it; /api/work-items shows attempt/retryAt", async () => {
  const { store, config, teamDir, cleanup } = setup();
  try {
    const app = buildApp(store, config, teamDir);
    const { item } = claimedSolitary(store);
    const res = await app.request(`/api/agents/work-items/${item.id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "m1", state: "FAILED", sessionError: ERR }),
    });
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.retry.attempt, 2);

    const list = await (await app.request("/api/work-items?state=READY")).json();
    const view = list.items.find((i: { id: string }) => i.id === body.retry.workItemId);
    assertEquals(view.attempt, 2);
    assertExists(view.retryAt);
    const failed = await (await app.request(`/api/work-items/${item.id}`)).json();
    assertEquals(failed.item.error, ERR);
  } finally { cleanup(); }
});
