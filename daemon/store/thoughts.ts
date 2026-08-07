/**
 * daemon/store/thoughts.ts — On-disk IO for Thoughts (markdown sticky notes)
 * and their groups. See docs/ARCHITECTURE.md "Thoughts".
 *
 * Each note is `<teamDir>/thoughts/<id>.md`: a frontmatter block of structural
 * + canvas metadata over a markdown body (the note content). The filename is
 * the id (no `id:` key in the frontmatter — the file path is the source of
 * truth, same discipline as WorkDefs). Groups are a single `groups.json`
 * (`[{id, title}]`) — membership lives on each note's `groupId`, so a group
 * file only needs its title.
 *
 * This module is pure IO (read/write/parse). The SQLite runtime index, id
 * minting, dirty-flag/flush debouncing, and free-position placement live in
 * store.ts, exactly as workdefs.ts relates to store.ts.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import {
  type Thought,
  type ThoughtGroup,
  THOUGHTS_DIR,
  THOUGHT_GROUPS_FILE,
  DEFAULT_THOUGHT_COLOR,
  DEFAULT_GROUP_SIZE,
} from "../../shared/types.ts";

function thoughtsDir(teamDir: string): string {
  return path.join(teamDir, THOUGHTS_DIR);
}

function thoughtFile(teamDir: string, id: string): string {
  return path.join(thoughtsDir(teamDir), `${id}.md`);
}

// ─── Serialize / Parse ──────────────────────────────────────────────

/** Serialize a Thought to its markdown+frontmatter file body. */
export function serializeThought(t: Thought): string {
  const fm: string[] = ["---"];
  fm.push(`status: ${t.status}`);
  fm.push(`color: ${t.color}`);
  if (t.pinned) fm.push("pinned: true");
  if (t.groupId) fm.push(`groupId: ${quote(t.groupId)}`);
  fm.push(`x: ${t.x}`);
  fm.push(`y: ${t.y}`);
  if (t.w !== null) fm.push(`w: ${t.w}`);
  if (t.h !== null) fm.push(`h: ${t.h}`);
  fm.push(`z: ${t.zIndex}`);
  fm.push(`createdBy: ${quote(t.createdBy)}`);
  fm.push(`createdAt: ${quote(t.createdAt)}`);
  fm.push(`updatedAt: ${quote(t.updatedAt)}`);
  fm.push("---");
  const body = t.content.replace(/^\n+/, "").replace(/\s+$/, "");
  return `${fm.join("\n")}\n${body}\n`;
}

/** Parse a thought markdown file. Returns null when the frontmatter is missing. */
export function parseThought(id: string, raw: string): Thought | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1] ?? "";
  const body = m[2] ?? "";
  const status = scalar(fm, "status") === "archived" ? "archived" : "active";
  return {
    id,
    content: body.replace(/^\n+/, "").replace(/\s+$/, ""),
    color: scalar(fm, "color") || DEFAULT_THOUGHT_COLOR,
    status,
    x: num(fm, "x") ?? 0,
    y: num(fm, "y") ?? 0,
    w: num(fm, "w"),
    h: num(fm, "h"),
    zIndex: num(fm, "z") ?? 0,
    pinned: scalar(fm, "pinned") === "true",
    groupId: scalar(fm, "groupId") || null,
    createdBy: scalar(fm, "createdBy") || "human",
    createdAt: scalar(fm, "createdAt") || "",
    updatedAt: scalar(fm, "updatedAt") || "",
  };
}

// ─── Notes ──────────────────────────────────────────────────────────

/** List all thoughts on disk, sorted by id. */
export function listThoughts(teamDir: string): Thought[] {
  const dir = thoughtsDir(teamDir);
  if (!existsSync(dir)) return [];
  const out: Thought[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    const t = getThought(teamDir, id);
    if (t) out.push(t);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getThought(teamDir: string, id: string): Thought | null {
  const file = thoughtFile(teamDir, id);
  if (!existsSync(file)) return null;
  return parseThought(id, Deno.readTextFileSync(file));
}

/** Write a thought's file (crash-safe: temp then rename). */
export function writeThought(teamDir: string, t: Thought): void {
  const dir = thoughtsDir(teamDir);
  Deno.mkdirSync(dir, { recursive: true });
  atomicWrite(thoughtFile(teamDir, t.id), serializeThought(t) + "\n");
}

export function deleteThoughtFile(teamDir: string, id: string): boolean {
  const file = thoughtFile(teamDir, id);
  if (!existsSync(file)) return false;
  Deno.removeSync(file);
  return true;
}

// ─── Groups (groups.json) ───────────────────────────────────────────

export function listThoughtGroups(teamDir: string): ThoughtGroup[] {
  const file = path.join(teamDir, THOUGHT_GROUPS_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(file));
    if (!Array.isArray(parsed)) return [];
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    return parsed
      .filter((g): g is Record<string, unknown> => !!g && typeof g.id === "string")
      .map((g) => ({
        id: g.id as string,
        title: typeof g.title === "string" ? g.title : "",
        x: n(g.x, 0),
        y: n(g.y, 0),
        w: n(g.w, DEFAULT_GROUP_SIZE.w),
        h: n(g.h, DEFAULT_GROUP_SIZE.h),
      }));
  } catch {
    return [];
  }
}

export function writeThoughtGroups(teamDir: string, groups: ThoughtGroup[]): void {
  atomicWrite(path.join(teamDir, THOUGHT_GROUPS_FILE), JSON.stringify(groups, null, 2) + "\n");
}

// ─── helpers ────────────────────────────────────────────────────────

/** Crash-safe write: temp file then rename (atomic on POSIX). */
function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${Deno.pid}`;
  Deno.writeTextFileSync(tmp, data);
  try {
    Deno.renameSync(tmp, filePath);
  } catch (err) {
    try { Deno.removeSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

function quote(v: string): string {
  if (v === "") return '""';
  return /[:#\[\]"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

function scalar(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "") : "";
}

/** Parse a numeric frontmatter value; null when absent or non-finite. */
function num(fm: string, key: string): number | null {
  const s = scalar(fm, key);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
