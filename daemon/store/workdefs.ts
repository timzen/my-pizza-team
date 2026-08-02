/**
 * daemon/store/workdefs.ts — On-disk IO for standalone WorkDefs (Solitary +
 * Scheduled work). See docs/FRONTIER_ENGINEER_REFACTOR_PLAN.md.
 *
 * Each WorkDef is a directory under `<teamDir>/tasks/<id>/`:
 *   - `workdef.md` — markdown + frontmatter (the human-authored definition)
 *   - `comments.jsonl` — the per-def comment/run thread (owned by the ref)
 *   - `attachments/` — uploaded files
 *
 * Storage is markdown (not JSON) per the refactor decision: frontmatter carries
 * metadata; the body carries the Goal / Acceptance Criteria / Additional Context
 * sections, round-tripped by those exact headers.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { slugify, type WorkDef, type WorkDefType, WORKDEFS_DIR } from "../../shared/types.ts";

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
  fm.push(`type: ${def.type}`);
  if (def.directory) fm.push(`directory: ${quote(def.directory)}`);
  if (def.cron) fm.push(`cron: ${quote(def.cron)}`);
  if (def.contextRefs && def.contextRefs.length > 0) fm.push(`contextRefs: [${def.contextRefs.join(", ")}]`);
  if (def.lastEnqueuedAt) fm.push(`lastEnqueuedAt: ${def.lastEnqueuedAt}`);
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

  const type = (scalar(fm, "type") as WorkDefType) || "Solitary";
  const def: WorkDef = {
    id,
    title: scalar(fm, "title") || id,
    type: type === "Scheduled" ? "Scheduled" : "Solitary",
    goal: section(body, GOAL_H, ACCEPT_H),
    acceptanceCriteria: section(body, ACCEPT_H, CONTEXT_H),
  };
  const additional = section(body, CONTEXT_H, null);
  if (additional) def.additionalContext = additional;
  const dir = scalar(fm, "directory");
  if (dir) def.directory = dir;
  const cron = scalar(fm, "cron");
  if (cron) def.cron = cron;
  const refs = list(fm, "contextRefs");
  if (refs.length > 0) def.contextRefs = refs;
  const last = scalar(fm, "lastEnqueuedAt");
  if (last) def.lastEnqueuedAt = last;
  return def;
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

/** Create/overwrite a WorkDef; id derived from title (deduped). */
export function saveWorkDef(teamDir: string, input: {
  title: string; type?: WorkDefType; goal: string; acceptanceCriteria: string;
  additionalContext?: string; contextRefs?: string[]; directory?: string; cron?: string;
}): WorkDef {
  const baseId = slugify(input.title) || "task";
  let id = baseId;
  let n = 2;
  while (existsSync(workDefDir(teamDir, id))) { id = `${baseId}-${n}`; n++; }

  const def: WorkDef = {
    id,
    title: input.title,
    type: input.type === "Scheduled" ? "Scheduled" : "Solitary",
    goal: input.goal,
    acceptanceCriteria: input.acceptanceCriteria,
  };
  if (input.additionalContext) def.additionalContext = input.additionalContext;
  if (input.contextRefs && input.contextRefs.length > 0) def.contextRefs = input.contextRefs;
  if (input.directory) def.directory = input.directory;
  if (input.cron) def.cron = input.cron;

  writeWorkDef(teamDir, def);
  return def;
}

export function updateWorkDef(teamDir: string, id: string, updates: {
  title?: string; type?: WorkDefType; goal?: string; acceptanceCriteria?: string;
  additionalContext?: string | null; contextRefs?: string[] | null;
  directory?: string | null; cron?: string | null; lastEnqueuedAt?: string;
}): WorkDef | null {
  const def = getWorkDef(teamDir, id);
  if (!def) return null;
  if (updates.title !== undefined) def.title = updates.title;
  if (updates.type !== undefined) def.type = updates.type;
  if (updates.goal !== undefined) def.goal = updates.goal;
  if (updates.acceptanceCriteria !== undefined) def.acceptanceCriteria = updates.acceptanceCriteria;
  if (updates.additionalContext !== undefined) def.additionalContext = updates.additionalContext || undefined;
  if (updates.contextRefs !== undefined) def.contextRefs = updates.contextRefs || undefined;
  if (updates.directory !== undefined) def.directory = updates.directory || undefined;
  if (updates.cron !== undefined) def.cron = updates.cron || undefined;
  if (updates.lastEnqueuedAt !== undefined) def.lastEnqueuedAt = updates.lastEnqueuedAt;
  writeWorkDef(teamDir, def);
  return def;
}

export function deleteWorkDef(teamDir: string, id: string): boolean {
  const dir = workDefDir(teamDir, id);
  if (!existsSync(dir)) return false;
  Deno.removeSync(dir, { recursive: true });
  return true;
}

function writeWorkDef(teamDir: string, def: WorkDef): void {
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
