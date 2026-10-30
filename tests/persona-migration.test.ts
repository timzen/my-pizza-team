/**
 * tests/persona-migration.test.ts — The on-load migration to the persona library
 * (daemon/personas/migrate.ts; docs/DESIGN.md "Personas" — Migration).
 *
 * Copies tests/fixtures/legacy-persona-team (a team in the pre-persona layout:
 * state files, triage.md, a context library with persona-tagged, attached and
 * unattached entries, an assistant selection and chat session) into a temp dir,
 * seeds the SQLite state the old layout kept there, then opens a Store — which
 * migrates — and checks each legacy source, that prompts carry the same words,
 * and that re-running is a no-op.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { migrateToPersonas } from "../daemon/personas/migrate.ts";
import { DEFAULT_TRIAGE_INSTRUCTIONS } from "../daemon/prompt.ts";
import type { TeamConfig } from "../shared/types.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "legacy-persona-team");

/** A fresh copy of the legacy fixture, with the SQLite state the old layout used. */
function legacyTeam(): { teamDir: string; config: TeamConfig } {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-mig-"));
  // Create the schema on an empty dir first (no legacy files yet, so no migration).
  new Store(teamDir, structuredClone(TEST_CONFIG)).close();
  const db = new DatabaseSync(path.join(teamDir, "state.db"));
  db.prepare("INSERT INTO settings (key, value) VALUES ('assistant_persona', 'pizzaiolo')").run();
  db.prepare("INSERT INTO assistant_sessions (id, persona_id, persona_title, title, status, started_at) VALUES ('1700000000000-pizzaiolo', 'pizzaiolo', 'Pizzaiolo', '', 'ended', 1700000000000)").run();
  db.close();
  fs.cpSync(FIXTURE, teamDir, { recursive: true });
  fs.rmSync(path.join(teamDir, "README.md"));
  return { teamDir, config: structuredClone(TEST_CONFIG) };
}

const read = (teamDir: string, rel: string) => fs.readFileSync(path.join(teamDir, rel), "utf8");
const exists = (teamDir: string, rel: string) => fs.existsSync(path.join(teamDir, rel));

