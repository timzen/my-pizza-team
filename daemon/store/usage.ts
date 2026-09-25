/**
 * daemon/store/usage.ts — The token-usage ledger and its rollups.
 *
 * Every agent run's usage is one row in `token_usage`: tokens (input, output,
 * cache read, cache write), the harness-reported cost, the model, **when**, and
 * **what kind** of run it was:
 *
 *   - `work`     a teammate working a WorkItem (recorded on its WorkDef ref)
 *   - `pairing`  a teammate run while a human pairs with it (web or tmux)
 *   - `chat`     the leader answering the chat
 *   - `other`    anything else a teammate ran (e.g. between work items)
 *
 * **It's a ledger: rows are never deleted.** Spend happened whether or not its
 * story is later archived, backlogged, or deleted — archiving used to wipe a
 * story's usage, so finished work vanished from any history. Each row keeps a
 * `title` snapshot of what it was for, so it stays readable after its ref is
 * gone.
 *
 * **Files are the source of truth; SQLite is a cache.** Each run is appended as
 * one JSON line to `usage/YYYY-MM.jsonl` in the team dir, so the ledger is
 * committed with the stories, tasks, and config (state.db is gitignored), diffs
 * are append-only, and it's greppable / `jq`-able. On boot the `token_usage`
 * table is rebuilt from those files (`syncUsageLedger`). The first boot without
 * a `usage/` dir migrates: existing DB rows, plus the `tokenUsage` arrays that
 * old board tasks mirrored into `task.json` (including archived stories — the
 * only usage git had), deduplicated.
 *
 * Rollups back the Usage dashboard (routes/usage.ts): tokens + cost per local
 * day (the client passes its UTC offset, so "a day" is the user's day), and one
 * day's runs.
 */

import type { DatabaseSync } from "node:sqlite";
import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { USAGE_DIR } from "../../shared/types.ts";

export type UsageKind = "work" | "pairing" | "chat" | "other";
export const USAGE_KINDS: readonly UsageKind[] = ["work", "pairing", "chat", "other"];

export interface UsageEntry {
  /** WorkDef ref id, when the run was for one. */
  refId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model: string;
  costUsd: number;
  kind?: UsageKind;
  memberId?: string | null;
  /** What it was for, snapshotted (the ref may be archived or deleted later). */
  title?: string | null;
  /** Epoch ms; defaults to now. */
  at?: number;
}

/**
 * Bring an older `token_usage` table up to date:
 *
 * 1. **Drop the foreign key.** Early databases declared `task_id REFERENCES
 *    tasks(id)`; the schema has since removed it (usage is recorded on WorkDef
 *    refs, and standalone WorkDefs, archived tasks, and chat runs have no
 *    `tasks` row), but `CREATE TABLE IF NOT EXISTS` never touched existing
 *    tables — so on those DBs every such insert failed the constraint.
 *    SQLite can't drop a constraint in place, so the table is rebuilt, keeping
 *    its rows.
 * 2. Add the columns the ledger grew (cache tokens, kind, member, title).
 */
