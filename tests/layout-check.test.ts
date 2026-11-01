/**
 * tests/layout-check.test.ts — Refusing a team last run before 0.36.0
 * (daemon/layout-check.ts; docs/DESIGN.md "Upgrading from before 0.36.0").
 *
 * - Each format the removed migrations used to rewrite is found, with its path:
 *   top-level backlog/ and archived/ story files, a story's `paused`, `draft: true`
 *   WorkDefs and templates, the context library, triage.md, workflow state files,
 *   a lone `.pi-pizza-team`, a pre-0.36.0 state.db, usage only in the database
 *   or in task.json.
 * - Nothing is found on a clean current-format team, a fresh (empty or missing)
 *   one, or one with nested folder-per-story leftovers (`backlog/<id>/<id>.json`,
 *   `archived/<id>/story.json`), which the old migration never handled.
 * - createApp throws the upgrade message before the Store opens; the daemon
 *   (`node daemon/main.ts`) exits non-zero with it and writes nothing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { createApp } from "../daemon/app.ts";
import { findPreCutoffLayout, formatPreCutoffMessage, PreCutoffLayoutError } from "../daemon/layout-check.ts";
import { PRE_CUTOFF_UPGRADE_MESSAGE } from "../shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A project dir holding `.my-pizza-team/` with `files` (relative path → content; objects are JSON). */
function team(files: Record<string, string | object> = {}): { project: string; teamDir: string; cleanup: () => void } {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-layout-test-"));
  const teamDir = path.join(project, ".my-pizza-team");
  fs.mkdirSync(teamDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(teamDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return { project, teamDir, cleanup: () => fs.rmSync(project, { recursive: true, force: true }) };
}

/** The findings as paths relative to the team dir, sorted. */
function found(teamDir: string): string[] {
  return findPreCutoffLayout(teamDir).map((f) => path.relative(teamDir, f.path)).sort();
}

const story = (id: string, extra: object = {}) => ({ id, title: id, description: "d", status: "open", dependsOn: [], tasks: [], ...extra });
const workdef = (fm: string) => `---\ntitle: "T"\n${fm}---\n## Goal\n\ng\n\n## Acceptance Criteria\n\na\n\n## Additional Context\n\n`;
const WORKFLOW = { states: [{ name: "in_progress", type: "agent" }, { name: "review", type: "manual" }] };

/** A team in today's layout, as a 0.36.0-migrated team has it. */
const CURRENT: Record<string, string | object> = {
  "config.json": { workflows: {}, defaultWorkflow: "default" },
  "stories/s1.json": story("s1", { pending: true }),
  "stories/s2.json": story("s2", { archivedAt: "2026-01-01T00:00:00.000Z", synopsis: "# done" }),
  "tasks/s1-1/workdef.md": workdef("parentKind: story\nparentId: s1\npending: true\n"),
  "templates/tpl/template.md": workdef(""),
  "workflows/default/workflow.json": { states: [{ name: "in_progress", type: "agent", persona: "p" }] },
  "personas/p.md": "---\ntitle: P\n---\nBe careful.\n",
  "context.migrated/README.md": "archived",
  "usage/2026-01.jsonl": "",
};

test("a clean current-format team, an empty team dir and a missing one have no findings", () => {
  const t = team(CURRENT);
  try {
    new Store(t.teamDir, structuredClone(TEST_CONFIG)).close(); // a real state.db, as a booted team has
    assertEquals(found(t.teamDir), []);
    const empty = team();
    try {
      assertEquals(found(empty.teamDir), []);
      assertEquals(findPreCutoffLayout(path.join(empty.project, "nope", ".my-pizza-team")), []);
    } finally { empty.cleanup(); }
  } finally { t.cleanup(); }
});

test("nested folder-per-story leftovers in backlog/ and archived/ don't count", () => {
  const t = team({
    ...CURRENT,
    "backlog/old-story/old-story.json": story("old-story"),
    "backlog/old-story/1-task/task.json": { id: "old-story-1" },
    "archived/gone/story.json": story("gone"),
    "archived/gone/tasks/gone-1/task.json": { id: "gone-1" },
  });
  try {
    assertEquals(found(t.teamDir), []);
  } finally { t.cleanup(); }
});

test("backlog/<id>.json and archived/<id>.json files are found, except a conflict 0.36.x left in place", () => {
  const t = team({ ...CURRENT, "backlog/b.json": story("b"), "archived/a.json": story("a"), "backlog/s1.json": story("s1") });
  try {
    assertEquals(found(t.teamDir), ["archived/a.json", "backlog/b.json"]);
  } finally { t.cleanup(); }
});

test("a story with a paused key is found (true or false)", () => {
  const t = team({ ...CURRENT, "stories/held.json": story("held", { paused: true }), "stories/run.json": story("run", { paused: false }) });
  try {
    assertEquals(found(t.teamDir), ["stories/held.json", "stories/run.json"]);
  } finally { t.cleanup(); }
});

test("draft: true in a WorkDef's or a template's frontmatter is found; in the body it isn't", () => {
  const t = team({
    ...CURRENT,
    "tasks/old/workdef.md": workdef("draft: true\n"),
    "templates/old/template.md": workdef("draft: true\n"),
    "tasks/fine/workdef.md": workdef("").replace("g\n", "draft: true\n"),
  });
  try {
    assertEquals(found(t.teamDir), ["tasks/old/workdef.md", "templates/old/template.md"]);
  } finally { t.cleanup(); }
});

test("the pre-persona layout: context/ (unless archived), triage.md, workflow state files", () => {
  const t = team({
    "config.json": {},
    "context/entry.md": "# Entry",
    "triage.md": "triage like this",
    "workflows/default/workflow.json": WORKFLOW,
    "workflows/default/in_progress.md": "work like this",
    "workflows/default/review.md": "a manual state's file was never read",
    "workflows/default/README.md": "not a state",
  });
  try {
    assertEquals(found(t.teamDir), ["context", "triage.md", "workflows/default/in_progress.md"]);
    // context/ beside an archive is the user's own folder, not the old library.
    fs.mkdirSync(path.join(t.teamDir, "context.migrated-2"));
    assertEquals(found(t.teamDir).includes("context"), false);
    // 0.36.x left triage.md / a state file alone once the persona was set: leftovers, not signs.
    fs.writeFileSync(path.join(t.teamDir, "config.json"), JSON.stringify({ triage: { persona: "triage" } }));
    fs.writeFileSync(path.join(t.teamDir, "workflows/default/workflow.json"), JSON.stringify({ states: [{ name: "in_progress", type: "agent", persona: "p" }] }));
    assertEquals(found(t.teamDir), []);
  } finally { t.cleanup(); }
});

test("a lone .pi-pizza-team (and no .my-pizza-team) is found; beside a .my-pizza-team it isn't", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-layout-test-"));
  try {
    const old = path.join(project, ".pi-pizza-team");
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, "config.json"), "{}");
    // Resolved as <project>/.my-pizza-team (cwd or TEAM_DIR=<project>/.my-pizza-team) …
    const teamDir = path.join(project, ".my-pizza-team");
    assertEquals(findPreCutoffLayout(teamDir).map((f) => f.path), [old]);
    // … or as the project itself (TEAM_DIR=<project>, which has no .my-pizza-team).
    assertEquals(findPreCutoffLayout(project).map((f) => f.path), [old]);
    // An explicit TEAM_DIR=<project>/.pi-pizza-team is used as named.
    assertEquals(findPreCutoffLayout(old), []);
    fs.mkdirSync(teamDir);
    assertEquals(findPreCutoffLayout(teamDir), []);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("a pre-0.36.0 state.db is found; so is usage only in the database or in task.json", () => {
  const t = team(CURRENT);
  try {
    new Store(t.teamDir, structuredClone(TEST_CONFIG)).close();
    const dbPath = path.join(t.teamDir, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 0; ALTER TABLE members ADD COLUMN host_id TEXT;");
    db.close();
    const findings = findPreCutoffLayout(t.teamDir);
    assertEquals(findings.map((f) => path.relative(t.teamDir, f.path)), ["state.db"]);
    assertStringIncludes(findings[0]!.what, "host_id");

    // Usage rows, and no usage/ ledger: only an older daemon left the team like that.
    const usage = team({ "config.json": {} });
    try {
      const s = new Store(usage.teamDir, structuredClone(TEST_CONFIG));
      s.close();
      fs.rmSync(path.join(usage.teamDir, "usage"), { recursive: true });
      const u = new DatabaseSync(path.join(usage.teamDir, "state.db"));
      u.exec("INSERT INTO token_usage (task_id, input_tokens, output_tokens, model, cost_usd, recorded_at) VALUES ('t', 1, 1, 'm', 0.1, 1)");
      u.close();
      assertEquals(found(usage.teamDir), ["state.db"]);
      fs.mkdirSync(path.join(usage.teamDir, "usage"));
      assertEquals(found(usage.teamDir), [], "with a usage/ ledger the rows are just its cache");
      fs.rmSync(path.join(usage.teamDir, "usage"), { recursive: true });
      const u2 = new DatabaseSync(path.join(usage.teamDir, "state.db"));
      u2.exec("DELETE FROM token_usage");
      u2.close();
      fs.mkdirSync(path.join(usage.teamDir, "tasks", "t-1"), { recursive: true });
      fs.writeFileSync(path.join(usage.teamDir, "tasks", "t-1", "task.json"), JSON.stringify({ id: "t-1", tokenUsage: [{ inputTokens: 1 }] }));
      assertEquals(found(usage.teamDir), ["tasks/t-1/task.json"]);
    } finally { usage.cleanup(); }
  } finally { t.cleanup(); }
});

test("the message names every finding and the upgrade path", () => {
  const t = team({ "config.json": {}, "triage.md": "x", "backlog/b.json": story("b") });
  try {
    const message = formatPreCutoffMessage(t.teamDir, findPreCutoffLayout(t.teamDir));
    assert(message.startsWith(PRE_CUTOFF_UPGRADE_MESSAGE), message);
    assertStringIncludes(message, "npm i -g my-pizza-team@0.36");
    assertStringIncludes(message, "  - backlog/b.json: ");
    assertStringIncludes(message, "  - triage.md: ");
  } finally { t.cleanup(); }
});

test("createApp refuses a pre-0.36.0 team before the Store opens it", async () => {
  const t = team({ "config.json": {}, "stories/s.json": story("s", { paused: true }) });
  try {
    let error: unknown = null;
    try { await createApp(t.teamDir); } catch (e) { error = e; }
    assert(error instanceof PreCutoffLayoutError, `expected PreCutoffLayoutError, got ${String(error)}`);
    assertStringIncludes((error as Error).message, PRE_CUTOFF_UPGRADE_MESSAGE);
    assertEquals(fs.existsSync(path.join(t.teamDir, "state.db")), false, "no state.db was created");
    assertEquals(JSON.parse(fs.readFileSync(path.join(t.teamDir, "stories", "s.json"), "utf8")).paused, true, "the story is untouched");
  } finally { t.cleanup(); }
});

test("the daemon exits non-zero with the upgrade message and writes nothing", () => {
  const t = team({ "config.json": {}, "triage.md": "x" });
  try {
    const before = fs.readdirSync(t.teamDir).sort();
    const res = spawnSync(process.execPath, ["daemon/main.ts"], {
      cwd: ROOT,
      env: { ...process.env, TEAM_DIR: t.teamDir, PORT: "0" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assertEquals(res.status, 1, res.stdout + res.stderr);
    assertStringIncludes(res.stderr, PRE_CUTOFF_UPGRADE_MESSAGE);
    assertStringIncludes(res.stderr, "triage.md");
    assertEquals(fs.readdirSync(t.teamDir).sort(), before, "no pid file, log or state.db");
  } finally { t.cleanup(); }
});
