/**
 * tests/usage.test.ts — The token-usage ledger and the Usage dashboard's reads
 * (daemon/store/usage.ts, daemon/routes/usage.ts): per-run reports with cache
 * tokens and kinds, local-day bucketing, range totals, and — the bug this
 * fixed — usage surviving an archived story.
 */

import * as fs from "node:fs";
import { test } from "node:test";
import { assertAlmostEquals, assertEquals } from "./_assert.ts";
import { makeTeam, withTeam, post } from "./_team.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import * as path from "node:path";

test("usage: a chat run (no ref) is recorded with cache tokens and its kind", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app }) => {
    const res = await post(app, "/api/agents/leader/usage", {
      inputTokens: 3, outputTokens: 500, cacheReadTokens: 40_000, cacheWriteTokens: 2_000,
      model: "claude-opus", costUsd: 0.25, kind: "chat",
    });
    assertEquals(res.status, 200);
    const daily = await (await app.request("/api/usage/daily?days=7&tzOffset=0")).json();
    assertEquals(daily.days.length, 1);
    const day = daily.days[0];
    assertEquals(day.tokens, 3 + 500 + 40_000 + 2_000);
    assertEquals(day.cacheReadTokens, 40_000);
    assertEquals(day.byKind.chat.runs, 1);
    assertAlmostEquals(daily.totals.today.costUsd, 0.25);
    const runs = (await (await app.request(`/api/usage/day?date=${day.date}&tzOffset=0`)).json()).runs;
    assertEquals(runs[0].kind, "chat");
    assertEquals(runs[0].title, "Assistant chat");
    assertEquals(runs[0].memberId, "leader");
  });
});

test("usage: a work run is recorded on the item's ref, with a title snapshot", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app, store }) => {
    const wd = await (await post(app, "/api/work-defs", { title: "Audit deps", goal: "do it" })).json();
    const item = store.getWorkItems({ states: ["READY"] }).items[0]!;
    await post(app, "/api/agents/t1/usage", { inputTokens: 10, outputTokens: 20, model: "m", costUsd: 0.1, kind: "work", workItemId: item.id });
    const runs = store.getUsageRunsOnDay({ date: new Date().toISOString().slice(0, 10), tzOffsetMin: 0 });
    assertEquals(runs[0]!.refId, wd.workDef.id);
    assertEquals(runs[0]!.title, "Audit deps");
    // The per-WorkDef rollup (Tasks page cost) still sees it.
    assertAlmostEquals(store.getTokenUsageSummary({ workDefId: wd.workDef.id })!.totalCostUsd, 0.1);
  });
});

test("usage: unknown kinds become 'other'; model is required", async () => {
  await withTeam({ minTeammates: 0 }, async ({ app }) => {
    assertEquals((await post(app, "/api/agents/t1/usage", { inputTokens: 1 })).status, 400);
    await post(app, "/api/agents/t1/usage", { inputTokens: 1, outputTokens: 1, model: "m", costUsd: 0, kind: "bogus" });
    const daily = await (await app.request("/api/usage/daily?tzOffset=0")).json();
    assertEquals(daily.days[0].byKind.other.runs, 1);
  });
});

test("usage: days bucket by the client's local timezone", () => {
  return withTeam({ minTeammates: 0 }, ({ store }) => {
    // 2026-01-02 03:00 UTC is still Jan 1 in PDT-ish (UTC-8 → offset +480).
    const at = Date.UTC(2026, 0, 2, 3, 0, 0);
    store.recordRunUsage({ inputTokens: 1, outputTokens: 1, model: "m", costUsd: 0, kind: "chat", at });
    const since = at - 86_400_000;
    assertEquals(store.getDailyUsage({ sinceMs: since, tzOffsetMin: 0 })[0]!.date, "2026-01-02");
    assertEquals(store.getDailyUsage({ sinceMs: since, tzOffsetMin: 480 })[0]!.date, "2026-01-01");
  });
});

test("usage: the ledger survives removing a story's live data (archive/delete)", () => {
  return withTeam({ minTeammates: 0 }, ({ store }) => {
    const { tasks } = store.createStory("s1", "S", "desc", "open", [], [{ title: "T", description: "t" }], "default");
    const storyId = "s1";
    const taskId = tasks[0]!.id;
    store.addTokenUsage({ workDefId: taskId }, 5, 5, "m", 0.5);
    store.deleteStory(storyId);
    const runs = store.getUsageRunsOnDay({ date: new Date().toISOString().slice(0, 10), tzOffsetMin: 0 });
    assertEquals(runs.length, 1);
    assertAlmostEquals(runs[0]!.costUsd, 0.5);
  });
});

// ─── The files are the source of truth ──────────────────────────────

test("files: each run is appended to usage/YYYY-MM.jsonl (committable)", () => {
  return withTeam({ minTeammates: 0 }, ({ store, teamDir }) => {
    const at = Date.UTC(2026, 8, 24, 12);
    store.recordRunUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 30, model: "m", costUsd: 0.5, kind: "chat", memberId: "leader", at });
    const lines = fs.readFileSync(path.join(teamDir, "usage", "2026-09.jsonl"), "utf8").trim().split("\n");
    assertEquals(lines.length, 1);
    const line = JSON.parse(lines[0]!);
    assertEquals(line.kind, "chat");
    assertEquals(line.cacheReadTokens, 30);
    assertEquals(line.at, new Date(at).toISOString());
  });
});

test("files: a lost state.db is rebuilt from the ledger files", () => {
  const { store, teamDir } = makeTeam({ minTeammates: 0 });
  try {
    store.recordRunUsage({ inputTokens: 1, outputTokens: 1, model: "m", costUsd: 1.25, kind: "work", at: Date.UTC(2026, 8, 1) });
    store.close();
    for (const f of ["state.db", "state.db-wal", "state.db-shm"]) {
      try { fs.rmSync(path.join(teamDir, f)); } catch { /* may not exist */ }
    }
    const fresh = new Store(teamDir, { ...structuredClone(TEST_CONFIG), minTeammates: 0 });
    const runs = fresh.getUsageRunsOnDay({ date: "2026-09-01", tzOffsetMin: 0 });
    assertEquals(runs.length, 1);
    assertAlmostEquals(runs[0]!.costUsd, 1.25);
    fresh.close();
  } finally {
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("files: a new team gets an empty usage/ ledger on first boot", () => {
  const { store, teamDir } = makeTeam({ minTeammates: 0 });
  try {
    assertEquals(fs.readdirSync(path.join(teamDir, "usage")), []);
    assertEquals(store.getUsageRunsOnDay({ date: "2026-09-01", tzOffsetMin: 0 }).length, 0);
  } finally {
    store.close();
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("files: a malformed ledger line is skipped, not fatal", () => {
  const { store, teamDir } = makeTeam({ minTeammates: 0 });
  try {
    store.recordRunUsage({ inputTokens: 1, outputTokens: 1, model: "m", costUsd: 0.1, kind: "chat", at: Date.UTC(2026, 8, 2) });
    fs.appendFileSync(path.join(teamDir, "usage", "2026-09.jsonl"), "{not json\n");
    store.close();
    const fresh = new Store(teamDir, { ...structuredClone(TEST_CONFIG), minTeammates: 0 });
    assertEquals(fresh.getUsageRunsOnDay({ date: "2026-09-02", tzOffsetMin: 0 }).length, 1);
    fresh.close();
  } finally {
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
