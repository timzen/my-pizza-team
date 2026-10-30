/**
 * daemon/store/workdefs.ts — On-disk IO for WorkDefs (every unit of work).
 * See docs/DESIGN.md "WorkDefs & Parents".
 *
 * Each WorkDef is a directory under `<teamDir>/tasks/<id>/`:
 *   - `workdef.md` — markdown + frontmatter (the human-authored definition)
 *   - `comments.jsonl` — the per-def comment/run thread (owned by the ref)
 *   - `attachments/` — uploaded files
 *
 * A WorkDef is *authored content only* — the daemon never rewrites this file
 * except on an explicit human/agent edit. All mutable runtime state lives off
 * the markdown: workflow status on the Story, cron/lastEnqueuedAt on the
 * Schedule, the note version last triaged on the Thought. Frontmatter carries only structural metadata (title, parent,
 * directory, persona, `pending: true` while pending — legacy `draft: true` reads as pending); the body carries Goal / Acceptance Criteria /
 * Additional Context, round-tripped by those exact headers.
 *
 * The one exception: a **mirrored** WorkDef (`parentKind: external`, plus
 * `parentSource` and `url`) is authored in an external system and written only
 * by its source's sync (daemon/sources/mirror.ts) — never by an MPT edit.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { slugify, type WorkDef, type WorkDefOrigin, type WorkDefParent, type WorkDefParentKind, WORKDEFS_DIR } from "../../shared/types.ts";

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
    if (def.parent.source) fm.push(`parentSource: ${quote(def.parent.source)}`);
  }
  // A mirrored def's link back to its external item (mirrored content, written by sync).
  if (def.url) fm.push(`url: ${quote(def.url)}`);
  if (def.directory) fm.push(`directory: ${quote(def.directory)}`);
  // The persona this work runs with (Solitary/Scheduled; a mirror's source suggestion).
  if (def.persona) fm.push(`persona: ${quote(def.persona)}`);
  if (def.status === "archived") fm.push(`status: archived`);
  // Only pending is marked; absence means active (the default for old files).
  // A legacy `draft: true` file is rewritten as `pending: true` on its next save.
  if (def.pending) fm.push(`pending: true`);
  // Where an accepted triage proposal turned into this work (structural, not authored).
  if (def.origin) {
    if (def.origin.thought) fm.push(`originThought: ${quote(def.origin.thought)}`);
    if (def.origin.workDef) fm.push(`originWorkDef: ${quote(def.origin.workDef)}`);
    fm.push(`originProposal: ${quote(def.origin.proposal)}`);
  }
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
    status: scalar(fm, "status") === "archived" ? "archived" : "active",
  };
  const additional = section(body, CONTEXT_H, null);
  if (additional) def.additionalContext = additional;
  // `draft: true` is the pre-rename spelling of pending (docs/DESIGN.md
  // "Pending: Write, Review, Activate"); both load as pending.
  if (scalar(fm, "pending") === "true" || scalar(fm, "draft") === "true") def.pending = true;
  const parent = parseParent(fm);
  if (parent) def.parent = parent;
  const dir = scalar(fm, "directory");
  if (dir) def.directory = dir;
  const persona = scalar(fm, "persona");
  if (persona) def.persona = persona;
  const origin = parseOrigin(fm);
  if (origin) def.origin = origin;
  const url = scalar(fm, "url");
  if (url) def.url = url;
  return def;
}

/**
 * Read the parent pointer from frontmatter (parentKind + parentId, and for an
 * external mirror its parentSource — without one it isn't attributable, so no parent).
 */
function parseParent(fm: string): WorkDefParent | undefined {
  const kind = scalar(fm, "parentKind");
  const id = scalar(fm, "parentId");
  if ((kind === "story" || kind === "schedule" || kind === "thought") && id) {
    return { kind: kind as WorkDefParentKind, id };
  }
  const source = scalar(fm, "parentSource");
  if (kind === "external" && id && source) return { kind: "external", id, source };
  return undefined;
}