export function migrateUsageColumns(db: DatabaseSync): void {
  const fks = db.prepare("PRAGMA foreign_key_list(token_usage)").all() as unknown[];
  if (fks.length > 0) {
    db.exec("BEGIN");
    try {
      db.exec(`CREATE TABLE token_usage_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        model TEXT,
        cost_usd REAL,
        recorded_at INTEGER
      )`);
      db.exec(`INSERT INTO token_usage_rebuilt (id, task_id, input_tokens, output_tokens, model, cost_usd, recorded_at)
               SELECT id, task_id, input_tokens, output_tokens, model, cost_usd, recorded_at FROM token_usage`);
      db.exec("DROP TABLE token_usage");
      db.exec("ALTER TABLE token_usage_rebuilt RENAME TO token_usage");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  const cols = new Set((db.prepare("PRAGMA table_info(token_usage)").all() as Array<{ name: string }>).map((c) => c.name));
  const add = (name: string, type: string) => { if (!cols.has(name)) db.exec(`ALTER TABLE token_usage ADD COLUMN ${name} ${type}`); };
  add("cache_read_tokens", "INTEGER DEFAULT 0");
  add("cache_write_tokens", "INTEGER DEFAULT 0");
  // Rows from before kinds existed were all teammate work-item runs.
  add("kind", "TEXT DEFAULT 'work'");
  add("member_id", "TEXT");
  add("title", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at)");
}

/**
 * Record one run: append it to the month's ledger file (the source of truth),
 * then mirror it into the SQLite cache. `teamDir` is optional only so the
 * cache can be rebuilt without re-appending.
 */
export function recordUsage(db: DatabaseSync, e: UsageEntry, teamDir?: string): void {
  const entry: UsageEntry = { ...e, at: e.at ?? Date.now() };
  if (teamDir) appendUsageLine(teamDir, entry);
  insertRow(db, entry);
}

function insertRow(db: DatabaseSync, e: UsageEntry): void {
  db.prepare(
    `INSERT INTO token_usage (task_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, cost_usd, kind, member_id, title, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.refId ?? null,
    e.inputTokens,
    e.outputTokens,
    e.cacheReadTokens ?? 0,
    e.cacheWriteTokens ?? 0,
    e.model,
    e.costUsd,
    e.kind ?? "work",
    e.memberId ?? null,
    e.title ?? null,
    e.at ?? Date.now(),
  );
}

/** Token + cost totals for one bucket (a day, a kind within a day, a range). */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** All four, summed: what the model processed. */
  tokens: number;
  costUsd: number;
  runs: number;
}

export interface UsageDay extends UsageTotals {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  byKind: Partial<Record<UsageKind, UsageTotals>>;
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, tokens: 0, costUsd: 0, runs: 0 };
}

function addInto(t: UsageTotals, r: Record<string, unknown>): void {
  const inp = Number(r.inp) || 0, out = Number(r.outp) || 0, cr = Number(r.cr) || 0, cw = Number(r.cw) || 0;
  t.inputTokens += inp; t.outputTokens += out; t.cacheReadTokens += cr; t.cacheWriteTokens += cw;
  t.tokens += inp + out + cr + cw;
  t.costUsd += Number(r.cost) || 0;
  t.runs += Number(r.runs) || 0;
}

/**
 * SQL for a row's local calendar day. `tzOffsetMin` is JS's
 * `Date#getTimezoneOffset()` (minutes to add to local time to get UTC; +420 for
 * PDT), so local = UTC − offset.
 */
const LOCAL_DAY = "date((recorded_at - ? * 60000) / 1000, 'unixepoch')";

/**
 * Usage per local day since `sinceMs`, oldest first, only days with usage
 * (the grid fills the gaps).
 */
export function dailyUsage(db: DatabaseSync, opts: { sinceMs: number; tzOffsetMin: number }): UsageDay[] {
  const rows = db.prepare(
    `SELECT ${LOCAL_DAY} AS day, COALESCE(kind, 'work') AS kind,
            SUM(input_tokens) AS inp, SUM(output_tokens) AS outp,
            SUM(COALESCE(cache_read_tokens, 0)) AS cr, SUM(COALESCE(cache_write_tokens, 0)) AS cw,
            SUM(cost_usd) AS cost, COUNT(*) AS runs
     FROM token_usage WHERE recorded_at >= ?
     GROUP BY day, kind ORDER BY day`,
  ).all(opts.tzOffsetMin, opts.sinceMs) as Array<Record<string, unknown>>;

  const days = new Map<string, UsageDay>();
  for (const r of rows) {
    const date = String(r.day);
    let d = days.get(date);
    if (!d) { d = { date, ...emptyTotals(), byKind: {} }; days.set(date, d); }
    addInto(d, r);
    const kind = (USAGE_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as UsageKind) : "other";
    const k = d.byKind[kind] ?? (d.byKind[kind] = emptyTotals());
    addInto(k, r);
  }
  return [...days.values()];
}

/** Sum a list of days (for the dashboard's range tiles). */
export function sumDays(days: UsageTotals[]): UsageTotals {
  const t = emptyTotals();
  for (const d of days) {
    t.inputTokens += d.inputTokens; t.outputTokens += d.outputTokens;
    t.cacheReadTokens += d.cacheReadTokens; t.cacheWriteTokens += d.cacheWriteTokens;
    t.tokens += d.tokens; t.costUsd += d.costUsd; t.runs += d.runs;
  }
  return t;
}

export interface UsageRun {
  at: string;
  kind: UsageKind;
  refId: string | null;
  title: string | null;
  memberId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Every run on one local day (YYYY-MM-DD), most expensive first. */
export function runsOnDay(db: DatabaseSync, opts: { date: string; tzOffsetMin: number }): UsageRun[] {
  const rows = db.prepare(
    `SELECT * FROM token_usage WHERE ${LOCAL_DAY} = ? ORDER BY cost_usd DESC, recorded_at DESC`,
  ).all(opts.tzOffsetMin, opts.date) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    at: new Date(Number(r.recorded_at)).toISOString(),
    kind: ((r.kind as string) || "work") as UsageKind,
    refId: (r.task_id as string) ?? null,
    title: (r.title as string) ?? null,
    memberId: (r.member_id as string) ?? null,
    model: String(r.model ?? ""),
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    cacheReadTokens: Number(r.cache_read_tokens) || 0,
    cacheWriteTokens: Number(r.cache_write_tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
  }));
}

// ─── The files (source of truth) ────────────────────────────────────

/** One ledger line, as written to `usage/YYYY-MM.jsonl`. */
interface UsageLine {
  at: string;
  kind: UsageKind;
  refId: string | null;
  title: string | null;
  memberId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

function toLine(e: UsageEntry): UsageLine {
  return {
    at: new Date(e.at ?? Date.now()).toISOString(),
    kind: e.kind ?? "work",
    refId: e.refId ?? null,
    title: e.title ?? null,
    memberId: e.memberId ?? null,
    model: e.model,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadTokens: e.cacheReadTokens ?? 0,
    cacheWriteTokens: e.cacheWriteTokens ?? 0,
    costUsd: e.costUsd,
  };
}

function fromLine(l: Partial<UsageLine>): UsageEntry | null {
  const at = Date.parse(String(l.at));
  if (!Number.isFinite(at) || typeof l.model !== "string") return null;
  const kind = (USAGE_KINDS as readonly string[]).includes(String(l.kind)) ? (l.kind as UsageKind) : "other";
  return {
    at,
    kind,
    refId: l.refId ?? null,
    title: l.title ?? null,
    memberId: l.memberId ?? null,
    model: l.model,
    inputTokens: Number(l.inputTokens) || 0,
    outputTokens: Number(l.outputTokens) || 0,
    cacheReadTokens: Number(l.cacheReadTokens) || 0,
    cacheWriteTokens: Number(l.cacheWriteTokens) || 0,
    costUsd: Number(l.costUsd) || 0,
  };
}

/** `usage/2026-09.jsonl` for a run (UTC month — files are storage, not display). */
function monthFile(teamDir: string, at: number): string {
  return path.join(teamDir, USAGE_DIR, `${new Date(at).toISOString().slice(0, 7)}.jsonl`);
}

function appendUsageLine(teamDir: string, e: UsageEntry): void {
  const file = monthFile(teamDir, e.at ?? Date.now());
  Deno.mkdirSync(path.dirname(file), { recursive: true });
  Deno.writeTextFileSync(file, JSON.stringify(toLine(e)) + "\n", { append: true });
}

/** Every entry in the ledger files, oldest file first. Malformed lines are skipped. */
function readUsageFiles(teamDir: string): UsageEntry[] {
  const dir = path.join(teamDir, USAGE_DIR);
  if (!existsSync(dir)) return [];
  const files = [...Deno.readDirSync(dir)].filter((f) => f.isFile && f.name.endsWith(".jsonl")).map((f) => f.name).sort();
  const out: UsageEntry[] = [];
  for (const name of files) {
    for (const line of Deno.readTextFileSync(path.join(dir, name)).split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = fromLine(JSON.parse(line));
        if (e) out.push(e);
      } catch { /* a hand-edit gone wrong shouldn't lose the rest */ }
    }
  }
  return out;
}

/** Every `task.json` under the team dir (live and archived board tasks). */
function findTaskJsonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.name.startsWith(".") || entry.name === USAGE_DIR) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory) findTaskJsonFiles(p, out);
    else if (entry.isFile && entry.name === "task.json") out.push(p);
  }
  return out;
}