/** Every file under the team dir (minus SQLite), with its contents — to prove a re-run changes nothing. */
function snapshot(teamDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.startsWith("state.db")) out[path.relative(teamDir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(teamDir);
  return out;
}

test("migration: workflow state files become personas referenced by workflow.json", () => {
  const { teamDir, config } = legacyTeam();
  const store = new Store(teamDir, config);
  try {
    const wf = JSON.parse(read(teamDir, "workflows/default/workflow.json"));
    assertEquals(wf.states[0].persona, "default-in_progress".replace("_", "-"));
    assertEquals(exists(teamDir, "workflows/default/in_progress.md"), false);
    const p = store.getPersona("default-in-progress")!;
    assertEquals(p.title, "Default — in_progress");
    assertEquals(p.kinds, ["worker"]);
    assertStringIncludes(p.content, "You are the **implementer**");
    // The manual state is untouched.
    assertEquals(wf.states[1].persona, undefined);
    // The state persona the prompt gets is the same text as before.
    assertStringIncludes(store.getStatePersona("default", "in_progress")!, "Make minimal changes");

    // A state that already names a persona keeps it, and the leftover file stays.
    const pipeline = JSON.parse(read(teamDir, "workflows/pipeline/workflow.json"));
    assertEquals(pipeline.states[1].persona, "builtin:worker");
    assertEquals(exists(teamDir, "workflows/pipeline/review.md"), true);
    // An empty state file carried nothing: removed, no persona.
    assertEquals(exists(teamDir, "workflows/pipeline/code.md"), false);
    assertEquals(pipeline.states[0].persona, undefined);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: triage.md becomes the triage persona", () => {
  const { teamDir, config } = legacyTeam();
  const store = new Store(teamDir, config);
  try {
    assertEquals(exists(teamDir, "triage.md"), false);
    const cfg = JSON.parse(read(teamDir, "config.json"));
    assertEquals(cfg.triage.persona, "triage");
    assertEquals(store.getConfig().triage?.persona, "triage");
    assertEquals(store.getPersona("triage")!.kinds, ["triage"]);
    assertStringIncludes(store.getTriageInstructions()!, "Only propose chores");
    assertEquals(store.getTriageInstructions() === DEFAULT_TRIAGE_INSTRUCTIONS, false);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: a persona-tagged entry becomes a persona (collision → -2) and the assistant follows it", () => {
  const { teamDir, config } = legacyTeam();
  const store = new Store(teamDir, config);
  try {
    // personas/pizzaiolo.md already existed with a different body: the entry took -2.
    assertStringIncludes(store.getPersona("pizzaiolo")!.content, "A different pizzaiolo");
    const migrated = store.getPersona("pizzaiolo-2")!;
    assertEquals(migrated.title, "Pizzaiolo");
    assertEquals(migrated.description, "A gruff pizza chef");
    assertEquals(migrated.tags, ["persona", "fun"]);
    assertEquals(migrated.kinds, ["assistant"]);

    // The SQLite setting moved to config.json through the mapping, then went away.
    assertEquals(store.getAssistantPersonaId(), "pizzaiolo-2");
    assertEquals(JSON.parse(read(teamDir, "config.json")).assistant.persona, "pizzaiolo-2");
    assertEquals(store.getSetting("assistant_persona"), null);
    assertStringIncludes(store.resolveAssistantPersona().body, "gruff pizzaiolo");

    // Sessions and their snapshots were remapped.
    assertEquals(store.getAssistantSession("1700000000000-pizzaiolo")!.personaId, "pizzaiolo-2");
    assertStringIncludes(read(teamDir, "assistant/sessions/1700000000000-pizzaiolo.md"), "persona: pizzaiolo-2\n");
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: attached context is inlined into Additional Context (story entries first, deduped)", () => {
  const { teamDir, config } = legacyTeam();
  const store = new Store(teamDir, config);
  try {
    const board = store.getWorkDef("s1-1")!;
    const ctx = board.additionalContext!;
    assertEquals(ctx.startsWith("Existing notes."), true);
    // Story-level first (project-conventions), then the task's own (api-style); once each.
    const conv = ctx.indexOf("### Reference: Project conventions (from the former context library, `project-conventions`)");
    const api = ctx.indexOf("### Reference: API style (from the former context library, `api-style`)");
    assertEquals(conv > 0 && api > conv, true);
    assertEquals(ctx.split("`project-conventions`").length - 1, 1);
    // The entry's own headings are demoted beneath its heading.
    assertStringIncludes(ctx, "#### Conventions");
    assertEquals(ctx.includes("deleted-entry"), false);
    assertEquals(read(teamDir, "tasks/s1-1/workdef.md").includes("contextRefs"), false);

    // An archived story's tasks, a Solitary task, and a template get the same treatment.
    assertStringIncludes(store.getWorkDef("s0-1")!.additionalContext!, "Use tabs.");
    assertStringIncludes(store.getWorkDef("solo")!.additionalContext!, "REST, plural nouns");
    assertStringIncludes(store.getTemplate("tpl")!.additionalContext!, "REST, plural nouns");
    assertEquals(read(teamDir, "templates/tpl/template.md").includes("contextRefs"), false);
    // Stories drop their attachment lists.
    assertEquals("context" in JSON.parse(read(teamDir, "stories/s1.json")), false);
    assertEquals("context" in JSON.parse(read(teamDir, "archived/s0.json")), false);
    // Mirrors are written only by sync: untouched.
    assertEquals(read(teamDir, "tasks/mirror-1/workdef.md"), fs.readFileSync(path.join(FIXTURE, "tasks/mirror-1/workdef.md"), "utf8"));
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: context/ is archived with a README, and a dismissable notice is raised", async () => {
  const { teamDir, config } = legacyTeam();
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  try {
    assertEquals(exists(teamDir, "context"), false);
    assertEquals(exists(teamDir, "context.migrated/unused.md"), true);
    assertStringIncludes(read(teamDir, "context.migrated/README.md"), "nothing reads this directory");
    const status = await (await app.request("/api/status")).json();
    assertEquals(status.notices.length, 1);
    // project-conventions + api-style were attached; unused is the only unattached one
    // (pizzaiolo became a persona).
    assertStringIncludes(status.notices[0].message, "2 attached entries were inlined");
    assertStringIncludes(status.notices[0].message, "1 unattached entry is in context.migrated/");
    assertEquals((await app.request(`/api/notices/${status.notices[0].id}`, { method: "DELETE" })).status, 200);
    assertEquals((await (await app.request("/api/status")).json()).notices, []);
    assertEquals((await app.request(`/api/notices/${status.notices[0].id}`, { method: "DELETE" })).status, 404);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: the board task's claim prompt carries the same words as before", async () => {
  const { teamDir, config } = legacyTeam();
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  try {
    store.loadFromDisk();
    store.registerMember("a1", "swift-neo", "/tmp");
    const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === "s1-1")!;
    const res = await app.request(`/api/agents/claim/${item.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "a1" }),
    });
    const { prompt } = await res.json() as { prompt: string };
    assertStringIncludes(prompt, "## Your Role: in_progress");
    assertStringIncludes(prompt, "You are the **implementer**");
    assertStringIncludes(prompt, "Use tabs. Run `make test` before finishing.");
    assertStringIncludes(prompt, "REST, plural nouns, JSON bodies.");
    assertEquals(prompt.includes("## Reference Context"), false);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: re-running is a no-op (files unchanged, nothing reported)", () => {
  const { teamDir, config } = legacyTeam();
  new Store(teamDir, config).close();
  const before = snapshot(teamDir);
  const store = new Store(teamDir, structuredClone(TEST_CONFIG));
  try {
    assertEquals(snapshot(teamDir), before);
    const db = new DatabaseSync(path.join(teamDir, "state.db"));
    const cfg = { ...structuredClone(TEST_CONFIG), ...JSON.parse(read(teamDir, "config.json")) } as TeamConfig;
    const report = migrateToPersonas({ teamDir, config: cfg, db, saveConfig: () => { throw new Error("no config write on a no-op"); }, log: () => {} });
    db.close();
    assertEquals(report.changed, false);
    assertEquals(report.personas, []);
  } finally { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: a context/ that reappears is migrated again, reusing identical personas", () => {
  const { teamDir, config } = legacyTeam();
  new Store(teamDir, config).close();
  // An old clone merged back in: the library is back, and a story re-attached an entry.
  fs.cpSync(path.join(FIXTURE, "context"), path.join(teamDir, "context"), { recursive: true });
  const db = new DatabaseSync(path.join(teamDir, "state.db"));
  const cfg = { ...structuredClone(TEST_CONFIG), ...JSON.parse(read(teamDir, "config.json")) } as TeamConfig;
  try {
    const report = migrateToPersonas({ teamDir, config: cfg, db, saveConfig: () => {}, log: () => {} });
    // Same body as the first run's pizzaiolo-2: reused, not pizzaiolo-3.
    assertEquals(report.contextPersonaIds, { pizzaiolo: "pizzaiolo-2" });
    assertEquals(exists(teamDir, "personas/pizzaiolo-3.md"), false);
    assertEquals(report.archivedTo, "context.migrated-2");
    // Nothing is attached any more, so nothing is inlined twice.
    assertEquals(report.inlined, []);
    assertEquals(read(teamDir, "tasks/s1-1/workdef.md").split("`api-style`").length - 1, 1);
  } finally { db.close(); fs.rmSync(teamDir, { recursive: true, force: true }); }
});

test("migration: a team with nothing legacy is left alone (no persona dir, no config write)", () => {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-mig-"));
  try {
    new Store(teamDir, structuredClone(TEST_CONFIG)).close();
    assertEquals(exists(teamDir, "personas"), false);
    assertEquals(exists(teamDir, "config.json"), false);
  } finally { fs.rmSync(teamDir, { recursive: true, force: true }); }
});
