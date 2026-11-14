/**
 * tests/failover.test.ts — Model error kinds and the team-wide model failover
 * (docs/DESIGN.md "Model Failover"; shared/agent-protocol.ts
 * `classifyModelError`, shared/failover.ts, daemon/failover.ts).
 *
 * On a fake clock (`store.clock`): the daemon's fallback classification of
 * real error texts and the kind recorded on the attempt and in its comment;
 * the trip threshold and window; the substitute sent for a pin, a persona's
 * model and the team default (and, for an older harness, only when its model
 * failed); retries held in backoff released at once; escalation through the
 * chain to exhaustion; the half-open revert's success and failure; the state
 * surviving a restart; "End failover now"; auth/context never tripping; the
 * policy's validation; and, switched off, today's behavior unchanged.
 */

import { test } from "node:test";
import { assert, assertEquals, assertExists, assertStringIncludes } from "./_assert.ts";
import { makeTeam, withTeam, get, post, type App, type Team } from "./_team.ts";
import { Store } from "../daemon/store.ts";
import { classifyModelError, MODEL_FAILOVER_CAPABILITY, SET_MODEL_CAPABILITY, type FailoverView } from "../shared/protocol.ts";
import { validateFailover, resolveChainEntry } from "../shared/failover.ts";
import { resolveFailover, type FailoverConfig, type TeamConfig, type WorkItem } from "../shared/types.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-03-01T12:00:00Z");
const THROTTLE = "Throttling error: Too many requests, please wait before trying again.";
const UNAVAILABLE = "Service unavailable: Bedrock is unable to process your request.";
const MODERN = [SET_MODEL_CAPABILITY, MODEL_FAILOVER_CAPABILITY];

/** A policy on: A → B → C, two failures in 10 minutes trip it, probe after 30. */
const POLICY: FailoverConfig = { enabled: true, on: ["throttle", "5xx"], after: 2, windowMinutes: 10, chain: ["acme/a", "acme/b", "acme/c"], revertAfterMinutes: 30 };

/** A team on a fake clock with the policy (or `failover` given), and teammates m1, m2 registered as modern Pi harnesses. */
function team(failover: FailoverConfig | null = POLICY, extra: Partial<TeamConfig> = {}): Team & { clock: { now: number } } {
  const t = makeTeam({ ...(failover ? { failover } : {}), ...extra });
  const clock = { now: T0 };
  t.store.clock = () => clock.now;
  for (const id of ["m1", "m2"]) t.store.registerMember(id, `teammate-${id}`, "/tmp", {}, { harness: "pi", capabilities: MODERN });
  return Object.assign(t, { clock });
}

/** A Solitary WorkDef's item, claimed by `memberId`. */
function claimed(store: Store, memberId = "m1", title = "Job"): WorkItem {
  const def = store.createWorkDef({ title, goal: "g", acceptanceCriteria: "a" });
  const item = store.getActiveWorkItem(def.id)!;
  assert(store.claimWorkItem(item.id, memberId), "claimed");
  return item;
}

/** Pin `model` on an agent the way a user does: a user set-model, reported done. */
function pin(store: Store, memberId: string, model: string): void {
  const res = store.requestModelChange(memberId, { model, source: "user" });
  assert("directive" in res, "requested");
  if ("directive" in res) store.completeMemberDirective(res.directive.id, "done");
}

/** Fail `item` as an errored session on `model` (as the route does), at the fake clock. */
function fail(t: ReturnType<typeof team>, item: WorkItem, text = THROTTLE, model: string | null = "acme/a", memberId = "m1") {
  const res = t.store.failWorkItemForSessionError(item.id, text, t.clock.now);
  return { res, outcome: t.store.failover.recordFailure({ memberId, workItemId: item.id, kind: res.errorKind ?? "other", model }) };
}

type Directive = { id: string; action: string; params: Record<string, unknown> };
/** The pending set-model directives for an agent. */
async function setModels(app: App, id: string): Promise<Directive[]> {
  const res = await (await get(app, `/api/agents/${id}/directives`)).json() as { directives: Directive[] };
  return res.directives.filter((d) => d.action === "set-model");
}

// ─── Error kinds ─────────────────────────────────────────────────────

