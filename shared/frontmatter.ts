/**
 * shared/frontmatter.ts — Frontmatter parsing/serialization for persona files.
 *
 * Personas (`personas/<id>.md`, and the former context entries the migration
 * reads) are markdown files with a small YAML-like frontmatter block carrying
 * `title`, `description`, and `tags`, plus the persona-only `kinds` (a picker
 * hint) and `duplicatedFrom` (informational), and the optional harness settings
 * `tools`, `skills`, `model` and `requires` (docs/DESIGN.md "Persona
 * settings"). The body below is the text that gets injected into a prompt. See
 * docs/DESIGN.md "Personas".
 *
 * The settings are nested, so they are read with a small YAML subset rather
 * than the one-line scalars/lists the other keys use: flow collections
 * (`{ allow: ["read"], deny: [bash] }`, `["a", "b"]`), quoted or plain scalars,
 * and one level of block style (`tools:` then indented `allow: [...]` or
 * `- item` lines). Here they are only *read* — as raw values, shapes unchecked;
 * daemon/personas/settings.ts checks and types them. Unknown keys are ignored
 * (and so not written back), as they always were.
 */

/** A raw value of the settings' YAML subset: a scalar, a list, or a map. */
export type FrontmatterValue = string | FrontmatterValue[] | { [key: string]: FrontmatterValue };

/** The settings keys, read raw (`readSettingsBlock`). */
export const PERSONA_SETTINGS_KEYS = ["tools", "skills", "model", "requires"] as const;

/** Metadata stored in a persona's frontmatter block. */
export interface PersonaMeta {
  title: string;
  description: string;
  tags: string[];
  /** Picker hints (`assistant` | `teammate` | `triage`; a deprecated `worker` is normalized by the daemon); empty when absent. */
  kinds?: string[];
  /** The id this persona was duplicated from, when it was. */
  duplicatedFrom?: string;
  /**
   * The harness settings as written (`PERSONA_SETTINGS_KEYS`), present only
   * when the file has them. Raw on parse; on serialize, the typed values.
   */
  settings?: Partial<Record<(typeof PERSONA_SETTINGS_KEYS)[number], unknown>>;
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
  const settings: NonNullable<PersonaMeta["settings"]> = {};
  for (const key of PERSONA_SETTINGS_KEYS) {
    const value = readSettingsBlock(frontmatter, key);
    if (value !== undefined) settings[key] = value;
  }
  if (Object.keys(settings).length > 0) meta.settings = settings;
  return meta;
}

/**
 * Read one top-level key in the settings' YAML subset: its inline value (a flow
 * collection or scalar), or — when the line has none — the indented block
 * below it. Undefined when the key is absent.
 */
function readSettingsBlock(frontmatter: string, key: string): FrontmatterValue | undefined {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start < 0) return undefined;
  const inline = stripComment(lines[start]!.slice(key.length + 1)).trim();
  if (inline) return parseFlow(inline);
  // The block: following lines that are indented, a `- ` item, or blank.
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s/.test(line) || /^-(\s|$)/.test(line)) block.push(line);
    else break;
  }
  return parseBlock(block);
}

/** A block (indented lines): a `- item` list or a `key: value` map; "" when empty. */
function parseBlock(lines: string[]): FrontmatterValue {
  const rows = lines.filter((l) => stripComment(l).trim() !== "");
  if (rows.length === 0) return "";
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const indent = indentOf(rows[0]!);
  if (rows[0]!.trimStart().startsWith("-")) {
    return rows
      .filter((l) => indentOf(l) === indent && l.trimStart().startsWith("-"))
      .map((l) => parseFlow(stripComment(l.trimStart().slice(1)).trim()));
  }
  const map: { [key: string]: FrontmatterValue } = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (indentOf(row) !== indent) continue;
    const m = /^([^:]+):(.*)$/.exec(stripComment(row).trim());
    if (!m) continue;
    const rest = (m[2] ?? "").trim();
    if (rest) { map[m[1]!.trim()] = parseFlow(rest); continue; }
    // A nested block: the deeper lines that follow.
    const nested: string[] = [];
    for (const next of rows.slice(i + 1)) {
      if (indentOf(next) <= indent && !(indentOf(next) === indent && next.trimStart().startsWith("-"))) break;
      nested.push(next);
    }
    map[m[1]!.trim()] = parseBlock(nested);
  }
  return map;
}

