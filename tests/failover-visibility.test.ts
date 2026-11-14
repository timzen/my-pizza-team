/**
 * tests/failover-visibility.test.ts — What a team-wide model failover shows
 * the people watching (docs/DESIGN.md "Model Failover", "What you see";
 * daemon/failover-notes.ts, shared/failover.ts `failoverLine`).
 *
 * The Team tab's banner (lib/models.ts `failoverBanner`, active and inactive,
 * plus source checks that it renders on the Team tab and the phone and never
 * on the rows); the thread comments — a retry moved to the substitute is told
 * once per thread and chain entry, the probe that reverts it is told too; the
 * Inbox's notes — one per episode, a line per trip / escalation / exhaustion /
 * end, never one per agent, unread until marked and counted in the Inbox
 * badge; and `mpt status`'s failover line. On a fake clock (`store.clock`).
 */

import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { makeTeam, get, post, type Team } from "./_team.ts";
import { Store } from "../daemon/store.ts";
import { MODEL_FAILOVER_CAPABILITY, SET_MODEL_CAPABILITY, type FailoverNotesResponse, type FailoverView } from "../shared/protocol.ts";
import type { FailoverConfig, WorkItem } from "../shared/types.ts";
import { failoverBanner } from "../ui/src/lib/models.ts";
import { statusSummaryLines } from "../cli/features.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-03-01T12:00:00Z");
const THROTTLE = "Throttling error: Too many requests, please wait before trying again.";
const POLICY: FailoverConfig = { enabled: true, on: ["throttle", "5xx"], after: 2, windowMinutes: 10, chain: ["acme/a", "acme/b", "acme/c"], revertAfterMinutes: 30 };
/** A fixed clock rendering for the lines: the ISO time's HH:MM in UTC. */
const hhmm = (iso: string) => iso.slice(11, 16);

/** A team on a fake clock with the policy, and modern teammates m1, m2. */
function team(): Team & { clock: { now: number } } {
  const t = makeTeam({ failover: POLICY });
  const clock = { now: T0 };
  t.store.clock = () => clock.now;
  for (const id of ["m1", "m2"]) t.store.registerMember(id, `teammate-${id}`, "/tmp", {}, { harness: "pi", capabilities: [SET_MODEL_CAPABILITY, MODEL_FAILOVER_CAPABILITY] });
  return Object.assign(t, { clock });
}

/** A Solitary WorkDef's item, claimed by `memberId`. */
function claimed(store: Store, memberId = "m1", title = "Job"): WorkItem {
  const def = store.createWorkDef({ title, goal: "g", acceptanceCriteria: "a" });
  const item = store.getActiveWorkItem(def.id)!;
  assert(store.claimWorkItem(item.id, memberId), "claimed");
  return item;
}

/** Fail `item` as an errored session on `model` (as the route does). */
function fail(t: ReturnType<typeof team>, item: WorkItem, model = "acme/a", memberId = "m1") {
  const res = t.store.failWorkItemForSessionError(item.id, THROTTLE, t.clock.now);
  const outcome = t.store.failover.recordFailure({ memberId, workItemId: item.id, kind: res.errorKind ?? "other", model });
  return { res, outcome };
}

/** The `[failover]` comments on an item's thread. */
function failoverComments(store: Store, item: WorkItem): string[] {
  return store.getCommentsForRef(item.ref).map((c) => c.body).filter((b) => b.startsWith("[failover]"));
}

const UI = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../ui/src", rel), "utf8");

// ─── The banner ──────────────────────────────────────────────────────