test("classifyModelError: the daemon's fallback on the real messages, statuses and the other kinds", () => {
  assertEquals(classifyModelError(THROTTLE), "throttle");
  assertEquals(classifyModelError(UNAVAILABLE), "5xx");
  assertEquals(classifyModelError("ThrottlingException: Too many tokens, please wait before trying again."), "throttle", "throttle beats the context words");
  assertEquals(classifyModelError("anything", 429), "throttle");
  assertEquals(classifyModelError("upstream said no", 502), "5xx");
  assertEquals(classifyModelError("acme API error (503): busy"), "5xx");
  assertEquals(classifyModelError("Could not load credentials from any providers"), "auth");
  assertEquals(classifyModelError("The security token included in the request is expired"), "auth");
  assertEquals(classifyModelError("prompt is too long: 210000 tokens > 200000 maximum"), "context");
  assertEquals(classifyModelError("The model call failed (no error message)"), "other");
});

test("the attempt records its error kind (daemon fallback, or the harness's) and the retry comment names it", async () => {
  const t = team(null);
  try {
    const a = claimed(t.store);
    const res = t.store.failWorkItemForSessionError(a.id, THROTTLE, t.clock.now);
    assertEquals(res.errorKind, "throttle");
    assertEquals(t.store.getWorkItem(a.id)!.errorKind, "throttle");
    const comments = t.store.getCommentsForRef(a.ref).map((c) => c.body);
    assertStringIncludes(comments.at(-1)!, `failed: ${THROTTLE} (throttled). Retrying in`);

    // Through the route, the harness's kind wins over the text.
    const b = claimed(t.store, "m2", "Other");
    const r = await post(t.app, `/api/agents/work-items/${b.id}/state`, { agentId: "m2", state: "FAILED", sessionError: "odd words", errorKind: "5xx" });
    assertEquals(r.status, 200);
    assertEquals(t.store.getWorkItem(b.id)!.errorKind, "5xx");
    assertStringIncludes(t.store.getCommentsForRef(b.ref).map((c) => c.body).at(-1)!, "(server error (5xx))");
    const view = (await (await get(t.app, "/api/work-items?states=FAILED")).json() as { items?: Array<{ id: string; errorKind?: string }> });
    if (view.items) assertEquals(view.items.find((i) => i.id === b.id)?.errorKind, "5xx");
  } finally { t.cleanup(); }
});

// ─── Policy ──────────────────────────────────────────────────────────

test("policy: defaults, validation (auth/context refused), and alias resolution of chain entries", () => {
  assertEquals(resolveFailover({}), { enabled: false, on: ["throttle", "5xx"], after: 2, windowMinutes: 10, chain: [], revertAfterMinutes: 30 });
  assertEquals(resolveFailover({ failover: { enabled: true, on: ["auth", "context"] as never, after: 0 } }).on, ["throttle", "5xx"], "auth/context filtered out");
  assertEquals(validateFailover({ ...POLICY, chain: [" acme/a ", "", "acme/b"] }), { value: { ...POLICY, chain: ["acme/a", "acme/b"] } });
  for (const bad of [[], "x", { on: ["auth"] }, { on: ["context"] }, { on: ["nope"] }, { after: 0 }, { windowMinutes: 1.5 },
    { chain: "a" }, { chain: ["a", "a"] }, { enabled: true, chain: ["only"] }, { surprise: 1 }]) {
    assert("error" in validateFailover(bad), JSON.stringify(bad));
  }
  const config = { modelAliases: { pi: { fast: "acme/fast" } } };
  assertEquals(resolveChainEntry(config, "fast", "pi"), "acme/fast");
  assertEquals(resolveChainEntry(config, "fast", "kiro"), "fast");
  assertEquals(resolveChainEntry(config, "acme/x", "pi"), "acme/x");
});