/** Usage that old board tasks mirrored into task.json (`tokenUsage: [...]`). */
function readTaskJsonUsage(teamDir: string): UsageEntry[] {
  const out: UsageEntry[] = [];
  for (const file of findTaskJsonFiles(teamDir)) {
    try {
      const data = JSON.parse(Deno.readTextFileSync(file)) as { id?: string; title?: string; tokenUsage?: Array<Record<string, unknown>> };
      for (const u of data.tokenUsage ?? []) {
        const e = fromLine({ ...u, kind: "work", refId: data.id ?? path.basename(path.dirname(file)), title: data.title ?? null } as Partial<UsageLine>);
        if (e) out.push(e);
      }
    } catch { /* skip unreadable task files */ }
  }
  return out;
}

/** Existing cache rows (the pre-files ledger). */
function readDbRows(db: DatabaseSync): UsageEntry[] {
  const rows = db.prepare("SELECT * FROM token_usage").all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    at: Number(r.recorded_at) || 0,
    kind: ((r.kind as string) || "work") as UsageKind,
    refId: (r.task_id as string) ?? null,
    title: (r.title as string) ?? null,
    memberId: (r.member_id as string) ?? null,
    model: String(r.model ?? ""),
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    cacheReadTokens: Number(r.cache_read_tokens) || 0,
    cacheWriteTokens: Number(r.cache_write_tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
  }));
}

