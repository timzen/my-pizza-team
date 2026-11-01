/**
 * daemon/layout-check.ts — Refuse a team last run on a version older than 0.36.0.
 *
 * 0.36.0 is the oldest version a team can upgrade from (`MIN_UPGRADE_FROM_VERSION`;
 * docs/DESIGN.md "Upgrading from before 0.36.0"). Up to 0.36.x the daemon carried
 * on-load migrations for every older layout; they are gone, so a team that still
 * has an old layout must start once on 0.36.x (which migrates it) before it can
 * run on this version. Rather than misread such a team, the daemon refuses to
 * start on it (daemon/start.ts, daemon/app.ts), and `mpt doctor` reports the same
 * thing as a failed check.
 *
 * `findPreCutoffLayout(teamDir)` looks for exactly the formats the removed
 * migrations used to rewrite, read-only:
 *
 *   - only `.pi-pizza-team` next to (or under) the team dir, and no `.my-pizza-team`;
 *   - a top-level `backlog/<id>.json` or `archived/<id>.json` *file* (the pre-pending
 *     backlog and the pre-archive-in-place directory) whose id isn't in `stories/`
 *     too (that conflict 0.36.x left in place). Nested folder-per-story
 *     leftovers (`backlog/<id>/<id>.json`, `archived/<id>/story.json`) are not:
 *     the old migration never handled them, so they aren't a sign of an
 *     unmigrated team;
 *   - a `stories/<id>.json` with a `paused` key;
 *   - a `tasks/<id>/workdef.md` or `templates/<id>/template.md` whose frontmatter
 *     says `draft: true`;
 *   - a `context/` directory with no `context.migrated*` beside it (the context
 *     library), a `triage.md` while config.json sets no `triage.persona`, or a
 *     `workflows/<name>/<state>.md` instruction file for an agent state of that
 *     workflow that names no `persona` (0.36.x left those two alone, with a
 *     warning, once the persona was set);
 *   - a `state.db` from before the schema was versioned whose shape is older than
 *     0.36.0's (daemon/store/schema.ts `preCutoffSchemaFindings`), or one holding
 *     usage rows while the team has no `usage/` ledger (0.36.0 always has one) —
 *     or, likewise, a `task.json` carrying `tokenUsage` and no `usage/`.
 *
 * A fresh team (no team dir, or one with nothing in it yet) has none of these.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  LEGACY_TEAM_DIR,
  PRE_CUTOFF_UPGRADE_MESSAGE,
  STATE_DB,
  STORIES_DIR,
  TEAM_DIR,
  TEMPLATES_DIR,
  USAGE_DIR,
  WORKDEFS_DIR,
  WORKFLOWS_DIR,
} from "../shared/types.ts";
import { preCutoffSchemaFindings } from "./store/schema.ts";
import { errorMessage } from "../shared/util.ts";

/** One sign of a pre-0.36.0 layout: where it is, and what it is. */
export interface PreCutoffFinding {
  /** The file or directory found (absolute). */
  path: string;
  /** What it is, in a few words (e.g. "a story with the pre-0.26 `paused` flag"). */
  what: string;
}

/** The pre-pending backlog directory (`<teamDir>/backlog/<id>.json`). */
const BACKLOG_DIR = "backlog";
/** The pre-archive-in-place directory (`<teamDir>/archived/<id>.json`). */
const ARCHIVED_DIR = "archived";
/** The former context library (`<teamDir>/context/<id>.md`). */
const CONTEXT_DIR = "context";
/** Where 0.34–0.36's persona migration archived the context library (`context.migrated`, `-2`, …). */
const CONTEXT_ARCHIVE_PREFIX = "context.migrated";
/** The former team-wide triage instructions. */
const TRIAGE_FILE = "triage.md";

/**
 * Every sign that `teamDir` was last run on a version older than 0.36.0, or an
 * empty list. Read-only and never throws (an unreadable file is skipped, like
 * the daemon's loaders skip it).
 */