test("banner: nothing while inactive; one line — from → to since when (kind) — while active", () => {
  const idle: FailoverView = { enabled: true, active: false, from: null, to: null, replaces: [], since: null, trips: [], nextProbeAt: null, probe: null, exhausted: false, recentFailures: 0 };
  assertEquals(failoverBanner(undefined), null, "no answer yet");
  assertEquals(failoverBanner(idle), null);
  const active: FailoverView = {
    ...idle, active: true, from: "acme/a", to: "acme/b", replaces: ["acme/a"], since: "2026-03-01T12:00:00.000Z",
    trips: [{ at: "2026-03-01T12:00:00.000Z", from: "acme/a", to: "acme/b", kind: "throttle", failures: 2 }],
    nextProbeAt: "2026-03-01T12:30:00.000Z",
  };
  const b = failoverBanner(active, T0, hhmm)!;
  assertEquals(b.text, "Failover: acme/a → acme/b since 12:00 (throttle)");
  assertStringIncludes(b.detail, "acme/a is tried again in 30 min.");
  const escalated = { ...active, to: "acme/c", exhausted: true, trips: [...active.trips, { ...active.trips[0]!, from: "acme/b", to: "acme/c", kind: "5xx" as const }] };
  assertEquals(failoverBanner(escalated, T0, hhmm)!.text, "Failover: acme/a → acme/c since 12:00 (5xx) — acme/c is failing too (end of the chain)");
});

test("banner: on top of the Team tab with a Config → Models link and End now; the phone's one-line notice; not on the rows", () => {
  const banner = UI("components/team/FailoverBanner.tsx");
  assertStringIncludes(banner, `to="/config/models"`);
  assertStringIncludes(banner, `"End now"`);
  assertStringIncludes(banner, `apiPost<EndFailoverResponse>("/api/failover/end")`);
  assertStringIncludes(banner, "if (!banner) return null;");
  const panel = UI("components/team/TeamPanel.tsx");
  assert(panel.indexOf("<FailoverBanner />") < panel.indexOf("<TeammateRow"), "above the rows");
  assertStringIncludes(UI("mobile/MobileTeam.tsx"), "<FailoverBanner compact />");
  assert(!/failover/i.test(UI("components/team/TeamParts.tsx")), "nothing on the individual rows");
});

// ─── Thread comments ─────────────────────────────────────────────────

test("comments: a retry moved to the substitute is told once per thread; the probe that reverts it is told too", async () => {
  const t = team();
  try {
    const first = claimed(t.store, "m1", "1");
    const retry = fail(t, first).res.retry!;
    assertEquals(fail(t, claimed(t.store, "m1", "2")).outcome.action, "tripped");
    // Claimed through the route: the retry runs on acme/b.
    const claim = await post(t.app, `/api/agents/claim/${retry.workItemId}`, { agentId: "m2" });
    assertEquals(claim.status, 200);
    assertEquals(failoverComments(t.store, first), ["[failover] retried on acme/b after throttle on acme/a"]);
    // Claimed again, or retried again on the same chain entry: still once.
    t.store.failover.claimModel("m2", retry.workItemId, null);
    const again = fail(t, t.store.getWorkItem(retry.workItemId)!, "acme/b", "m2").res.retry!;
    assert(t.store.claimWorkItem(again.workItemId, "m1"), "claimed");
    t.store.failover.claimModel("m1", again.workItemId, null);
    assertEquals(failoverComments(t.store, first).length, 1, "once per thread");
    // A first attempt isn't a retry: nothing.
    const fresh = claimed(t.store, "m2", "fresh");
    t.store.failover.claimModel("m2", fresh.id, null);
    assertEquals(failoverComments(t.store, fresh), []);

    // The revert: the probe's thread says so.
    t.clock.now += 31 * MIN;
    const probe = claimed(t.store, "m1", "probe");
    assert(t.store.failover.claimModel("m1", probe.id, null).probe, "the probe");
    await post(t.app, `/api/agents/work-items/${probe.id}/state`, { agentId: "m1", state: "COMPLETE" });
    assertEquals(t.store.failover.active, false);
    assertEquals(failoverComments(t.store, probe), ["[failover] reverted: acme/a works again on this run (the probe), so the team is back on it"]);
  } finally { t.cleanup(); }
});

// ─── The Inbox note ──────────────────────────────────────────────────

