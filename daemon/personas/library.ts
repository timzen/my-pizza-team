/**
 * daemon/personas/library.ts — The team persona library on disk (`personas/<id>.md`).
 *
 * A team persona is a markdown file with frontmatter (title, description, tags,
 * optional `kinds` and `duplicatedFrom`; shared/frontmatter.ts) whose body is the
 * text injected into a prompt. Files are the source of truth — there is no
 * SQLite index — like templates: the library is a directory listing, small
 * enough to read on demand (docs/DESIGN.md "The model: `personas/<id>.md`").
 *
 * Pure functions over a team directory: no database, no shared state. Ids are
 * validated here (the team grammar, `TEAM_PERSONA_ID_PATTERN`), so a hostile id
 * can never escape `personas/`.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { parseFrontmatter, serializeFrontmatter, type PersonaMeta } from "../../shared/frontmatter.ts";
import {
  PERSONA_KINDS, PERSONAS_DIR, TEAM_PERSONA_ID_PATTERN, slugifyPersonaId,
  type Persona, type PersonaKind,
} from "../../shared/types.ts";

/** The authored fields of a team persona (what create/update accept). */
export interface TeamPersonaInput {
  title: string;
  description?: string;
  tags?: string[];
  kinds?: PersonaKind[];
  duplicatedFrom?: string;
  content: string;
}

/** Absolute path of the library directory. */
export function personasDir(teamDir: string): string {
  return path.join(teamDir, PERSONAS_DIR);
}

/** Is `id` a valid team persona id (a slug — no `:` or `/`)? */
export function isTeamPersonaId(id: string): boolean {
  return TEAM_PERSONA_ID_PATTERN.test(id);
}

/** Keep only recognized `kinds` hints, in order, deduped. */
export function normalizeKinds(kinds: unknown): PersonaKind[] {
  if (!Array.isArray(kinds)) return [];
  const out: PersonaKind[] = [];
  for (const k of kinds) {
    if ((PERSONA_KINDS as readonly unknown[]).includes(k) && !out.includes(k as PersonaKind)) out.push(k as PersonaKind);
  }
  return out;
}

/**
 * Parse a persona file's raw text into a library entry. The title falls back to
 * the first `# ` heading, then the id (like the former context entries).
 * Shared with package personas (daemon/personas/packages.ts), which pass their
 * own origin.
 */
export function parsePersonaFile(id: string, raw: string, origin: Persona["origin"]): Persona {
  const { meta, body } = parseFrontmatter(raw);
  const firstLine = body.trim().split("\n")[0] ?? "";
  const title = meta.title || (firstLine.startsWith("# ") ? firstLine.slice(2).trim() : id);
  const persona: Persona = {
    id,
    title,
    description: meta.description,
    tags: meta.tags,
    content: body,
    origin,
    readOnly: origin.kind !== "team",
  };
  const kinds = normalizeKinds(meta.kinds);
  if (kinds.length > 0) persona.kinds = kinds;
  if (meta.duplicatedFrom) persona.duplicatedFrom = meta.duplicatedFrom;
  return persona;
}

/** Serialize a persona's authored fields to its file text. */
export function serializePersona(input: TeamPersonaInput): string {
  const meta: PersonaMeta = {
    title: input.title,
    description: input.description ?? "",
    tags: input.tags ?? [],
  };
  if (input.kinds && input.kinds.length > 0) meta.kinds = input.kinds;
  if (input.duplicatedFrom) meta.duplicatedFrom = input.duplicatedFrom;
  return serializeFrontmatter(meta, input.content);
}

/** Read one team persona file, with file times. Null when missing or the id is invalid. */
export function readTeamPersona(teamDir: string, id: string): Persona | null {
  if (!isTeamPersonaId(id)) return null;
  const file = path.join(personasDir(teamDir), `${id}.md`);
  if (!existsSync(file)) return null;
  const stat = fs.statSync(file);
  const persona = parsePersonaFile(id, fs.readFileSync(file, "utf8"), { kind: "team" });
  // Filesystems without birth times report the epoch; fall back to mtime.
  persona.createdAt = (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString();
  persona.updatedAt = stat.mtime.toISOString();
  return persona;
}

/** Every team persona, sorted by id. Files whose name isn't a valid id are skipped. */
export function listTeamPersonas(teamDir: string): Persona[] {
  const dir = personasDir(teamDir);
  if (!existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name.slice(0, -3))
    .sort()
    .map((id) => readTeamPersona(teamDir, id))
    .filter((p): p is Persona => p !== null);
}

/** Write (create or overwrite) a team persona file. The caller has validated `id`. */
export function writeTeamPersona(teamDir: string, id: string, input: TeamPersonaInput): void {
  if (!isTeamPersonaId(id)) throw new Error(`Invalid persona id "${id}"`);
  fs.mkdirSync(personasDir(teamDir), { recursive: true });
  fs.writeFileSync(path.join(personasDir(teamDir), `${id}.md`), serializePersona(input));
}

/** Delete a team persona file. False when it doesn't exist. */
export function deleteTeamPersona(teamDir: string, id: string): boolean {
  if (!isTeamPersonaId(id)) return false;
  const file = path.join(personasDir(teamDir), `${id}.md`);
  if (!existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/**
 * A free team id derived from `base` (slugified; `persona` when that's empty),
 * taking `-2`, `-3`… on collision. `taken` decides collisions so the migration
 * can also treat ids it is about to write as taken.
 */
export function freeTeamPersonaId(base: string, taken: (id: string) => boolean): string {
  const root = slugifyPersonaId(base) || "persona";
  if (!taken(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${root.slice(0, 64 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken(id)) return id;
  }
}