export function findPreCutoffLayout(teamDir: string): PreCutoffFinding[] {
  const found: PreCutoffFinding[] = [];
  const push = (p: string, what: string) => found.push({ path: p, what });

  // The pre-rename directory name: only it, and no team directory proper. The team
  // dir resolves to `<project>/.my-pizza-team` (look beside it) or, when TEAM_DIR
  // names a project with no `.my-pizza-team`, to the project itself (look in it).
  const legacyDir = path.basename(teamDir) === TEAM_DIR
    ? (isDir(teamDir) ? null : path.join(path.dirname(teamDir), LEGACY_TEAM_DIR))
    : (existsSync(path.join(teamDir, "config.json")) ? null : path.join(teamDir, LEGACY_TEAM_DIR));
  if (legacyDir && isDir(legacyDir)) {
    push(legacyDir, `the team directory under its pre-rename name, and no ${TEAM_DIR} (rename it to ${TEAM_DIR})`);
  }
  if (!isDir(teamDir)) return found;

  // Top-level story files in backlog/ and archived/ (not nested folder-per-story leftovers).
  for (const [dir, what] of [
    [BACKLOG_DIR, "a backlogged story file (backlog/ was replaced by pending stories)"],
    [ARCHIVED_DIR, "an archived story file (archived stories now stay in stories/)"],
  ] as const) {
    for (const entry of readDir(path.join(teamDir, dir))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      // One whose id is already in stories/ was a conflict 0.36.x left in place on
      // purpose (never clobber a story): a leftover to resolve by hand, not a sign.
      if (existsSync(path.join(teamDir, STORIES_DIR, entry.name))) continue;
      push(path.join(teamDir, dir, entry.name), what);
    }
  }

  // Stories with the pre-pending `paused` flag.
  for (const entry of readDir(path.join(teamDir, STORIES_DIR))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(teamDir, STORIES_DIR, entry.name);
    const data = readJsonObject(file);
    if (data && "paused" in data) push(file, "a story with the `paused` flag (replaced by `pending`)");
  }

  // WorkDefs and templates still spelled `draft: true`.
  for (const [dir, name] of [[WORKDEFS_DIR, "workdef.md"], [TEMPLATES_DIR, "template.md"]] as const) {
    for (const entry of readDir(path.join(teamDir, dir))) {
      if (!entry.isDirectory()) continue;
      const file = path.join(teamDir, dir, entry.name, name);
      // 0.36.x read this as pending but rewrote it only on the WorkDef's next save,
      // so the fix may have to be by hand.
      if (hasDraftFrontmatter(file)) push(file, "`draft: true` in its frontmatter (renamed: change it to `pending: true`)");
    }
  }

  // The pre-persona layout: the context library, triage.md, workflow state files.
  const contextDir = path.join(teamDir, CONTEXT_DIR);
  if (isDir(contextDir) && !readDir(teamDir).some((e) => e.isDirectory() && e.name.startsWith(CONTEXT_ARCHIVE_PREFIX))) {
    push(contextDir, "the context library (replaced by personas)");
  }
  // triage.md and state files count only where 0.36.x would have migrated them: it
  // left them alone (and warned) once `triage.persona` / the state's `persona` was set.
  const config = readJsonObject(path.join(teamDir, "config.json"));
  const triagePersona = (config?.triage as { persona?: unknown } | undefined)?.persona;
  const triageFile = path.join(teamDir, TRIAGE_FILE);
  if (existsSync(triageFile) && !triagePersona) push(triageFile, "the team's triage instructions (replaced by a triage persona)");
  for (const entry of readDir(path.join(teamDir, WORKFLOWS_DIR))) {
    if (!entry.isDirectory()) continue;
    const wfDir = path.join(teamDir, WORKFLOWS_DIR, entry.name);
    const wf = readJsonObject(path.join(wfDir, "workflow.json"));
    const states = Array.isArray(wf?.states) ? wf.states as Array<{ name?: unknown; type?: unknown; persona?: unknown }> : [];
    for (const state of states) {
      if (!state || typeof state.name !== "string" || state.type !== "agent" || state.persona) continue;
      const md = path.join(wfDir, `${state.name}.md`);
      if (existsSync(md)) push(md, "a workflow state instruction file (replaced by the state's `persona`)");
    }
  }

  // state.db: an older shape, or a usage history that was never moved into usage/.
  const dbFile = path.join(teamDir, STATE_DB);
  if (existsSync(dbFile)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      for (const what of preCutoffSchemaFindings(db)) push(dbFile, what);
      if (!existsSync(path.join(teamDir, USAGE_DIR)) && hasUsageRows(db)) {
        push(dbFile, `token usage recorded only in the database (0.36.0 keeps it in ${USAGE_DIR}/)`);
      }
    } catch (e) {
      // Unreadable here means unreadable for the Store too, which reports it itself.
      console.warn(`[layout] couldn't inspect ${dbFile}: ${errorMessage(e)}`);
    } finally {
      db?.close();
    }
  }

  // Usage only in old board tasks' task.json mirrors, never moved into usage/.
  if (!existsSync(path.join(teamDir, USAGE_DIR))) {
    // Where board tasks lived (tasks/, and story folders in stories/, archived/, backlog/).
    const files = [WORKDEFS_DIR, STORIES_DIR, ARCHIVED_DIR, BACKLOG_DIR].flatMap((d) => taskJsonWithUsage(path.join(teamDir, d)));
    for (const file of files) push(file, `token usage recorded only in task.json (0.36.0 keeps it in ${USAGE_DIR}/)`);
  }

  return found;
}

