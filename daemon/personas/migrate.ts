/**
 * daemon/personas/migrate.ts — One-time, on-load migration to the persona library.
 *
 * Runs at Store construction, before workflows load (docs/DESIGN.md "Migration:
 * on load, lossless, idempotent"). Each step is guarded by "is the old thing
 * still there?", so it is a no-op on a migrated team and a crash midway is
 * finished by the next start; when anything changed, the run ends in one
 * autocommit, `mpt: migrate to personas`.
 *
 * 1. `workflows/<wf>/<state>.md` → persona `<wf>-<state>` + the state's `persona`.
 * 2. `triage.md` → persona `triage` + config `triage.persona`.
 * 3. (Triage-mode sources' `sourcePersonas` seed — needs sources loaded; the
 *    Work Source persona code does it after plugin load.)
 * 4. Context entries tagged `persona` → team personas (same id; tag kept).
 * 5. The SQLite `assistant_persona` setting → config `assistant.persona`; chat
 *    sessions' `persona_id` and snapshot frontmatter remapped through step 4.
 * 6. Attached context (story `context`, WorkDef/template `contextRefs`) is
 *    inlined into each WorkDef's Additional Context under a heading naming the
 *    entry, then the attachment is dropped from the file.
 * 7. `context/` → `context.migrated/` (with a README), and a one-line notice.
 *
 * **Id collisions** (every step that creates a persona): an existing
 * `personas/<id>.md` with the *same* body is reused; otherwise `<id>-2`, `-3`…,
 * and the mapping records the rename so references follow it.
 *
 * Config writes go through the Store's `saveConfig` (the same path `PUT
 * /api/config` uses), so the in-memory config matches the file.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { parseFrontmatter } from "../../shared/frontmatter.ts";
import {
  ARCHIVED_DIR, ASSISTANT_DIR, ASSISTANT_SESSIONS_DIR, CONTEXT_ARCHIVE_DIR, LEGACY_CONTEXT_DIR,
  LEGACY_TRIAGE_INSTRUCTIONS_FILE, STORIES_DIR, TEMPLATES_DIR, WORKDEFS_DIR, WORKFLOWS_DIR,
  type PersonaKind, type TeamConfig, type WorkflowConfig,
} from "../../shared/types.ts";
import { parseWorkDef, serializeWorkDef } from "../store/workdefs.ts";
import { normalizeInstructionMarkdown } from "../prompt.ts";
import { freeTeamPersonaId, readTeamPersona, writeTeamPersona } from "./library.ts";

/** The settings key the notice is kept under (dismissed = deleted). */
export const CONTEXT_NOTICE_KEY = "notice:context-library-removed";
/** The former SQLite setting holding the assistant's context-entry persona id. */
export const LEGACY_ASSISTANT_PERSONA_SETTING = "assistant_persona";

/** What the migration needs from the Store. */
export interface MigrationEnv {
  teamDir: string;
  /** The Store's in-memory config; mutated in place, then `saveConfig` persists it. */
  config: TeamConfig;
  saveConfig: () => void;
  /** The Store's database: settings (`assistant_persona`, the notice) and `assistant_sessions`. */
  db: DatabaseSync;
  log?: (message: string) => void;
  /** Commit the team dir (the Store's git autocommit); called once, when anything changed. */
  commit?: (message: string) => void;
}

/** What one run did (for tests and the startup log). */
export interface MigrationReport {
  changed: boolean;
  /** Persona ids created (or reused) by this run, in order. */
  personas: string[];
  /** Former context-entry id → persona id, for every entry step 4/5 migrated. */
  contextPersonaIds: Record<string, string>;
  /** Context-entry ids inlined into some WorkDef's Additional Context. */
  inlined: string[];
  /** Where `context/` was archived to, when it was. */
  archivedTo?: string;
  /** The notice line, when one was raised. */
  notice?: string;
}

/** The marker an inlined entry's heading carries; also what makes re-inlining a no-op. */
function inlineMarker(id: string): string {
  return `(from the former context library, \`${id}\`)`;
}

/** A former context entry, as the migration reads it. */
interface LegacyEntry { id: string; title: string; description: string; tags: string[]; content: string }

