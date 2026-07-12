/**
 * daemon/store/notes.ts — Knowledge-base notes persistence.
 *
 * Notes are markdown files under `<teamDir>/notes/` with YAML-ish frontmatter
 * for categories. This module owns their filesystem representation; the Store
 * delegates its note methods here. Pure functions over a team directory — no
 * database, no shared state.
 */

import * as path from "@std/path";
import { existsSync } from "@std/fs";
import { parseFrontmatter, serializeFrontmatter } from "../../shared/frontmatter.ts";

export interface Note {
  id: string;
  title: string;
  content: string;
  categories: string[];
  createdAt: string;
  updatedAt: string;
}

/** List all notes in `<teamDir>/notes/`, sorted by filename. */
export function listNotes(teamDir: string): Note[] {
  const notesDir = path.join(teamDir, "notes");
  if (!existsSync(notesDir)) return [];
  const results: Note[] = [];

  const entries = [...Deno.readDirSync(notesDir)]
    .filter((e) => e.isFile && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const filePath = path.join(notesDir, entry.name);
    const stat = Deno.statSync(filePath);
    const rawContent = Deno.readTextFileSync(filePath);
    const id = entry.name.replace(/\.md$/, "");

    const { categories, body } = parseFrontmatter(rawContent);
    const firstLine = body.trim().split("\n")[0] ?? "";
    const title = firstLine.startsWith("# ") ? firstLine.slice(2).trim() : id;

    results.push({
      id,
      title,
      content: body,
      categories,
      createdAt: (stat.birthtime ?? stat.mtime ?? new Date()).toISOString(),
      updatedAt: (stat.mtime ?? new Date()).toISOString(),
    });
  }
  return results;
}

/** Create or overwrite a note (id derived from the title). */
export function saveNote(teamDir: string, title: string, content: string, categories?: string[]): Note {
  const notesDir = path.join(teamDir, "notes");
  Deno.mkdirSync(notesDir, { recursive: true });
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || `note-${Date.now()}`;
  const filePath = path.join(notesDir, `${id}.md`);
  const body = content.startsWith("# ") ? content : `# ${title}\n\n${content}`;
  const cats = categories || [];

  Deno.writeTextFileSync(filePath, serializeFrontmatter(cats, body));
  const stat = Deno.statSync(filePath);
  return {
    id,
    title,
    content: body,
    categories: cats,
    createdAt: (stat.birthtime ?? stat.mtime ?? new Date()).toISOString(),
    updatedAt: (stat.mtime ?? new Date()).toISOString(),
  };
}

/** Replace a note's categories (keeps its body). Returns false if missing. */
export function updateNoteCategories(teamDir: string, id: string, categories: string[]): boolean {
  const filePath = path.join(teamDir, "notes", `${id}.md`);
  if (!existsSync(filePath)) return false;
  const { body } = parseFrontmatter(Deno.readTextFileSync(filePath));
  Deno.writeTextFileSync(filePath, serializeFrontmatter(categories, body));
  return true;
}

/** Delete a note file. Returns false if missing. */
export function deleteNote(teamDir: string, id: string): boolean {
  const filePath = path.join(teamDir, "notes", `${id}.md`);
  if (!existsSync(filePath)) return false;
  Deno.removeSync(filePath);
  return true;
}
