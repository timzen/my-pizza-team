/**
 * daemon/store/workdefs.ts — On-disk IO for WorkDefs (every unit of work).
 * See docs/WORKDEF_UNIFICATION.md.
 *
 * Each WorkDef is a directory under `<teamDir>/tasks/<id>/`:
 *   - `workdef.md` — markdown + frontmatter (the human-authored definition)
 *   - `comments.jsonl` — the per-def comment/run thread (owned by the ref)
 *   - `attachments/` — uploaded files
 *
 * A WorkDef is *authored content only* — the daemon never rewrites this file
 * except on an explicit human/agent edit. All mutable runtime state lives off
 * the markdown: workflow status on the Story, cron/lastEnqueuedAt on the
 * Schedule. Frontmatter carries only structural metadata (title, parent,
 * directory, contextRefs); the body carries Goal / Acceptance Criteria /
 * Additional Context, round-tripped by those exact headers.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { slugify, type WorkDef, type WorkDefParent, type WorkDefParentKind, WORKDEFS_DIR } from "../../shared/types.ts";

const FILE = "workdef.md";
const GOAL_H = "## Goal";
const ACCEPT_H = "## Acceptance Criteria";
const CONTEXT_H = "## Additional Context";

function defsDir(teamDir: string): string {
  return path.join(teamDir, WORKDEFS_DIR);
}

/** Directory holding a WorkDef's file, comments, and attachments. */
export function workDefDir(teamDir: string, id: string): string {
  return path.join(defsDir(teamDir), id);
}

/** Serialize a WorkDef to its markdown+frontmatter file body. */
export function serializeWorkDef(def: WorkDef): string {
  const fm: string[] = ["---"];
  fm.push(`title: ${quote(def.title)}`);
  if (def.parent) {
    fm.push(`parentKind: ${def.parent.kind}`);
    fm.push(`parentId: ${quote(def.parent.id)}`);
  }
  if (def.directory) fm.push(`directory: ${quote(def.directory)}`);
  if (def.contextRefs && def.contextRefs.length > 0) fm.push(`contextRefs: [${def.contextRefs.join(", ")}]`);
  fm.push("---");
  const body = [
    GOAL_H, "", def.goal.trim(), "",
    ACCEPT_H, "", def.acceptanceCriteria.trim(), "",
    CONTEXT_H, "", (def.additionalContext || "").trim(), "",
  ].join("\n");
  return `${fm.join("\n")}\n${body}`;
}

/** Parse a WorkDef markdown file. Returns null when the frontmatter is missing. */
export function parseWorkDef(id: string, raw: string): WorkDef | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1] ?? "";
  const body = m[2] ?? "";

  const def: WorkDef = {
    id,
    title: scalar(fm, "title") || id,
    goal: section(body, GOAL_H, ACCEPT_H),
    acceptanceCriteria: section(body, ACCEPT_H, CONTEXT_H),
  };
  const additional = section(body, CONTEXT_H, null);
  if (additional) def.additionalContext = additional;
  const parent = parseParent(fm);
  if (parent) def.parent = parent;
  const dir = scalar(fm, "directory");
  if (dir) def.directory = dir;
  const refs = list(fm, "contextRefs");
  if (refs.length > 0) def.contextRefs = refs;
  return def;
}

/** Read the parent pointer from frontmatter (parentKind + parentId). */
function parseParent(fm: string): WorkDefParent | undefined {
  const kind = scalar(fm, "parentKind");
  const id = scalar(fm, "parentId");
  if ((kind === "story" || kind === "schedule") && id) {
    return { kind: kind as WorkDefParentKind, id };
  }
  return undefined;
}

/** List all WorkDefs on disk, sorted by id. */
export function listWorkDefs(teamDir: string): WorkDef[] {
  const dir = defsDir(teamDir);
  if (!existsSync(dir)) return [];
  const out: WorkDef[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isDirectory) continue;
    const def = getWorkDef(teamDir, entry.name);
    if (def) out.push(def);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getWorkDef(teamDir: string, id: string): WorkDef | null {
  const file = path.join(workDefDir(teamDir, id), FILE);
  if (!existsSync(file)) return null;
  return parseWorkDef(id, Deno.readTextFileSync(file));
}

/** Create a WorkDef; id derived from title (deduped) unless one is supplied. */
export function saveWorkDef(teamDir: string, input: {
  id?: string; title: string; parent?: WorkDefParent; goal: string; acceptanceCriteria: string;
  additionalContext?: string; contextRefs?: string[]; directory?: string;
}): WorkDef {
  let id = input.id;
  if (!id) {
    const baseId = slugify(input.title) || "task";
    id = baseId;
    let n = 2;
    while (existsSync(workDefDir(teamDir, id))) { id = `${baseId}-${n}`; n++; }
  }

  const def: WorkDef = {
    id,
    title: input.title,
    goal: input.goal,
    acceptanceCriteria: input.acceptanceCriteria,
  };
  if (input.parent) def.parent = input.parent;
  if (input.additionalContext) def.additionalContext = input.additionalContext;
  if (input.contextRefs && input.contextRefs.length > 0) def.contextRefs = input.contextRefs;
  if (input.directory) def.directory = input.directory;

  writeWorkDef(teamDir, def);
  return def;
}

export function updateWorkDef(teamDir: string, id: string, updates: {
  title?: string; parent?: WorkDefParent | null; goal?: string; acceptanceCriteria?: string;
  additionalContext?: string | null; contextRefs?: string[] | null; directory?: string | null;
}): WorkDef | null {
  const def = getWorkDef(teamDir, id);
  if (!def) return null;
  if (updates.title !== undefined) def.title = updates.title;
  if (updates.parent !== undefined) def.parent = updates.parent || undefined;
  if (updates.goal !== undefined) def.goal = updates.goal;
  if (updates.acceptanceCriteria !== undefined) def.acceptanceCriteria = updates.acceptanceCriteria;
  if (updates.additionalContext !== undefined) def.additionalContext = updates.additionalContext || undefined;
  if (updates.contextRefs !== undefined) def.contextRefs = updates.contextRefs || undefined;
  if (updates.directory !== undefined) def.directory = updates.directory || undefined;
  writeWorkDef(teamDir, def);
  return def;
}

export function deleteWorkDef(teamDir: string, id: string): boolean {
  const dir = workDefDir(teamDir, id);
  if (!existsSync(dir)) return false;
  Deno.removeSync(dir, { recursive: true });
  return true;
}

export function writeWorkDef(teamDir: string, def: WorkDef): void {
  const dir = workDefDir(teamDir, def.id);
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(path.join(dir, FILE), serializeWorkDef(def) + "\n");
}

// ─── frontmatter/body helpers ──────────────────────────────────────

function quote(v: string): string {
  if (v === "") return '""';
  return /[:#\[\]"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}
function scalar(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "") : "";
}
function list(fm: string, key: string): string[] {
  const m = fm.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return [];
  return (m[1] ?? "").split(",").map((t) => t.trim().replace(/['"]/g, "")).filter(Boolean);
}
/** Extract the text between section header `from` and the next header `to` (or EOF). */
function section(body: string, from: string, to: string | null): string {
  const start = body.indexOf(from);
  if (start < 0) return "";
  const afterHeader = start + from.length;
  const end = to ? body.indexOf(to, afterHeader) : body.length;
  return body.slice(afterHeader, end < 0 ? body.length : end).trim();
}
