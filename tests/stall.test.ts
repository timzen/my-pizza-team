/**
 * tests/stall.test.ts — Stalled teammates (docs/DESIGN.md "Stalled
 * Teammates"; shared/stall.ts, Store.getMemberStall, the heartbeat's
 * `activity`, GET /api/agents and /api/status `stalled`, `mpt status`).
 *
 * On a fake clock: an idle agent is never stalled; a tool running past the
 * threshold is; progress clears it by itself; an older harness that reports no
 * activity falls back to its session stats' age; `stallMinutes: 0` is off, and
 * a workflow state's `stallMinutes` overrides the team's. The heartbeat's
 * report is cleaned on receipt, and `mpt status` prints a line per stall.
 */

import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { makeTeam, get, post, withTeam, type Team } from "./_team.ts";
import type { AgentActivityReport, AgentListResponse, StatusResponse } from "../shared/protocol.ts";
import type { TeamConfig, WorkflowConfig, WorkItem } from "../shared/types.ts";
import {
  DEFAULT_STALL_MINUTES, formatStallDuration, readActivityReport, resolveStallMinutes, stallLine, stallOf, type StallInput,
} from "../shared/stall.ts";
import { statusSummaryLines } from "../cli/features.ts";
import { serializeTeamConfig } from "../shared/team-config.ts";
import { validateWorkflow } from "../daemon/workflow-engine.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-14T08:00:00Z");

// ─── The rule (pure) ─────────────────────────────────────────────────

/** A working agent on a claimed item, claimed at T0, running a tool since T0. */
function input(over: Partial<StallInput> = {}): StallInput {
  return {
    now: T0 + 31 * MIN,
    stallMinutes: 30,
    status: "working",
    workItemId: "wi-1",
    claimedAt: T0,
    report: { activity: { state: "tool", tool: "bash", since: T0, preview: "node --test" }, lastProgressAt: T0 },
    sessionStatsAt: null,
    ...over,
  };
}

test("rule: a tool running past the threshold is stalled, since its last progress", () => {
  const stall = stallOf(input());
  assertEquals(stall, { since: T0, activity: { state: "tool", tool: "bash", since: T0, preview: "node --test" }, stallMinutes: 30, workItemId: "wi-1" });
  assertEquals(stallOf(input({ now: T0 + 30 * MIN })), null, "not past it yet");
});

test("rule: idle agents are never stalled — by report, by status, or holding nothing", () => {
  assertEquals(stallOf(input({ report: { activity: { state: "idle", since: T0 }, lastProgressAt: T0 }, now: T0 + 13 * HOUR })), null);
  for (const status of ["idle", "pairing", "offline"] as const) assertEquals(stallOf(input({ status, now: T0 + 13 * HOUR })), null, status);
  assertEquals(stallOf(input({ workItemId: null, now: T0 + 13 * HOUR })), null);
});

test("rule: progress clears it, and a fresh claim counts as a start", () => {
  assertEquals(stallOf(input({ report: { activity: { state: "model", since: T0 + 20 * MIN }, lastProgressAt: T0 + 20 * MIN } })), null);
  // Last session's progress is hours old, but the item was claimed a minute ago.
  assertEquals(stallOf(input({ claimedAt: T0 + 30 * MIN })), null);
});

test("rule: an older harness (no activity) falls back to its session stats' age; with neither, never flagged", () => {
  const old = { report: null, now: T0 + 2 * HOUR };
  const stall = stallOf(input({ ...old, sessionStatsAt: T0 + 10 * MIN }));
  assertEquals(stall, { since: T0 + 10 * MIN, activity: null, stallMinutes: 30, workItemId: "wi-1" });
  assertEquals(stallOf(input({ ...old, sessionStatsAt: T0 + 100 * MIN })), null, "a recent turn");
  assertEquals(stallOf(input({ ...old, sessionStatsAt: T0 - HOUR }))?.since, T0, "stats from before the claim: the claim");
  assertEquals(stallOf(input({ ...old, sessionStatsAt: null, now: T0 + 13 * HOUR })), null, "nothing to measure progress by");
});

