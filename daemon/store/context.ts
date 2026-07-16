/**
 * daemon/store/context.ts — Context-entry persistence.
 *
 * Context entries are reusable prompt/context snippets that can be injected
 * into teammates or the assistant. Each is a markdown file under
 * `<teamDir>/context/` with frontmatter metadata (title, description, tags)
 * and a markdown body. This module owns their filesystem representation; the
 * Store delegates its context methods here. Pure functions over a team
 * directory — no database, no shared state.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { parseFrontmatter, serializeFrontmatter, type ContextMeta } from "../../shared/frontmatter.ts";

export interface ContextEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Derive a filesystem-safe id from a title. */
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || `context-${Date.now()}`;
}

/** Build a ContextEntry from a file on disk. Returns null if unreadable. */
function readEntry(dir: string, fileName: string): ContextEntry | null {
  if (!fileName.endsWith(".md")) return null;
  const filePath = path.join(dir, fileName);
  const stat = Deno.statSync(filePath);
  const raw = Deno.readTextFileSync(filePath);
  const id = fileName.replace(/\.md$/, "");
  const { meta, body } = parseFrontmatter(raw);
  // Fall back to the first markdown heading, then the id, for legacy files.
  const firstLine = body.trim().split("\n")[0] ?? "";
  const title = meta.title || (firstLine.startsWith("# ") ? firstLine.slice(2).trim() : id);
  return {
    id,
    title,
    description: meta.description,
    tags: meta.tags,
    content: body,
    createdAt: (stat.birthtime ?? stat.mtime ?? new Date()).toISOString(),
    updatedAt: (stat.mtime ?? new Date()).toISOString(),
  };
}

/** List all context entries in `<teamDir>/context/`, sorted by filename. */
export function listContextEntries(teamDir: string): ContextEntry[] {
  const dir = path.join(teamDir, "context");
  if (!existsSync(dir)) return [];
  return [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => readEntry(dir, e.name))
    .filter((e): e is ContextEntry => e !== null);
}

/** Get a single context entry by id, or null if it doesn't exist. */
export function getContextEntry(teamDir: string, id: string): ContextEntry | null {
  const filePath = path.join(teamDir, "context", `${id}.md`);
  if (!existsSync(filePath)) return null;
  return readEntry(path.join(teamDir, "context"), `${id}.md`);
}

/** Create or overwrite a context entry (id derived from the title). */
export function saveContextEntry(
  teamDir: string,
  input: { title: string; description?: string; tags?: string[]; content: string },
): ContextEntry {
  const dir = path.join(teamDir, "context");
  Deno.mkdirSync(dir, { recursive: true });
  const id = slugify(input.title);
  const filePath = path.join(dir, `${id}.md`);
  const meta: ContextMeta = {
    title: input.title,
    description: input.description ?? "",
    tags: input.tags ?? [],
  };
  Deno.writeTextFileSync(filePath, serializeFrontmatter(meta, input.content));
  return getContextEntry(teamDir, id)!;
}

/** Update an existing context entry in place (id is preserved). Returns null if missing. */
export function updateContextEntry(
  teamDir: string,
  id: string,
  updates: { title?: string; description?: string; tags?: string[]; content?: string },
): ContextEntry | null {
  const existing = getContextEntry(teamDir, id);
  if (!existing) return null;
  const filePath = path.join(teamDir, "context", `${id}.md`);
  const meta: ContextMeta = {
    title: updates.title ?? existing.title,
    description: updates.description ?? existing.description,
    tags: updates.tags ?? existing.tags,
  };
  const body = updates.content ?? existing.content;
  Deno.writeTextFileSync(filePath, serializeFrontmatter(meta, body));
  return getContextEntry(teamDir, id);
}

/** Delete a context entry file. Returns false if missing. */
export function deleteContextEntry(teamDir: string, id: string): boolean {
  const filePath = path.join(teamDir, "context", `${id}.md`);
  if (!existsSync(filePath)) return false;
  Deno.removeSync(filePath);
  return true;
}