/** Run every step. Never throws: a step that fails is logged and the rest still run. */
export function migrateToPersonas(env: MigrationEnv): MigrationReport {
  const log = env.log ?? ((m: string) => console.warn(`[personas] ${m}`));
  const report: MigrationReport = { changed: false, personas: [], contextPersonaIds: {}, inlined: [] };
  let configDirty = false;

  /** Create (or reuse an identical) team persona; returns its id. */
  const createPersona = (base: string, title: string, kinds: PersonaKind[], body: string, tags: string[] = [], description = ""): string => {
    const id = freeTeamPersonaId(base, (candidate) => {
      const existing = readTeamPersona(env.teamDir, candidate);
      return existing !== null && existing.content.trim() !== body.trim();
    });
    if (!readTeamPersona(env.teamDir, id)) {
      writeTeamPersona(env.teamDir, id, { title, description, tags, kinds, content: body });
    }
    report.personas.push(id);
    report.changed = true;
    return id;
  };

  const step = (name: string, fn: () => void) => {
    try { fn(); } catch (e) { log(`migration step "${name}" failed: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // 1. Workflow state files.
  step("workflow state files", () => {
    const dir = path.join(env.teamDir, WORKFLOWS_DIR);
    if (!existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const wfDir = path.join(dir, entry.name);
      const wfFile = path.join(wfDir, "workflow.json");
      if (!existsSync(wfFile)) continue;
      let wf: WorkflowConfig;
      try { wf = JSON.parse(fs.readFileSync(wfFile, "utf8")) as WorkflowConfig; } catch { continue; }
      if (!Array.isArray(wf.states)) continue;
      let wfDirty = false;
      for (const state of wf.states) {
        if (!state || typeof state.name !== "string" || state.type !== "agent") continue;
        const mdFile = path.join(wfDir, `${state.name}.md`);
        if (!existsSync(mdFile)) continue;
        if (state.persona) {
          log(`workflows/${entry.name}/${state.name}.md is left alone: state '${state.name}' already names persona '${state.persona}'`);
          continue;
        }
        const body = fs.readFileSync(mdFile, "utf8");
        if (body.trim()) {
          state.persona = createPersona(`${entry.name}-${state.name}`, `${capitalize(entry.name)} — ${state.name}`, ["worker"], body);
          wfDirty = true;
        }
        // An empty file meant "no persona" (the one-line framing); it carries nothing.
        fs.rmSync(mdFile);
        report.changed = true;
      }
      if (wfDirty) fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + "\n");
    }
  });

  // 2. triage.md.
  step("triage.md", () => {
    const file = path.join(env.teamDir, LEGACY_TRIAGE_INSTRUCTIONS_FILE);
    if (!existsSync(file)) return;
    if (env.config.triage?.persona) {
      log(`${LEGACY_TRIAGE_INSTRUCTIONS_FILE} is left alone: triage.persona is already '${env.config.triage.persona}'`);
      return;
    }
    const body = fs.readFileSync(file, "utf8");
    if (body.trim()) {
      const id = createPersona("triage", "Triage", ["triage"], body);
      env.config.triage = { ...env.config.triage, persona: id };
      configDirty = true;
    }
    fs.rmSync(file);
    report.changed = true;
  });

  // Steps 4–7 read the former context library.
  const contextDir = path.join(env.teamDir, LEGACY_CONTEXT_DIR);
  const entries = readLegacyEntries(contextDir);

  // 4. Persona-tagged context entries → personas (same id, collision rule).
  step("persona-tagged context entries", () => {
    for (const e of entries.values()) {
      if (!e.tags.includes("persona")) continue;
      report.contextPersonaIds[e.id] = createPersona(e.id, e.title, ["assistant"], e.content, e.tags, e.description);
    }
  });

  // 5. Assistant selection + chat sessions.
  step("assistant persona", () => {
    const row = env.db.prepare("SELECT value FROM settings WHERE key = ?").get(LEGACY_ASSISTANT_PERSONA_SETTING) as { value: string } | undefined;
    if (row) {
      const old = row.value;
      if (!env.config.assistant?.persona) {
        // The UI only offered persona-tagged entries, but the API took any entry.
        let mapped = report.contextPersonaIds[old];
        const entry = entries.get(old);
        if (!mapped && entry) {
          mapped = createPersona(entry.id, entry.title, ["assistant"], entry.content, entry.tags, entry.description);
          report.contextPersonaIds[old] = mapped;
        }
        if (mapped) {
          env.config.assistant = { ...env.config.assistant, persona: mapped };
          configDirty = true;
        } else {
          log(`the assistant's persona '${old}' no longer exists (it already used the default) — dropped`);
        }
      }
      env.db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_ASSISTANT_PERSONA_SETTING);
      report.changed = true;
    }
    // Sessions keep their denormalized persona; only ids a collision renamed change.
    for (const [from, to] of Object.entries(report.contextPersonaIds)) {
      if (from === to) continue;
      env.db.prepare("UPDATE assistant_sessions SET persona_id = ? WHERE persona_id = ?").run(to, from);
      remapSnapshotPersona(env.teamDir, from, to);
    }
  });

  // 6. Attached context → Additional Context.
  step("attached context", () => {
    const storyContext = readStoryContext(env.teamDir);
    const sectionFor = (id: string): string | null => {
      const e = entries.get(id);
      if (!e) return null; // a deleted entry contributed nothing
      return `### Reference: ${e.title} ${inlineMarker(id)}\n\n${normalizeInstructionMarkdown(e.content.trim(), 4)}`;
    };
    const inline = (file: string, defId: string, inherited: string[]): boolean => {
      const raw = fs.readFileSync(file, "utf8");
      const own = frontmatterList(raw, "contextRefs");
      const hasRefsLine = /^contextRefs:/m.test(frontmatterOf(raw));
      const ids = [...new Set([...inherited, ...own])];
      if (ids.length === 0 && !hasRefsLine) return false;
      const def = parseWorkDef(defId, raw);
      if (!def) return false;
      const existing = def.additionalContext ?? "";
      const sections: string[] = [];
      for (const id of ids) {
        if (existing.includes(inlineMarker(id))) continue; // already inlined (a re-run)
        const s = sectionFor(id);
        if (!s) continue;
        sections.push(s);
        if (!report.inlined.includes(id)) report.inlined.push(id);
      }
      if (sections.length === 0 && !hasRefsLine) return false;
      if (sections.length > 0) def.additionalContext = [existing.trim(), ...sections].filter(Boolean).join("\n\n");
      // serializeWorkDef writes no contextRefs, so the attachment is dropped here.
      fs.writeFileSync(file, serializeWorkDef(def) + "\n");
      return true;
    };

    const defsDir = path.join(env.teamDir, WORKDEFS_DIR);
    if (existsSync(defsDir)) {
      for (const entry of fs.readdirSync(defsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(defsDir, entry.name, "workdef.md");
        if (!existsSync(file)) continue;
        const raw = fs.readFileSync(file, "utf8");
        const fm = frontmatterOf(raw);
        // Mirrors are written only by sync, and never carried attachments.
        if (/^parentKind:\s*external\s*$/m.test(fm)) continue;
        const storyId = /^parentKind:\s*story\s*$/m.test(fm) ? scalarOf(fm, "parentId") : "";
        const inherited = storyId ? (storyContext.get(storyId) ?? []) : [];
        if (inline(file, entry.name, inherited)) report.changed = true;
      }
    }
    const tplDir = path.join(env.teamDir, TEMPLATES_DIR);
    if (existsSync(tplDir)) {
      for (const entry of fs.readdirSync(tplDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(tplDir, entry.name, "template.md");
        if (existsSync(file) && inline(file, entry.name, [])) report.changed = true;
      }
    }
    // Only once every child carries the text does the story drop its list.
    for (const dir of [STORIES_DIR, ARCHIVED_DIR]) {
      const storiesDir = path.join(env.teamDir, dir);
      if (!existsSync(storiesDir)) continue;
      for (const entry of fs.readdirSync(storiesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(storiesDir, entry.name);
        let data: Record<string, unknown>;
        try { data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; } catch { continue; }
        if (!("context" in data)) continue;
        delete data.context;
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
        report.changed = true;
      }
    }
  });

  // 7. Archive context/.
  step("archive context/", () => {
    if (!existsSync(contextDir)) return;
    let target = path.join(env.teamDir, CONTEXT_ARCHIVE_DIR);
    for (let n = 2; existsSync(target); n++) target = path.join(env.teamDir, `${CONTEXT_ARCHIVE_DIR}-${n}`);
    fs.renameSync(contextDir, target);
    fs.writeFileSync(path.join(target, "README.md"), archiveReadme());
    report.archivedTo = path.basename(target);
    report.changed = true;
    const attached = report.inlined.length;
    const unattached = [...entries.keys()].filter((id) => !report.inlined.includes(id) && !(id in report.contextPersonaIds)).length;
    report.notice =
      `The context library was removed: ${attached} attached ${attached === 1 ? "entry was" : "entries were"} inlined into ` +
      `${attached === 1 ? "its" : "their"} tasks' Additional Context; ${unattached} unattached ${unattached === 1 ? "entry is" : "entries are"} in ` +
      `${report.archivedTo}/ — turn the useful ones into personas, or move project knowledge into the project's AGENTS.md.`;
    log(report.notice);
    env.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(CONTEXT_NOTICE_KEY, report.notice);
  });

  if (configDirty) env.saveConfig();
  if (report.changed) {
    log(`migrated to personas${report.personas.length > 0 ? ` (personas: ${report.personas.join(", ")})` : ""}`);
    env.commit?.("mpt: migrate to personas");
  }
  return report;
}

/** Read every `context/<id>.md` (the former library's format; title falls back to `# ` heading, then id). */
function readLegacyEntries(dir: string): Map<string, LegacyEntry> {
  const out = new Map<string, LegacyEntry>();
  if (!existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const id = e.name.slice(0, -3);
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, e.name), "utf8"));
    const firstLine = body.trim().split("\n")[0] ?? "";
    const title = meta.title || (firstLine.startsWith("# ") ? firstLine.slice(2).trim() : id);
    out.set(id, { id, title, description: meta.description, tags: meta.tags, content: body });
  }
  return out;
}

