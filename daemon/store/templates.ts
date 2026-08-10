/**
 * daemon/store/templates.ts — On-disk IO for Task Templates.
 *
 * A Template is a reusable *mold* for a Solitary task: the same authored fields
 * as a WorkDef (title / goal / acceptance criteria / additional context /
 * directory / contextRefs) but with NO parent and NO runtime state. It never
 * enqueues a WorkItem and never appears in the WorkItem queue — it exists only
 * to pre-fill a new Solitary WorkDef. Stored as `templates/<id>/template.md`,
 * reusing the WorkDef markdown format (files are the source of truth, like
 * Schedules/Thoughts — no SQLite index). See docs/ARCHITECTURE.md "Templates".
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { slugify, type Template, TEMPLATES_DIR } from "../../shared/types.ts";
import { serializeWorkDef, parseWorkDef } from "./workdefs.ts";

const FILE = "template.md";

function templatesDir(teamDir: string): string {
  return path.join(teamDir, TEMPLATES_DIR);
}

/** Directory holding a Template's file. */
export function templateDir(teamDir: string, id: string): string {
  return path.join(templatesDir(teamDir), id);
}

/** Strip any (never-present) parent from a parsed WorkDef to yield a Template. */
function toTemplate(id: string, raw: string): Template | null {
  const def = parseWorkDef(id, raw);
  if (!def) return null;
  const tpl: Template = { id: def.id, title: def.title, goal: def.goal, acceptanceCriteria: def.acceptanceCriteria };
  if (def.additionalContext) tpl.additionalContext = def.additionalContext;
  if (def.contextRefs && def.contextRefs.length > 0) tpl.contextRefs = def.contextRefs;
  if (def.directory) tpl.directory = def.directory;
  return tpl;
}

/** List all Templates on disk, sorted by id. */
export function listTemplates(teamDir: string): Template[] {
  const dir = templatesDir(teamDir);
  if (!existsSync(dir)) return [];
  const out: Template[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isDirectory) continue;
    const tpl = getTemplate(teamDir, entry.name);
    if (tpl) out.push(tpl);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getTemplate(teamDir: string, id: string): Template | null {
  const file = path.join(templateDir(teamDir, id), FILE);
  if (!existsSync(file)) return null;
  return toTemplate(id, Deno.readTextFileSync(file));
}

export function writeTemplate(teamDir: string, tpl: Template): void {
  const dir = templateDir(teamDir, tpl.id);
  Deno.mkdirSync(dir, { recursive: true });
  // A Template is a parent-less WorkDef, so it round-trips through the WorkDef
  // markdown serializer (Goal / Acceptance Criteria / Additional Context).
  Deno.writeTextFileSync(path.join(dir, FILE), serializeWorkDef({ ...tpl }) + "\n");
}

/** Create a Template; id derived from title (deduped) unless one is supplied. */
export function saveTemplate(teamDir: string, input: {
  id?: string; title: string; goal: string; acceptanceCriteria: string;
  additionalContext?: string; contextRefs?: string[]; directory?: string;
}): Template {
  let id = input.id;
  if (!id) {
    const base = slugify(input.title) || "template";
    id = base;
    let n = 2;
    while (existsSync(templateDir(teamDir, id))) { id = `${base}-${n}`; n++; }
  }
  const tpl: Template = { id, title: input.title, goal: input.goal, acceptanceCriteria: input.acceptanceCriteria };
  if (input.additionalContext) tpl.additionalContext = input.additionalContext;
  if (input.contextRefs && input.contextRefs.length > 0) tpl.contextRefs = input.contextRefs;
  if (input.directory) tpl.directory = input.directory;
  writeTemplate(teamDir, tpl);
  return tpl;
}

export function updateTemplate(teamDir: string, id: string, updates: {
  title?: string; goal?: string; acceptanceCriteria?: string;
  additionalContext?: string | null; contextRefs?: string[] | null; directory?: string | null;
}): Template | null {
  const tpl = getTemplate(teamDir, id);
  if (!tpl) return null;
  if (updates.title !== undefined) tpl.title = updates.title;
  if (updates.goal !== undefined) tpl.goal = updates.goal;
  if (updates.acceptanceCriteria !== undefined) tpl.acceptanceCriteria = updates.acceptanceCriteria;
  if (updates.additionalContext !== undefined) tpl.additionalContext = updates.additionalContext || undefined;
  if (updates.contextRefs !== undefined) tpl.contextRefs = updates.contextRefs || undefined;
  if (updates.directory !== undefined) tpl.directory = updates.directory || undefined;
  writeTemplate(teamDir, tpl);
  return tpl;
}

export function deleteTemplate(teamDir: string, id: string): boolean {
  const dir = templateDir(teamDir, id);
  if (!existsSync(dir)) return false;
  Deno.removeSync(dir, { recursive: true });
  return true;
}