/** Drop a trailing ` # comment` outside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (ch === "\\" && quote === '"') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i);
  }
  return text;
}

/**
 * Parse a flow value: `[…]`, `{…}`, a quoted string, or a plain scalar. Text
 * that isn't well-formed (an unclosed bracket, trailing junk) comes back as the
 * plain string, so the settings check reports a wrong shape instead of guessing.
 */
function parseFlow(text: string): FrontmatterValue {
  const p = { s: text, i: 0 };
  try {
    const value = flowValue(p, false);
    skipSpace(p);
    return p.i === p.s.length ? value : text;
  } catch {
    return text;
  }
}

type FlowCursor = { s: string; i: number };

function skipSpace(p: FlowCursor): void {
  while (p.i < p.s.length && /\s/.test(p.s[p.i]!)) p.i++;
}

function flowValue(p: FlowCursor, nested: boolean): FrontmatterValue {
  skipSpace(p);
  const ch = p.s[p.i];
  if (ch === "[") {
    p.i++;
    const list: FrontmatterValue[] = [];
    skipSpace(p);
    if (p.s[p.i] === "]") { p.i++; return list; }
    for (;;) {
      list.push(flowValue(p, true));
      skipSpace(p);
      const sep = p.s[p.i++];
      if (sep === "]") return list;
      if (sep !== ",") throw new Error("expected , or ]");
    }
  }
  if (ch === "{") {
    p.i++;
    const map: { [key: string]: FrontmatterValue } = {};
    skipSpace(p);
    if (p.s[p.i] === "}") { p.i++; return map; }
    for (;;) {
      const key = flowValue(p, true);
      skipSpace(p);
      if (typeof key !== "string" || p.s[p.i++] !== ":") throw new Error("expected key:");
      map[key] = flowValue(p, true);
      skipSpace(p);
      const sep = p.s[p.i++];
      if (sep === "}") return map;
      if (sep !== ",") throw new Error("expected , or }");
    }
  }
  if (ch === '"') {
    let out = "";
    for (p.i++; p.i < p.s.length; p.i++) {
      const c = p.s[p.i]!;
      if (c === "\\") { out += p.s[++p.i] ?? ""; continue; }
      if (c === '"') { p.i++; return out; }
      out += c;
    }
    throw new Error("unterminated string");
  }
  if (ch === "'") {
    let out = "";
    for (p.i++; p.i < p.s.length; p.i++) {
      const c = p.s[p.i]!;
      if (c === "'") {
        if (p.s[p.i + 1] === "'") { out += "'"; p.i++; continue; }
        p.i++;
        return out;
      }
      out += c;
    }
    throw new Error("unterminated string");
  }
  // A plain scalar: up to a flow delimiter (inside a collection), or a `key:`
  // colon (`: ` or a colon before a delimiter), or the end.
  const start = p.i;
  while (p.i < p.s.length) {
    const c = p.s[p.i]!;
    if (nested && (c === "," || c === "]" || c === "}")) break;
    if (c === ":" && (p.i + 1 === p.s.length || /[\s,\]}]/.test(p.s[p.i + 1]!))) {
      if (nested) break;
    }
    if (!nested && (c === "[" || c === "{")) throw new Error("unexpected bracket");
    p.i++;
  }
  return p.s.slice(start, p.i).trim();
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
  for (const key of PERSONA_SETTINGS_KEYS) {
    const value = meta.settings?.[key];
    if (value !== undefined) lines.push(`${key}: ${flowText(value)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n${body}`;
}

/**
 * A settings value in flow style: maps `{ k: v }`, lists `["a", "b"]` (items
 * always double-quoted, so a leading `*` can't read as a YAML alias), scalars
 * quoted when needed. Values that are neither string, list nor map are skipped.
 */
function flowText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => typeof v === "string" ? JSON.stringify(v) : flowText(v)).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${flowText(v)}`).join(", ")} }`;
  }
  const text = String(value);
  return text === "" || /[:#\[\]{},"'*&!|>%@`\s]/.test(text) ? JSON.stringify(text) : text;
}

/** Quote a scalar value when it contains characters that would break parsing. */
function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  return /[:#\[\]"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
