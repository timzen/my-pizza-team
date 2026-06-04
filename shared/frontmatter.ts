/**
 * shared/frontmatter.ts — Frontmatter parsing/serialization for memory notes.
 *
 * Notes can have YAML-like frontmatter with categories metadata.
 */

/** Parse frontmatter from a memory note's raw content */
export function parseFrontmatter(raw: string): { categories: string[]; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { categories: [], body: raw };

  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";

  const catMatch = frontmatter.match(/categories:\s*\[([^\]]*)\]/);
  if (!catMatch) return { categories: [], body };

  const categories = (catMatch[1] ?? "")
    .split(",")
    .map((c) => c.trim().replace(/['"]/g, ""))
    .filter(Boolean);

  return { categories, body };
}

/** Serialize categories and body into a frontmatter-prefixed string */
export function serializeFrontmatter(categories: string[], body: string): string {
  if (categories.length === 0) return body;
  return `---\ncategories: [${categories.join(", ")}]\n---\n${body}`;
}
