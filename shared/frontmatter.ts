/**
 * shared/frontmatter.ts — Frontmatter parsing/serialization for persona files.
 *
 * Personas (`personas/<id>.md`, and the former context entries the migration
 * reads) are markdown files with a small YAML-like frontmatter block carrying
 * `title`, `description`, and `tags`, plus the persona-only `kinds` (a picker
 * hint) and `duplicatedFrom` (informational). The body below is the text that
 * gets injected into a prompt. See docs/DESIGN.md "Personas".
 */

/** Metadata stored in a persona's frontmatter block. */
export interface PersonaMeta {
  title: string;
  description: string;
  tags: string[];
  /** Picker hints (`assistant` | `worker` | `triage`); empty when absent. */
  kinds?: string[];
  /** The id this persona was duplicated from, when it was. */
  duplicatedFrom?: string;
}

/** Parse frontmatter metadata and body from a persona file's raw content. */
export function parseFrontmatter(raw: string): { meta: PersonaMeta; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: { title: "", description: "", tags: [] }, body: raw };

  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";

  return { meta: parseMetaBlock(frontmatter), body };
}

/** Parse the individual keys out of a frontmatter block. */
function parseMetaBlock(frontmatter: string): PersonaMeta {
  const meta: PersonaMeta = {
    title: parseScalar(frontmatter, "title"),
    description: parseScalar(frontmatter, "description"),
    tags: parseList(frontmatter, "tags"),
  };
  const kinds = parseList(frontmatter, "kinds");
  if (kinds.length > 0) meta.kinds = kinds;
  const duplicatedFrom = parseScalar(frontmatter, "duplicatedFrom");
  if (duplicatedFrom) meta.duplicatedFrom = duplicatedFrom;
  return meta;
}

/** Read a single-line scalar value (`key: value`), stripping surrounding quotes. */
function parseScalar(frontmatter: string, key: string): string {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return "";
  return (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\\"/g, '"');
}

/** Read an inline list value (`key: [a, b, c]`). */
function parseList(frontmatter: string, key: string): string[] {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return [];
  return (m[1] ?? "")
    .split(",")
    .map((t) => t.trim().replace(/['"]/g, ""))
    .filter(Boolean);
}

/** Serialize metadata and body into a frontmatter-prefixed markdown string. */
export function serializeFrontmatter(meta: PersonaMeta, body: string): string {
  const lines = ["---"];
  lines.push(`title: ${quoteIfNeeded(meta.title)}`);
  lines.push(`description: ${quoteIfNeeded(meta.description)}`);
  lines.push(`tags: [${meta.tags.join(", ")}]`);
  if (meta.kinds && meta.kinds.length > 0) lines.push(`kinds: [${meta.kinds.join(", ")}]`);
  if (meta.duplicatedFrom) lines.push(`duplicatedFrom: ${quoteIfNeeded(meta.duplicatedFrom)}`);
  lines.push("---");
  return `${lines.join("\n")}\n${body}`;
}

/** Quote a scalar value when it contains characters that would break parsing. */
function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  return /[:#\[\]"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