test("PUT /api/config saves, keeps and clears the policy, and refuses a bad one", async () => {
  await withTeam({}, async ({ app, config }) => {
    const current = await (await app.request("/api/config")).json();
    const save = (over: Record<string, unknown>) => app.request("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...current, ...over }) });
    assertEquals((await save({ failover: POLICY })).status, 200);
    assertEquals(config.failover, POLICY);
    assertEquals((await save({})).status, 200);
    assertEquals(config.failover, POLICY, "absent keeps it");
    assertEquals((await save({ failover: { ...POLICY, on: ["auth"] } })).status, 400);
    assertEquals((await save({ failover: null })).status, 200);
    assertEquals(config.failover, undefined);
  });
});

// ─── Trip ────────────────────────────────────────────────────────────

test("trip: `after` failures on the current model within the window, across agents; outside it they don't add up", () => {
  const t = team();
  try {
    assertEquals(fail(t, claimed(t.store, "m1", "1")).outcome, { action: "counted", failures: 1 });
    t.clock.now += 11 * MIN; // the first one has left the window
    assertEquals(fail(t, claimed(t.store, "m2", "2"), UNAVAILABLE, "acme/a", "m2").outcome, { action: "counted", failures: 1 });
    assertEquals(t.store.failover.active, false);
    // A failure on a model outside the chain (or one the team left) doesn't count.
    assertEquals(fail(t, claimed(t.store, "m1", "3"), THROTTLE, "acme/elsewhere").outcome, { action: "ignored" });
    t.clock.now += 2 * MIN;
    const { outcome } = fail(t, claimed(t.store, "m1", "4"));
    assertEquals(outcome.action, "tripped");
    const v = t.store.failover.view();
    assertEquals([v.active, v.from, v.to, v.replaces, v.trips.length, v.since], [true, "acme/a", "acme/b", ["acme/a"], 1, new Date(t.clock.now).toISOString()]);
    assertEquals(v.nextProbeAt, new Date(t.clock.now + 30 * MIN).toISOString());
  } finally { t.cleanup(); }
});

test("auth and context never trip, whatever the count", () => {
  const t = team({ ...POLICY, after: 1 });
  try {
    assertEquals(fail(t, claimed(t.store, "m1", "1"), "Could not load credentials from any providers").outcome, { action: "ignored" });
    assertEquals(fail(t, claimed(t.store, "m1", "2"), "prompt is too long: 300000 tokens > 200000 maximum").outcome, { action: "ignored" });
    assertEquals(t.store.failover.active, false);
  } finally { t.cleanup(); }
});

test("disabled (the default): failures are only retried as before — no state, no directives, claims unchanged", async () => {
  const t = team(null);
  try {
    for (let i = 0; i < 5; i++) assertEquals(fail(t, claimed(t.store, "m1", `j${i}`)).outcome, { action: "ignored" });
    assertEquals(t.store.failover.view().active, false);
    assertEquals(t.store.getSetting("failover.state"), null);
    assertEquals(await setModels(t.app, "m1"), []);
    assertEquals(t.store.failover.claimModel("m1", "wi-x", "acme/a"), { modelId: "acme/a" });
    const status = await (await get(t.app, "/api/status")).json() as { failover: FailoverView };
    assertEquals([status.failover.enabled, status.failover.active], [false, false]);
  } finally { t.cleanup(); }
});

// ─── Substitute ──────────────────────────────────────────────────────

test("substitute: a set-model (failover, replaces) to modern agents, pinned or not; an older harness only when its model failed", async () => {
  const t = team(POLICY, { defaultModel: { pi: "acme/a" } });
  try {
    pin(t.store, "m2", "acme/a"); // a pin on the failing model is substituted too
    t.store.registerMember("old-default", "teammate-old", "/tmp", {}, { harness: "pi", capabilities: [SET_MODEL_CAPABILITY] });
    t.store.registerMember("old-pinned-ok", "teammate-ok", "/tmp", {}, { harness: "pi", capabilities: [SET_MODEL_CAPABILITY] });
    pin(t.store, "old-pinned-ok", "acme/healthy");
    t.store.registerMember("ancient", "teammate-ancient", "/tmp", {}, { harness: "pi" });
    fail(t, claimed(t.store, "m1", "1"));
    fail(t, claimed(t.store, "m2", "2"), THROTTLE, "acme/a", "m2");
    assert(t.store.failover.active);
    for (const id of ["m1", "m2"]) {
      const [d] = await setModels(t.app, id);
      assertExists(d, id);
      assertEquals([d.params.model, d.params.source, d.params.replaces], ["acme/b", "failover", ["acme/a"]]);
    }
    // The older harness on the (failed) team default gets one, without `replaces`.
    const [old] = await setModels(t.app, "old-default");
    assertEquals([old?.params.model, old?.params.replaces], ["acme/b", undefined]);
    assertEquals(await setModels(t.app, "old-pinned-ok"), [], "its pinned model is healthy");
    assertEquals(await setModels(t.app, "ancient"), [], "can't switch models at all");
    // A failover ask doesn't cancel a user's pick still pending.
    t.store.requestModelChange("m1", { model: "acme/x", source: "user" });
    t.store.failover.onRegister("m1");
    assertEquals((await setModels(t.app, "m1")).map((d) => d.params.source).sort(), ["failover", "user"]);
  } finally { t.cleanup(); }
});

test("substitute: the claim's persona model (alias resolved) is replaced when it failed, kept when healthy", async () => {
  const t = team({ ...POLICY, chain: ["strong", "acme/b"] }, { modelAliases: { pi: { strong: "acme/a" } } });
  try {
    fail(t, claimed(t.store, "m1", "1"));
    fail(t, claimed(t.store, "m1", "2"));
    assertEquals(t.store.failover.view().to, "acme/b");
    assertEquals(t.store.failover.claimModel("m1", "wi-1", "acme/a"), { modelId: "acme/b" });
    assertEquals(t.store.failover.claimModel("m1", "wi-1", "acme/other"), { modelId: "acme/other" });
    assertEquals(t.store.failover.claimModel("m1", "wi-1", null), { modelId: null });
  } finally { t.cleanup(); }
});

test("a teammate registering while active is sent the substitute", async () => {
  const t = team();
  try {
    fail(t, claimed(t.store, "m1", "1"));
    fail(t, claimed(t.store, "m1", "2"));
    const res = await post(t.app, "/api/agents/register", { id: "m3", name: "teammate-m3", directory: "/tmp", harness: "pi", capabilities: MODERN });
    assertEquals(res.status, 200);
    assertEquals((await setModels(t.app, "m3")).map((d) => d.params.model), ["acme/b"]);
  } finally { t.cleanup(); }
});

// ─── Retry now ───────────────────────────────────────────────────────

test("retry now: retries held after throttle/5xx are released on a trip (same attempt number); others keep their backoff", () => {
  const t = team({ ...POLICY, after: 3 });
  try {
    const authItem = claimed(t.store, "m2", "auth");
    const authRetry = t.store.failWorkItemForSessionError(authItem.id, "Could not load credentials from any providers", t.clock.now).retry!;
    const a = fail(t, claimed(t.store, "m1", "1")).res.retry!;
    const b = fail(t, claimed(t.store, "m1", "2"), UNAVAILABLE).res.retry!;
    assert(Date.parse(a.retryAt) > t.clock.now, "held in backoff before the trip");
    t.clock.now += MIN / 2;
    const { res, outcome } = fail(t, claimed(t.store, "m1", "3"));
    assertEquals(outcome.action, "tripped");
    if (outcome.action !== "tripped") return;
    assertEquals(outcome.released.sort(), [a.workItemId, b.workItemId, res.retry!.workItemId].sort());
    for (const id of outcome.released) {
      const wi = t.store.getWorkItem(id)!;
      assertEquals([wi.state, Date.parse(wi.retryAt!), wi.attempt], ["READY", t.clock.now, 2]);
    }
    assertEquals(t.store.getWorkItem(authRetry.workItemId)!.retryAt, authRetry.retryAt, "an auth retry keeps its backoff");
    assertExists(t.store.getNextWorkItem({ id: "m1" }, t.clock.now), "handed out now");
  } finally { t.cleanup(); }
});

// ─── Escalate ────────────────────────────────────────────────────────

test("escalate: the substitute tripping moves down the chain; at the end the team stays on the last entry", async () => {
  const t = team();
  try {
    fail(t, claimed(t.store, "m1", "1"));
    fail(t, claimed(t.store, "m1", "2"));
    assertEquals(t.store.failover.view().to, "acme/b");
    // Failures still on A (an agent that hadn't switched yet) don't move it on.
    assertEquals(fail(t, claimed(t.store, "m1", "3")).outcome, { action: "ignored" });
    fail(t, claimed(t.store, "m1", "4"), THROTTLE, "acme/b");
    assertEquals(fail(t, claimed(t.store, "m1", "5"), THROTTLE, "acme/b").outcome.action, "tripped");
    const v = t.store.failover.view();
    assertEquals([v.to, v.replaces, v.trips.map((x) => `${x.from}>${x.to}`)], ["acme/c", ["acme/a", "acme/b"], ["acme/a>acme/b", "acme/b>acme/c"]]);
    assertEquals((await setModels(t.app, "m1"))[0]?.params.replaces, ["acme/a", "acme/b"], "the newest ask supersedes the last");
    fail(t, claimed(t.store, "m1", "6"), THROTTLE, "acme/c");
    assertEquals(fail(t, claimed(t.store, "m1", "7"), THROTTLE, "acme/c").outcome, { action: "exhausted" });
    const after = t.store.failover.view();
    assertEquals([after.active, after.to, after.exhausted], [true, "acme/c", true]);
  } finally { t.cleanup(); }
});

// ─── Revert ──────────────────────────────────────────────────────────

/** A team that tripped A → B at T0. */
function tripped() {
  const t = team();
  fail(t, claimed(t.store, "m1", "1"));
  fail(t, claimed(t.store, "m1", "2"));
  assert(t.store.failover.active, "tripped");
  return t;
}

test("revert: once the timer is up, the next claim by a capable agent probes the primary; success ends the failover", async () => {
  const t = tripped();
  try {
    assertEquals(t.store.failover.claimModel("m1", "early", "acme/a").probe, undefined, "not before revertAfterMinutes");
    t.clock.now += 31 * MIN;
    t.store.registerMember("old", "teammate-old", "/tmp", {}, { harness: "pi", capabilities: [SET_MODEL_CAPABILITY] });
    assertEquals(t.store.failover.claimModel("old", "x", null).probe, undefined, "an older harness is never the probe");
    // Through the claim route: the probe runs on the primary.
    const def = t.store.createWorkDef({ title: "probe", goal: "g", acceptanceCriteria: "a" });
    const item = t.store.getActiveWorkItem(def.id)!;
    const claim = await (await post(t.app, `/api/agents/claim/${item.id}`, { agentId: "m2" })).json() as { failoverProbe?: { modelId: string } };
    assertEquals(claim.failoverProbe, { modelId: "acme/a" });
    assertEquals(t.store.failover.view().probe?.workItemId, item.id);
    assertEquals(t.store.failover.claimModel("m1", "other", "acme/a"), { modelId: "acme/b" }, "one probe at a time; others still substituted");
    const done = await post(t.app, `/api/agents/work-items/${item.id}/state`, { agentId: "m2", state: "COMPLETE" });
    assertEquals(done.status, 200);
    const v = t.store.failover.view();
    assertEquals([v.active, v.to, v.trips.length], [false, null, 0]);
    for (const id of ["m1", "m2"]) {
      assertEquals((await setModels(t.app, id)).map((d) => [d.params.model, d.params.source]), [[null, "failover"]], `${id} cleared`);
    }
  } finally { t.cleanup(); }
});

test("revert: a probe failing with throttle/5xx re-arms the timer; an inconclusive ending probes again", () => {
  const t = tripped();
  try {
    t.clock.now += 31 * MIN;
    const p = claimed(t.store, "m1", "probe");
    assertExists(t.store.failover.claimModel("m1", p.id, null).probe);
    assertEquals(fail(t, p, THROTTLE, "acme/a").outcome, { action: "probe-failed", nextProbeAt: t.clock.now + 30 * MIN });
    assert(t.store.failover.active, "still on the substitute");
    assertEquals(t.store.failover.claimModel("m1", "next", null).probe, undefined, "not until the timer is up again");
    t.clock.now += 31 * MIN;
    const q = claimed(t.store, "m2", "probe2");
    assertExists(t.store.failover.claimModel("m2", q.id, null).probe);
    assertEquals(fail(t, q, "Could not load credentials from any providers", "acme/a", "m2").outcome, { action: "probe-inconclusive" });
    assertExists(t.store.failover.claimModel("m1", "again", null).probe, "the next claim probes again");
  } finally { t.cleanup(); }
});

// ─── Persistence, manual end ─────────────────────────────────────────

test("the state survives a daemon restart", () => {
  const t = tripped();
  try {
    const before = t.store.failover.view();
    // A second Store on the same state.db is what a restarted daemon opens.
    const reopened = new Store(t.teamDir, t.config);
    try {
      reopened.clock = () => t.clock.now;
      const after = reopened.failover.view();
      assertEquals([after.active, after.to, after.since, after.nextProbeAt, after.trips], [before.active, before.to, before.since, before.nextProbeAt, before.trips]);
    } finally { reopened.close(); }
  } finally { t.cleanup(); }
});

test("End failover now (POST /api/failover/end) ends it at once; GET /api/failover and /api/status report it", async () => {
  const t = tripped();
  try {
    const got = await (await get(t.app, "/api/failover")).json() as FailoverView;
    assertEquals([got.active, got.from, got.to], [true, "acme/a", "acme/b"]);
    const status = await (await get(t.app, "/api/status")).json() as { failover: FailoverView };
    assertEquals(status.failover.to, "acme/b");
    const res = await (await post(t.app, "/api/failover/end", {})).json() as { success: boolean; failover: FailoverView };
    assertEquals([res.success, res.failover.active], [true, false]);
    assertEquals(t.store.getSetting("failover.state"), null);
    assertEquals((await setModels(t.app, "m1")).map((d) => d.params.model), [null]);
  } finally { t.cleanup(); }
});

test("switching the policy off ends an active failover", () => {
  const t = tripped();
  try {
    t.config.failover = { ...POLICY, enabled: false };
    assertEquals(t.store.failover.view().active, false);
  } finally { t.cleanup(); }
});
