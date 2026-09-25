/**
 * tests/usage.test.ts — The token-usage ledger and the Usage dashboard's reads
 * (daemon/store/usage.ts, daemon/routes/usage.ts): per-run reports with cache
 * tokens and kinds, local-day bucketing, range totals, and — the bug this
 * fixed — usage surviving an archived story.
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_CONFIG, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

function setup() {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-usage-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config: TeamConfig = { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir };
}
function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
}
const post = (app: ReturnType<typeof buildApp>, url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

Deno.test("usage: a chat run (no ref) is recorded with cache tokens and its kind", async () => {
  const { app, store, teamDir } = setup();
  try {
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
  } finally { cleanup(teamDir, store); }
});

Deno.test("usage: a work run is recorded on the item's ref, with a title snapshot", async () => {
  const { app, store, teamDir } = setup();
  try {
    const wd = await (await post(app, "/api/work-defs", { title: "Audit deps", goal: "do it" })).json();
    const item = store.getWorkItems({ states: ["READY"] }).items[0]!;
    await post(app, "/api/agents/t1/usage", { inputTokens: 10, outputTokens: 20, model: "m", costUsd: 0.1, kind: "work", workItemId: item.id });
    const runs = store.getUsageRunsOnDay({ date: new Date().toISOString().slice(0, 10), tzOffsetMin: 0 });
    assertEquals(runs[0]!.refId, wd.workDef.id);
    assertEquals(runs[0]!.title, "Audit deps");
    // The per-WorkDef rollup (Tasks page cost) still sees it.
    assertAlmostEquals(store.getTokenUsageSummaryForRef({ workDefId: wd.workDef.id })!.totalCostUsd, 0.1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("usage: unknown kinds become 'other'; model is required", async () => {
  const { app, store, teamDir } = setup();
  try {
    assertEquals((await post(app, "/api/agents/t1/usage", { inputTokens: 1 })).status, 400);
    await post(app, "/api/agents/t1/usage", { inputTokens: 1, outputTokens: 1, model: "m", costUsd: 0, kind: "bogus" });
    const daily = await (await app.request("/api/usage/daily?tzOffset=0")).json();
    assertEquals(daily.days[0].byKind.other.runs, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("usage: days bucket by the client's local timezone", () => {
  const { store, teamDir } = setup();
  try {
    // 2026-01-02 03:00 UTC is still Jan 1 in PDT-ish (UTC-8 → offset +480).
    const at = Date.UTC(2026, 0, 2, 3, 0, 0);
    store.recordRunUsage({ inputTokens: 1, outputTokens: 1, model: "m", costUsd: 0, kind: "chat", at });
    const since = at - 86_400_000;
    assertEquals(store.getDailyUsage({ sinceMs: since, tzOffsetMin: 0 })[0]!.date, "2026-01-02");
    assertEquals(store.getDailyUsage({ sinceMs: since, tzOffsetMin: 480 })[0]!.date, "2026-01-01");
  } finally { cleanup(teamDir, store); }
});

Deno.test("usage: the ledger survives removing a story's live data (archive/backlog/delete)", () => {
  const { store, teamDir } = setup();
  try {
    const { tasks } = store.createStory("s1", "S", "desc", "open", [], [{ title: "T", description: "t" }], "default");
    const storyId = "s1";
    const taskId = tasks[0]!.id;
    store.addTokenUsage(taskId, 5, 5, "m", 0.5);
    store.deleteStory(storyId);
    const runs = store.getUsageRunsOnDay({ date: new Date().toISOString().slice(0, 10), tzOffsetMin: 0 });
    assertEquals(runs.length, 1);
    assertAlmostEquals(runs[0]!.costUsd, 0.5);
  } finally { cleanup(teamDir, store); }
});

// ─── The files are the source of truth ──────────────────────────────

Deno.test("files: each run is appended to usage/YYYY-MM.jsonl (committable)", () => {
  const { store, teamDir } = setup();
  try {
    const at = Date.UTC(2026, 8, 24, 12);
    store.recordRunUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 30, model: "m", costUsd: 0.5, kind: "chat", memberId: "leader", at });
    const lines = Deno.readTextFileSync(path.join(teamDir, "usage", "2026-09.jsonl")).trim().split("\n");
    assertEquals(lines.length, 1);
    const line = JSON.parse(lines[0]!);
    assertEquals(line.kind, "chat");
    assertEquals(line.cacheReadTokens, 30);
    assertEquals(line.at, new Date(at).toISOString());
  } finally { cleanup(teamDir, store); }
});

Deno.test("files: a lost state.db is rebuilt from the ledger files", () => {
  const { store, teamDir } = setup();
  try {
    store.recordRunUsage({ inputTokens: 1, outputTokens: 1, model: "m", costUsd: 1.25, kind: "work", at: Date.UTC(2026, 8, 1) });
    store.close();
    for (const f of ["state.db", "state.db-wal", "state.db-shm"]) {
      try { Deno.removeSync(path.join(teamDir, f)); } catch { /* may not exist */ }
    }
    const fresh = new Store(teamDir, { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 });
    const runs = fresh.getUsageRunsOnDay({ date: "2026-09-01", tzOffsetMin: 0 });
    assertEquals(runs.length, 1);
    assertAlmostEquals(runs[0]!.costUsd, 1.25);
    fresh.close();
  } finally {
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("files: first boot migrates task.json mirrors (incl. archived stories), idempotently", () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-usage-migrate-" });
  try {
    Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
    // An archived board task that mirrored its usage into task.json…
    const taskDir = path.join(teamDir, "archived", "s1", "tasks", "s1-1");
    Deno.mkdirSync(taskDir, { recursive: true });
    const mirrored = { inputTokens: 18, outputTokens: 4068, model: "opus", costUsd: 0.061074, at: "2026-07-16T20:35:28.254Z" };
    Deno.writeTextFileSync(path.join(taskDir, "task.json"), JSON.stringify({ id: "s1-1", title: "Old task", tokenUsage: [mirrored] }));
    // First boot on this version: no usage/ dir yet, so it migrates.
    const db = new Store(teamDir, { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 });
    const julyRuns = db.getUsageRunsOnDay({ date: "2026-07-16", tzOffsetMin: 0 });
    assertEquals(julyRuns.length, 1);
    assertEquals(julyRuns[0]!.title, "Old task");
    db.close();
    const again = new Store(teamDir, { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 });
    assertEquals(again.getUsageRunsOnDay({ date: "2026-07-16", tzOffsetMin: 0 }).length, 1);
    const lines = Deno.readTextFileSync(path.join(teamDir, "usage", "2026-07.jsonl")).trim().split("\n");
    assertEquals(lines.length, 1);
    again.close();
  } finally {
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("files: a DB row and its task.json mirror dedupe to one entry", () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-usage-dedup-" });
  try {
    Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
    // Boot once and record a board-task run the old way (DB only)…
    const s1 = new Store(teamDir, { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 });
    const at = Date.UTC(2026, 6, 1, 10);
    s1.recordRunUsage({ refId: "t-1", inputTokens: 5, outputTokens: 6, model: "m", costUsd: 0.2, kind: "work", at });
    s1.close();
    // …then pretend the ledger files never existed, with the mirror present.
    Deno.removeSync(path.join(teamDir, "usage"), { recursive: true });
    Deno.mkdirSync(path.join(teamDir, "tasks", "t-1"), { recursive: true });
    Deno.writeTextFileSync(path.join(teamDir, "tasks", "t-1", "task.json"), JSON.stringify({
      id: "t-1", title: "T", tokenUsage: [{ inputTokens: 5, outputTokens: 6, model: "m", costUsd: 0.2, at: new Date(at).toISOString() }],
    }));
    const s2 = new Store(teamDir, { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 });
    assertEquals(s2.getUsageRunsOnDay({ date: "2026-07-01", tzOffsetMin: 0 }).length, 1);
    s2.close();
  } finally {
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("files: a malformed ledger line is skipped, not fatal", () => {
  const { store, teamDir } = setup();
  try {
    store.recordRunUsage({ inputTokens: 1, outputTokens: 1, model: "m", costUsd: 0.1, kind: "chat", at: Date.UTC(2026, 8, 2) });
    Deno.writeTextFileSync(path.join(teamDir, "usage", "2026-09.jsonl"), "{not json\n", { append: true });
    store.close();
    const fresh = new Store(teamDir, { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 });
    assertEquals(fresh.getUsageRunsOnDay({ date: "2026-09-02", tzOffsetMin: 0 }).length, 1);
    fresh.close();
  } finally {
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("migration: an old token_usage with a FK to tasks is rebuilt (rows kept, FK gone)", async () => {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-usage-fk-" });
  try {
    Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
    // A current schema, then swap in the early token_usage (FK to tasks) with
    // one row, and no ledger files — as an old team dir has it.
    new Store(teamDir, { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 }).close();
    Deno.removeSync(path.join(teamDir, "usage"), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(teamDir, "state.db"));
    db.exec(`DROP TABLE token_usage;
      CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id),
        input_tokens INTEGER, output_tokens INTEGER, model TEXT, cost_usd REAL, recorded_at INTEGER);
      PRAGMA foreign_keys = OFF;
      INSERT INTO token_usage (task_id, input_tokens, output_tokens, model, cost_usd, recorded_at)
        VALUES ('t-gone', 3, 557, 'opus', 0.008, ${Date.UTC(2026, 7, 3)});`);
    db.close();

    const store = new Store(teamDir, { ...structuredClone(DEFAULT_CONFIG), minTeammates: 0 });
    // The old row survived the rebuild and made it into the ledger files…
    assertEquals(store.getUsageRunsOnDay({ date: "2026-08-03", tzOffsetMin: 0 }).length, 1);
    // …and a ref-less run (which the FK used to reject) now records.
    store.recordRunUsage({ inputTokens: 1, outputTokens: 1, model: "m", costUsd: 0.1, kind: "chat", at: Date.UTC(2026, 7, 4) });
    assertEquals(store.getUsageRunsOnDay({ date: "2026-08-04", tzOffsetMin: 0 }).length, 1);
    store.close();
  } finally {
    try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* ignore */ }
  }
});