/** Story id → its attached context ids, from active and archived story files. */
function readStoryContext(teamDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const dir of [STORIES_DIR, ARCHIVED_DIR]) {
    const storiesDir = path.join(teamDir, dir);
    if (!existsSync(storiesDir)) continue;
    for (const entry of fs.readdirSync(storiesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(storiesDir, entry.name), "utf8")) as { id?: string; context?: unknown };
        if (typeof data.id === "string" && Array.isArray(data.context)) {
          out.set(data.id, data.context.filter((c): c is string => typeof c === "string"));
        }
      } catch { /* malformed: loadFromDisk skips it too */ }
    }
  }
  return out;
}

/** Rewrite a session snapshot's `persona:` frontmatter line from one id to another. */
function remapSnapshotPersona(teamDir: string, from: string, to: string): void {
  const dir = path.join(teamDir, ASSISTANT_DIR, ASSISTANT_SESSIONS_DIR);
  if (!existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    const raw = fs.readFileSync(file, "utf8");
    const fm = frontmatterOf(raw);
    if (scalarOf(fm, "persona") !== from) continue;
    const next = raw.replace(/^persona: .*$/m, `persona: ${/[:#[\]"']/.test(to) ? JSON.stringify(to) : to}`);
    fs.writeFileSync(file, next);
  }
}

function archiveReadme(): string {
  return [
    "# The former context library",
    "",
    "MPT no longer has a context library: nothing reads this directory. It was archived",
    "here by the persona migration (docs/DESIGN.md \"Personas\" — Migration):",
    "",
    "- entries tagged `persona` became team personas (`personas/<id>.md`);",
    "- entries attached to stories, tasks, or templates were inlined into those tasks'",
    "  Additional Context, under a heading naming the entry;",
    "- everything else is only here. Turn the useful ones into personas (how to do the",
    "  work), or move project knowledge into the project's own AGENTS.md / README.",
    "",
  ].join("\n");
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function frontmatterOf(raw: string): string {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? (m[1] ?? "") : "";
}

function scalarOf(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "") : "";
}

function frontmatterList(raw: string, key: string): string[] {
  const m = frontmatterOf(raw).match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return [];
  return (m[1] ?? "").split(",").map((t) => t.trim().replace(/['"]/g, "")).filter(Boolean);
}