test("rule: stallMinutes 0 is off; the state's value overrides the team's", () => {
  assertEquals(stallOf(input({ stallMinutes: 0, now: T0 + 13 * HOUR })), null);
  assertEquals(resolveStallMinutes({}), DEFAULT_STALL_MINUTES);
  assertEquals(resolveStallMinutes({ stallMinutes: 0 }), 0);
  assertEquals(resolveStallMinutes({ stallMinutes: 45 }), 45);
  assertEquals(resolveStallMinutes({ stallMinutes: -1 }), DEFAULT_STALL_MINUTES, "nonsense reads as the default");
  assertEquals(resolveStallMinutes({ stallMinutes: 45 }, 120), 120);
  assertEquals(resolveStallMinutes({ stallMinutes: 45 }, 0), 0);
});

test("heartbeat report: cleaned on receipt; malformed or absent = an older harness", () => {
  const preview = `GITHUB_TOKEN=ghp_x ${"y".repeat(300)}\nsecond line`;
  const r = readActivityReport({ activity: { state: "tool", tool: "bash", since: T0, preview }, lastProgressAt: T0 })!;
  assertEquals(r.activity.tool, "bash");
  assert(r.activity.preview!.startsWith("GITHUB_TOKEN=*** y"), r.activity.preview!);
  assert(r.activity.preview!.length <= 120 && !r.activity.preview!.includes("\n"), "one short line");
  assertEquals(readActivityReport({ activity: { state: "model", since: T0, tool: "x" }, lastProgressAt: T0 }), { activity: { state: "model", since: T0 }, lastProgressAt: T0 });
  assertEquals(readActivityReport({}), null);
  assertEquals(readActivityReport({ activity: { state: "napping", since: T0 }, lastProgressAt: T0 }), null);
  assertEquals(readActivityReport({ activity: { state: "tool", since: "soon" }, lastProgressAt: T0 }), null);
  assertEquals(readActivityReport({ activity: { state: "tool", since: T0 } }), null);
});

test("wording: durations, and mpt status's line per stalled teammate", () => {
  assertEquals(formatStallDuration(45 * MIN), "45m");
  assertEquals(formatStallDuration(13 * HOUR), "13h");
  assertEquals(formatStallDuration(2 * HOUR + 5 * MIN), "2h 5m");
  assertEquals(formatStallDuration(76 * HOUR), "3d 4h");
  const stall = { id: "m1", name: "bright-muad-dib", since: T0, stallMinutes: 30, workItemId: "wi-1", activity: { state: "tool" as const, tool: "bash", since: T0, preview: "node --test …" } };
  assertEquals(stallLine(stall, T0 + 13 * HOUR), "bright-muad-dib stalled 13h: bash `node --test …`");
  assertEquals(stallLine({ ...stall, activity: null }, T0 + 40 * MIN), "bright-muad-dib stalled 40m: no activity reported");
  assertEquals(stallLine({ ...stall, activity: { state: "model", since: T0 } }, T0 + 40 * MIN), "bright-muad-dib stalled 40m: waiting on the model");
  const summary = { stories: { open: 0, done: 0, total: 0 }, tasks: { total: 0 }, members: { total: 1, working: 1, idle: 0 } };
  const lines = statusSummaryLines({ ...summary, stalled: [stall] }, (iso) => iso, T0 + 13 * HOUR);
  assertEquals(lines.at(-1), "⚠️  bright-muad-dib stalled 13h: bash `node --test …`");
  assert(!statusSummaryLines(summary).some((l) => l.includes("stalled")), "an older daemon: no lines");
});

// ─── Config ──────────────────────────────────────────────────────────

test("config: stallMinutes is written after agentTimeoutSeconds; a state's must be minutes", () => {
  const keys = Object.keys(serializeTeamConfig({ port: 1, apiToken: "t", stallMinutes: 0, agentTimeoutSeconds: 90 } as Partial<TeamConfig> as TeamConfig));
  assertEquals(keys, ["port", "agentTimeoutSeconds", "stallMinutes", "apiToken"]);
  const wf = (stallMinutes: unknown): WorkflowConfig => ({ states: [{ name: "build", type: "teammate", stallMinutes } as never] });
  assertEquals(validateWorkflow(wf(120)), null);
  assertEquals(validateWorkflow(wf(0)), null);
  assertStringIncludes(validateWorkflow(wf(-5))!, "stallMinutes");
  assertStringIncludes(validateWorkflow(wf("2h"))!, "stallMinutes");
});

