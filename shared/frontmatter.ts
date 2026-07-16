/**
 * shared/frontmatter.ts — Frontmatter parsing/serialization for context entries.
 *
 * Context entries are markdown files with a small YAML-like frontmatter block
 * carrying `title`, `description`, and `tags`. The body below is the actual
 * prompt/context text that gets injected into teammates or the assistant.
 */

/** Metadata stored in a context entry's frontmatter block. */
export interface ContextMeta {
  title: string;
  description: string;
  tags: string[];
}

/** Parse frontmatter metadata and body from a context entry's raw content. */
export function parseFrontmatter(raw: string): { meta: ContextMeta; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: { title: "", description: "", tags: [] }, body: raw };

  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";

  return { meta: parseMetaBlock(frontmatter), body };
}

/** Parse the individual keys out of a frontmatter block. */
function parseMetaBlock(frontmatter: string): ContextMeta {
  const title = parseScalar(frontmatter, "title");
  const description = parseScalar(frontmatter, "description");
  const tags = parseList(frontmatter, "tags");
  return { title, description, tags };
}

/** Read a single-line scalar value (`key: value`), stripping surrounding quotes. */
function parseScalar(frontmatter: string, key: string): string {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return "";
  return (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
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
export function serializeFrontmatter(meta: ContextMeta, body: string): string {
  const lines = ["---"];
  lines.push(`title: ${quoteIfNeeded(meta.title)}`);
  lines.push(`description: ${quoteIfNeeded(meta.description)}`);
  lines.push(`tags: [${meta.tags.join(", ")}]`);
  lines.push("---");
  return `${lines.join("\n")}\n${body}`;
}

/** Quote a scalar value when it contains characters that would break parsing. */
function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  return /[:#\[\]"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