/**
 * Read the triage origin from frontmatter: originProposal plus the subject —
 * originThought (a note) or originWorkDef (a triage-mode mirrored WorkDef).
 */
function parseOrigin(fm: string): WorkDefOrigin | undefined {
  const thought = scalar(fm, "originThought");
  const workDef = scalar(fm, "originWorkDef");
  const proposal = scalar(fm, "originProposal");
  if (!proposal) return undefined;
  if (thought) return { thought, proposal };
  return workDef ? { workDef, proposal } : undefined;
}

/** List all WorkDefs on disk, sorted by id. */
export function listWorkDefs(teamDir: string): WorkDef[] {
  const dir = defsDir(teamDir);
  if (!existsSync(dir)) return [];
  const out: WorkDef[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const def = getWorkDef(teamDir, entry.name);
    if (def) out.push(def);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getWorkDef(teamDir: string, id: string): WorkDef | null {
  const file = path.join(workDefDir(teamDir, id), FILE);
  if (!existsSync(file)) return null;
  return parseWorkDef(id, fs.readFileSync(file, "utf8"));
}

/** Create a WorkDef; id derived from title (deduped) unless one is supplied. */
export function saveWorkDef(teamDir: string, input: {
  id?: string; title: string; parent?: WorkDefParent; goal: string; acceptanceCriteria: string;
  additionalContext?: string; directory?: string; origin?: WorkDefOrigin;
  pending?: boolean; persona?: string;
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
  if (input.persona) def.persona = input.persona;
  if (input.directory) def.directory = input.directory;
  if (input.origin) def.origin = input.origin;
  if (input.pending) def.pending = true;

  writeWorkDef(teamDir, def);
  return def;
}

export function updateWorkDef(teamDir: string, id: string, updates: {
  title?: string; parent?: WorkDefParent | null; goal?: string; acceptanceCriteria?: string;
  additionalContext?: string | null; directory?: string | null; persona?: string | null;
  status?: "active" | "archived"; origin?: WorkDefOrigin;
  /** `false` activates a pending WorkDef (see WorkDef.pending); pending is only set at creation, never re-entered. */
  pending?: boolean;
}): WorkDef | null {
  const def = getWorkDef(teamDir, id);
  if (!def) return null;
  if (updates.title !== undefined) def.title = updates.title;
  if (updates.parent !== undefined) def.parent = updates.parent || undefined;
  if (updates.goal !== undefined) def.goal = updates.goal;
  if (updates.acceptanceCriteria !== undefined) def.acceptanceCriteria = updates.acceptanceCriteria;
  if (updates.additionalContext !== undefined) def.additionalContext = updates.additionalContext || undefined;
  if (updates.persona !== undefined) def.persona = updates.persona || undefined;
  if (updates.directory !== undefined) def.directory = updates.directory || undefined;
  if (updates.status !== undefined) def.status = updates.status;
  if (updates.origin !== undefined) def.origin = updates.origin;
  if (updates.pending !== undefined) def.pending = updates.pending || undefined;
  writeWorkDef(teamDir, def);
  return def;
}

export function deleteWorkDef(teamDir: string, id: string): boolean {
  const dir = workDefDir(teamDir, id);
  if (!existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true });
  return true;
}

export function writeWorkDef(teamDir: string, def: WorkDef): void {
  const dir = workDefDir(teamDir, def.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), serializeWorkDef(def) + "\n");
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
/** Extract the text between section header `from` and the next header `to` (or EOF). */
function section(body: string, from: string, to: string | null): string {
  const start = body.indexOf(from);
  if (start < 0) return "";
  const afterHeader = start + from.length;
  const end = to ? body.indexOf(to, afterHeader) : body.length;
  return body.slice(afterHeader, end < 0 ? body.length : end).trim();
}