/** The refusal: the upgrade message, then each finding on its own line. */
export function formatPreCutoffMessage(teamDir: string, findings: PreCutoffFinding[]): string {
  return [
    PRE_CUTOFF_UPGRADE_MESSAGE,
    `Found in ${teamDir}:`,
    ...findings.map((f) => `  - ${path.relative(teamDir, f.path) || f.path}: ${f.what}`),
  ].join("\n");
}

/** Thrown by `assertCurrentLayout` (and so by createApp) on a pre-0.36.0 team. */
export class PreCutoffLayoutError extends Error {
  readonly findings: PreCutoffFinding[];
  constructor(teamDir: string, findings: PreCutoffFinding[]) {
    super(formatPreCutoffMessage(teamDir, findings));
    this.name = "PreCutoffLayoutError";
    this.findings = findings;
  }
}

/** Throw a `PreCutoffLayoutError` when `teamDir` has a pre-0.36.0 layout; otherwise do nothing. */
export function assertCurrentLayout(teamDir: string): void {
  const findings = findPreCutoffLayout(teamDir);
  if (findings.length > 0) throw new PreCutoffLayoutError(teamDir, findings);
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readDir(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Does the markdown file's frontmatter say `draft: true`? */
function hasDraftFrontmatter(file: string): boolean {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return false; }
  const fm = raw.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(\n|$)/)?.[1] ?? "";
  return /^draft:\s*["']?true["']?\s*$/m.test(fm);
}

/** Every `task.json` under `dir` (dot-directories skipped) with a non-empty `tokenUsage` array. */
function taskJsonWithUsage(dir: string, out: string[] = []): string[] {
  for (const entry of readDir(dir)) {
    if (entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) taskJsonWithUsage(p, out);
    else if (entry.isFile() && entry.name === "task.json") {
      const usage = readJsonObject(p)?.tokenUsage;
      if (Array.isArray(usage) && usage.length > 0) out.push(p);
    }
  }
  return out;
}

/** Does `token_usage` hold any row? (False when the table doesn't exist.) */
function hasUsageRows(db: DatabaseSync): boolean {
  try {
    return db.prepare("SELECT 1 FROM token_usage LIMIT 1").get() !== undefined;
  } catch {
    return false;
  }
}