test("Inbox: one note per episode — a line per trip, escalation, exhaustion and end, not one per agent", async () => {
  const t = team();
  try {
    fail(t, claimed(t.store, "m1", "1"));
    fail(t, claimed(t.store, "m2", "2"), "acme/a", "m2");
    let notes = t.store.failoverNotes.list();
    assertEquals(notes.length, 1);
    assertEquals(notes[0]!.lines.map((l) => l.text), ["Failover: the team switched from acme/a to acme/b after 2 throttle failures."]);
    assertEquals([notes[0]!.read, notes[0]!.ended], [false, false]);

    // Read, then escalated: the same note, unread again.
    assertEquals((await post(t.app, `/api/failover/notes/${notes[0]!.id}/read`)).status, 200);
    assertEquals(t.store.failoverNotes.unreadCount(), 0);
    t.clock.now += MIN;
    fail(t, claimed(t.store, "m1", "3"), "acme/b");
    fail(t, claimed(t.store, "m2", "4"), "acme/b", "m2");
    fail(t, claimed(t.store, "m1", "5"), "acme/c");
    fail(t, claimed(t.store, "m1", "6"), "acme/c");
    fail(t, claimed(t.store, "m1", "7"), "acme/c");
    fail(t, claimed(t.store, "m1", "8"), "acme/c");
    await post(t.app, "/api/failover/end", {});
    notes = t.store.failoverNotes.list();
    assertEquals(notes.length, 1, "still one note");
    assertEquals(notes[0]!.lines.map((l) => l.text), [
      "Failover: the team switched from acme/a to acme/b after 2 throttle failures.",
      "Escalated: acme/b → acme/c after 2 throttle failures.",
      "acme/c is failing too (throttle): it is the end of the chain, so the team stays on it.",
      "Ended: the team is back on acme/a — failover ended by hand (End failover now).",
    ], "exhausted once, however many more failures");
    assertEquals([notes[0]!.read, notes[0]!.ended], [false, true]);

    // The routes and the Inbox badge.
    const status = await (await get(t.app, "/api/status")).json() as { unreadInboxCount: number };
    const unreadItems = t.store.countWorkItems({ states: ["COMPLETE", "FAILED"], read: false });
    assertEquals(status.unreadInboxCount, unreadItems + 1);
    const unread = await (await get(t.app, "/api/failover/notes?read=false")).json() as FailoverNotesResponse;
    assertEquals(unread.notes.map((n) => n.id), [notes[0]!.id]);
    assertEquals((await post(t.app, "/api/failover/notes/nope/read")).status, 404);

    // A new episode: a second note, newest first.
    t.clock.now += 60 * MIN;
    fail(t, claimed(t.store, "m1", "9"));
    fail(t, claimed(t.store, "m1", "10"));
    const all = await (await get(t.app, "/api/failover/notes")).json() as FailoverNotesResponse;
    assertEquals(all.notes.length, 2);
    assertEquals(all.notes[0]!.startedAt, new Date(t.clock.now).toISOString());
  } finally { t.cleanup(); }
});

test("Inbox: a failover that never trips writes no note", () => {
  const t = team();
  try {
    fail(t, claimed(t.store, "m1", "1"));
    assertEquals(t.store.failoverNotes.list(), []);
  } finally { t.cleanup(); }
});

// ─── mpt status ──────────────────────────────────────────────────────

test("mpt status: a failover line while active, none otherwise (or from an older daemon)", () => {
  const base = { stories: { open: 0, done: 0, total: 0 }, tasks: { total: 0 }, members: { total: 2, working: 0, idle: 2 } };
  const active = { active: true, from: "acme/a", to: "acme/b", since: "2026-03-01T12:00:00.000Z", trips: [{ kind: "throttle" as const }], exhausted: false };
  assertEquals(statusSummaryLines({ ...base, failover: active }, hhmm).at(-1), "Failover: acme/a → acme/b since 12:00 (throttle) — Config → Models");
  for (const data of [base, { ...base, failover: { ...active, active: false } }]) {
    assert(!statusSummaryLines(data, hhmm).some((l) => l.startsWith("Failover")));
  }
});