/** Same run seen twice (DB row + its task.json mirror)? Same second, ref, tokens, cost. */
function dedupKey(e: UsageEntry): string {
  return [Math.floor((e.at ?? 0) / 1000), e.refId ?? "", e.inputTokens, e.outputTokens, (e.costUsd ?? 0).toFixed(6)].join("|");
}

/**
 * Make the files authoritative and the cache match them. Called once at boot.
 *
 * - `usage/` exists → rebuild `token_usage` from the files (a pulled commit or
 *   hand-edit is reflected; a stale/deleted state.db loses nothing).
 * - it doesn't (first boot on this version) → migrate: write the DB rows and
 *   task.json mirrors, deduplicated, into the month files, then rebuild.
 *
 * Returns how many entries the ledger holds.
 */
export function syncUsageLedger(db: DatabaseSync, teamDir: string): number {
  const dir = path.join(teamDir, USAGE_DIR);
  if (!existsSync(dir)) {
    const seen = new Set<string>();
    const merged: UsageEntry[] = [];
    // DB rows first: they carry the richer fields (cache, kind, member, title).
    for (const e of [...readDbRows(db), ...readTaskJsonUsage(teamDir)]) {
      const k = dedupKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(e);
    }
    merged.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    Deno.mkdirSync(dir, { recursive: true });
    for (const e of merged) appendUsageLine(teamDir, e);
  }
  const entries = readUsageFiles(teamDir);
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM token_usage");
    for (const e of entries) insertRow(db, e);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return entries.length;
}