// ─── The Store and the routes ────────────────────────────────────────

/**
 * The fake clock's start: a little ahead of real time, since a claim stamps
 * real time and counts as a start (so the tool's start is the later one).
 */
const clockStart = () => Date.now() + 5_000;

/** A team on a fake clock (`clockStart`) with teammate m1. */
function team(cfg: Partial<TeamConfig> = {}): Team & { clock: { now: number } } {
  const t = makeTeam(cfg);
  const clock = { now: clockStart() };
  t.store.clock = () => clock.now;
  t.store.registerMember("m1", "bright-muad-dib", "/tmp", {}, { harness: "pi" });
  return Object.assign(t, { clock });
}

/** A Solitary task's item, claimed by m1, which is now working on it. */
function claimed(t: Team): WorkItem {
  const def = t.store.createWorkDef({ title: "Job", goal: "g", acceptanceCriteria: "a" });
  const item = t.store.getActiveWorkItem(def.id)!;
  assert(t.store.claimWorkItem(item.id, "m1"), "claimed");
  t.store.heartbeat("m1", "working");
  return item;
}

/** A heartbeat report: running `preview` in bash since `since`, no progress since then. */
function bash(since: number, preview = "node --test tests/persona-model.test.mjs | grep fail"): AgentActivityReport {
  return { activity: { state: "tool", tool: "bash", since, preview }, lastProgressAt: since };
}

test("store: a hung tool is flagged after the threshold and clears when progress resumes", () => {
  const t = team();
  try {
    const item = claimed(t);
    const start = t.clock.now;
    t.store.heartbeat("m1", "working", bash(start));
    t.clock.now = start + 29 * MIN;
    assertEquals(t.store.getMemberStall("m1"), null);
    t.clock.now = start + 13 * HOUR;
    const stall = t.store.getMemberStall("m1")!;
    assertEquals(stall.workItemId, item.id);
    assertEquals(stall.since, start);
    assertEquals(stall.activity?.tool, "bash");
    assertEquals(stall.stallMinutes, DEFAULT_STALL_MINUTES);
    // A heartbeat without activity keeps the last report: still stalled.
    t.store.heartbeat("m1", "working");
    assert(t.store.getMemberStall("m1"), "still stalled");
    // The tool returned: progress.
    t.store.heartbeat("m1", "working", { activity: { state: "model", since: t.clock.now }, lastProgressAt: t.clock.now });
    assertEquals(t.store.getMemberStall("m1"), null);
  } finally { t.cleanup(); }
});

test("store: idle by report is never stalled; a re-registration forgets the report", () => {
  const t = team();
  try {
    claimed(t);
    t.store.heartbeat("m1", "working", { activity: { state: "idle", since: t.clock.now }, lastProgressAt: t.clock.now });
    t.clock.now += 13 * HOUR;
    assertEquals(t.store.getMemberStall("m1"), null);
    t.store.heartbeat("m1", "working", bash(t.clock.now - 2 * HOUR));
    assert(t.store.getMemberStall("m1"), "stalled");
    t.store.registerMember("m1", "bright-muad-dib", "/tmp", {}, { harness: "pi" });
    assertEquals(t.store.getMemberActivity("m1"), undefined);
  } finally { t.cleanup(); }
});

test("store: an older harness falls back to its session stats' age", () => {
  const t = team();
  try {
    claimed(t);
    t.clock.now += 5 * MIN;
    t.store.setMemberSessionStats("m1", { contextTokens: 1, contextWindow: 10, contextPercent: 10, costUsd: 0, model: null });
    t.clock.now += 20 * MIN;
    assertEquals(t.store.getMemberStall("m1"), null);
    t.clock.now += 20 * MIN;
    const stall = t.store.getMemberStall("m1")!;
    assertEquals(stall.activity, null);
    assertEquals(t.clock.now - stall.since, 40 * MIN);
    // Another turn's stats: progress.
    t.store.setMemberSessionStats("m1", { contextTokens: 2, contextWindow: 10, contextPercent: 20, costUsd: 0, model: null });
    assertEquals(t.store.getMemberStall("m1"), null);
  } finally { t.cleanup(); }
});

test("store: stallMinutes 0 is off; a longer team threshold waits longer", () => {
  for (const [stallMinutes, after, stalled] of [[0, 13 * HOUR, false], [120, 90 * MIN, false], [120, 121 * MIN, true]] as const) {
    const t = team({ stallMinutes });
    try {
      claimed(t);
      t.store.heartbeat("m1", "working", bash(t.clock.now));
      t.clock.now += after;
      assertEquals(Boolean(t.store.getMemberStall("m1")), stalled, `stallMinutes ${stallMinutes} after ${after / MIN}m`);
    } finally { t.cleanup(); }
  }
});

test("store: a workflow state's stallMinutes overrides the team's for its runs", () => {
  const workflows = { default: { states: [{ name: "build", type: "teammate", stallMinutes: 240 }, { name: "review", type: "manual" }] } } as Record<string, WorkflowConfig>;
  const t = team({ workflows, stallMinutes: 30 });
  try {
    t.store.createStory("s1", "S1", "D", "open", [], [{ title: "Build it", description: "long build" }], "default");
    const item = t.store.getActiveWorkItem("s1-1")!;
    assert(t.store.claimWorkItem(item.id, "m1"), "claimed");
    t.store.heartbeat("m1", "working", bash(t.clock.now, "brazil-build release"));
    t.clock.now += 3 * HOUR;
    assertEquals(t.store.getMemberStall("m1"), null, "the state allows 4h");
    t.clock.now += 2 * HOUR;
    assertEquals(t.store.getMemberStall("m1")?.stallMinutes, 240);
  } finally { t.cleanup(); }
});

test("routes: the heartbeat carries activity; GET /api/agents and /api/status show the stall", async () => {
  await withTeam({}, async (t) => {
    const clock = { now: clockStart() };
    t.store.clock = () => clock.now;
    t.store.registerMember("m1", "bright-muad-dib", "/tmp", {}, { harness: "pi" });
    t.store.registerMember("m2", "calm-teammate", "/tmp", {}, { harness: "pi" });
    const def = t.store.createWorkDef({ title: "Job", goal: "g", acceptanceCriteria: "a" });
    const item = t.store.getActiveWorkItem(def.id)!;
    assertEquals((await post(t.app, `/api/agents/claim/${item.id}`, { agentId: "m1" })).status, 200);
    const start = clock.now;
    const res = await post(t.app, "/api/agents/heartbeat", {
      id: "m1", status: "working", currentTask: item.id,
      activity: { state: "tool", tool: "bash", since: start, preview: "API_TOKEN=abc node --test tests/x.test.mjs" }, lastProgressAt: start,
    });
    assertEquals(res.status, 200);
    // An older harness's heartbeat: no activity, still fine.
    assertEquals((await post(t.app, "/api/agents/heartbeat", { id: "m2", status: "idle" })).status, 200);

    let agents = (await (await get(t.app, "/api/agents")).json()) as AgentListResponse;
    let m1 = agents.agents.find((a) => a.id === "m1")!;
    assertEquals(m1.activity, { state: "tool", tool: "bash", since: start, preview: "API_TOKEN=*** node --test tests/x.test.mjs" });
    assertEquals(m1.lastProgressAt, start);
    assertEquals(m1.stalled, null);
    const m2 = agents.agents.find((a) => a.id === "m2")!;
    assertEquals([m2.activity, m2.lastProgressAt, m2.stalled], [null, null, null]);

    clock.now = start + 13 * HOUR;
    agents = (await (await get(t.app, "/api/agents")).json()) as AgentListResponse;
    m1 = agents.agents.find((a) => a.id === "m1")!;
    assertEquals(m1.stalled?.since, start);
    assertEquals(m1.stalled?.workItemId, item.id);
    assertEquals(m1.status, "working", "a flag, not a status");
    const status = (await (await get(t.app, "/api/status")).json()) as StatusResponse;
    assertEquals(status.stalled.map((s) => [s.id, s.name, s.workItemId]), [["m1", "bright-muad-dib", item.id]]);
    assertEquals(statusSummaryLines(status, (iso) => iso, clock.now).at(-1), "⚠️  bright-muad-dib stalled 13h: bash `API_TOKEN=*** node --test tests/x.test.mjs`");
    assertEquals(t.store.getWorkItem(item.id)!.state, "IN_PROGRESS", "nothing is failed");
  });
});
