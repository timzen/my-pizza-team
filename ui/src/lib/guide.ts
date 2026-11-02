/**
 * guide.ts — Assembles the in-app Help from the user guide's topic pages
 * (docs/guide/*.md, copied into ui/src/content/guide/ by the UI's `prebuild`):
 * each page's topic, title and headings (the sidebar's table of contents and
 * the heading anchors), its links retargeted for the app, the Previous / Next
 * order, and a small full-text search index (docs/ARCHITECTURE.md "ui/src").
 *
 * The pages are written for GitHub first: they link to each other as
 * `01-tasks-and-runs.md#the-queue` and to the developer docs as
 * `../PLUGINS.md`. In the app those relative paths would resolve against
 * `/help` and land nowhere, so `rewriteGuideLinks` turns a link to another guide
 * page into its Help route (`/help/tasks-and-runs#the-queue`, lib/help.ts
 * `helpPath`), and a link to any other repo file into its GitHub URL.
 *
 * Heading anchors are GitHub's (`headingSlug`, with `-1`, `-2` for a repeated
 * heading — `HeadingSlugger`), so a link copied from GitHub works in the app
 * and the other way round; components/ui/markdown-view's `headingIds` stamps
 * the same ids on the rendered headings.
 *
 * Search needs no library: the index is one entry per section (a heading and
 * the text under it), built on the first search, and a query matches the
 * sections that contain every word. Pure, so tests/guide-ui.test.ts can check
 * all of it — and check that every link in the real pages resolves.
 */

import { HELP_ROOT, helpPath, topicOfFile } from "./help.ts";

/** Where repo files outside the guide (docs/PLUGINS.md, README.md) are read in the app. */
export const GUIDE_REPO_URL = "https://github.com/timzen/my-pizza-team/blob/main";

/** The guide pages' folder, relative to the repo root (links resolve against it). */
export const GUIDE_DIR = "docs/guide";

/** One topic page: its file name (`01-tasks-and-runs.md`) and its markdown. */
export interface GuidePage {
  file: string;
  markdown: string;
}

/** One heading of a page: its level (1 for the `#` title), its text, and its anchor. */
export interface GuideHeading {
  level: number;
  text: string;
  id: string;
}

/** One topic as the Help shows it. */
export interface GuideTopic {
  /** Its URL id (lib/help.ts `topicOfFile`): `tasks-and-runs`. */
  topic: string;
  file: string;
  /** The page's `#` title. */
  title: string;
  /** The markdown with its links retargeted for the app (`rewriteGuideLinks`). */
  markdown: string;
  headings: GuideHeading[];
}

/**
 * The guide's pages in reading order, from a `{ path: markdown }` map (what
 * `import.meta.glob` returns). The file name's number prefix is the order
 * (`00-getting-started.md` first); unnumbered pages (the glossary) follow, by
 * name.
 */
export function guidePages(modules: Record<string, string>): GuidePage[] {
  const pages = Object.entries(modules).map(([p, markdown]) => ({ file: p.slice(p.lastIndexOf("/") + 1), markdown }));
  const numbered = (f: string) => /^\d/.test(f);
  return pages.sort((a, b) =>
    numbered(a.file) !== numbered(b.file) ? (numbered(a.file) ? -1 : 1) : a.file.localeCompare(b.file, "en", { numeric: true }));
}

/**
 * A heading's anchor, the way GitHub makes it: lower-cased, punctuation
 * dropped (letters, digits, `-`, `_` and spaces kept), spaces to `-`.
 * "Pending: write first, run when it's right" → `pending-write-first-run-when-its-right`.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Anchors for one document's headings, in order, the way GitHub dedupes them:
 * the second "Setup" is `setup-1`, the third `setup-2`. Make one per document.
 */
export class HeadingSlugger {
  private readonly seen = new Map<string, number>();

  /** The next heading's anchor. */
  slug(text: string): string {
    // github-slugger's walk: bump the base's count until the suffixed id is free.
    const base = headingSlug(text);
    let id = base;
    while (this.seen.has(id)) {
      const n = (this.seen.get(base) ?? 0) + 1;
      this.seen.set(base, n);
      id = `${base}-${n}`;
    }
    this.seen.set(id, 0);
    return id;
  }
}

/**
 * A markdown heading's (or any inline markdown's) text as it renders: links
 * become their text, and code, emphasis and escape marks go. What the anchor
 * and the table of contents are made from.
 */
export function inlineText(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** Split markdown into prose and fenced code: odd-numbered pieces are code blocks. */
function splitFences(markdown: string): string[] {
  return markdown.split(/(^```[\s\S]*?^```)/m);
}

/** Every heading of a page (`#` … `######`, outside code blocks), with GitHub's anchors. */
export function pageHeadings(markdown: string): GuideHeading[] {
  const slugger = new HeadingSlugger();
  const prose = splitFences(markdown).filter((_, i) => i % 2 === 0).join("\n");
  return [...prose.matchAll(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm)].map((m) => {
    const text = inlineText(m[2] ?? "");
    return { level: (m[1] ?? "").length, text, id: slugger.slug(text) };
  });
}

/** Resolve a relative path against a folder, POSIX-style (`docs/guide` + `../PLUGINS.md` → `docs/PLUGINS.md`). */
function resolvePath(dir: string, rel: string): string {
  const parts = dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/** Each page's topic, keyed by file name (`04-assistant.md` → `assistant`), for `guideLinkTarget`. */
export function pageTopics(pages: readonly GuidePage[]): Map<string, string> {
  return new Map(pages.map((p) => [p.file, topicOfFile(p.file)]));
}

/**
 * Where one link in a guide page should point in the app. External URLs, app
 * paths and bare anchors are unchanged; a guide page becomes its Help route
 * (`glossary.md#moribund` → `/help/glossary#moribund`, under `root`); any
 * other repo file becomes its GitHub URL.
 */
export function guideLinkTarget(href: string, topics: ReadonlyMap<string, string>, root: string = HELP_ROOT): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const hash = href.indexOf("#");
  const file = hash < 0 ? href : href.slice(0, hash);
  const anchor = hash < 0 ? "" : href.slice(hash + 1);
  const topic = topics.get(file);
  if (topic !== undefined) return helpPath(topic, anchor, root);
  return `${GUIDE_REPO_URL}/${resolvePath(GUIDE_DIR, file)}${anchor ? `#${anchor}` : ""}`;
}

/**
 * A page's markdown with every inline link `[text](href)` retargeted by
 * `guideLinkTarget`. Fenced code blocks are left alone.
 */
export function rewriteGuideLinks(markdown: string, topics: ReadonlyMap<string, string>, root: string = HELP_ROOT): string {
  return splitFences(markdown)
    .map((piece, i) => (i % 2 ? piece : piece.replace(/\]\(([^)\s]+)\)/g, (_m, href: string) => `](${guideLinkTarget(href, topics, root)})`)))
    .join("");
}

/**
 * The guide as the Help shows it, from the `import.meta.glob` map: each topic
 * in reading order with its title, headings, and links retargeted under
 * `root` (`/help`, or `/m/help` on the phone).
 */
export function guideTopics(modules: Record<string, string>, root: string = HELP_ROOT): GuideTopic[] {
  const pages = guidePages(modules);
  const topics = pageTopics(pages);
  return pages.map((p) => {
    const headings = pageHeadings(p.markdown);
    const topic = topicOfFile(p.file);
    return {
      topic,
      file: p.file,
      title: headings.find((h) => h.level === 1)?.text ?? topic,
      markdown: rewriteGuideLinks(p.markdown.trim(), topics, root),
      headings,
    };
  });
}

/** The topics before and after `topic` in reading order (null at either end, or for an unknown topic). */
export function adjacentTopics<T extends { topic: string }>(topics: readonly T[], topic: string): { prev: T | null; next: T | null } {
  const i = topics.findIndex((t) => t.topic === topic);
  if (i < 0) return { prev: null, next: null };
  return { prev: topics[i - 1] ?? null, next: topics[i + 1] ?? null };
}

/**
 * Which topic has a heading with this anchor — `preferred` first, then reading
 * order — or null. What keeps an old one-page link (`/help#moribund`, from when
 * the whole guide was one page) working: it's sent to the topic that has it.
 */
export function topicForAnchor(topics: readonly GuideTopic[], anchor: string, preferred?: string): string | null {
  const has = (t: GuideTopic) => t.headings.some((h) => h.id === anchor);
  const first = topics.find((t) => t.topic === preferred);
  if (first && has(first)) return first.topic;
  return topics.find(has)?.topic ?? null;
}

// ─── Search ──────────────────────────────────────────────────────────

/** One searchable section: a heading and the plain text under it, up to the next heading. */
export interface SearchEntry {
  topic: string;
  topicTitle: string;
  /** The heading's anchor (its `#` title's for the page's opening text). */
  id: string;
  heading: string;
  level: number;
  text: string;
  /** `heading` and `text`, lower-cased, for matching. */
  haystack: string;
}

/** One search hit, best first. */
export interface SearchResult {
  entry: SearchEntry;
  /** A short piece of the section's text around the first match (or its opening). */
  snippet: string;
}

/** Markdown as plain words: code fences' markers, links' URLs, emphasis, list and table marks gone. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^```.*$/gm, "")
    .split("\n")
    .filter((line) => !/^[\s|:-]*$/.test(line))
    .map((line) => inlineText(line.replace(/^\s*(?:>\s?)+/, "").replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "").replace(/\|/g, " ")))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The search index: every section of every topic, in reading order. */
export function buildSearchIndex(topics: readonly GuideTopic[]): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const t of topics) {
    // The same walk as pageHeadings, so the i-th heading here has the i-th id there.
    const lines = t.markdown.split("\n");
    let inFence = false;
    let h = -1;
    let body: string[] = [];
    const flush = () => {
      const heading = t.headings[h];
      if (!heading) return;
      const text = plainText(body.join("\n"));
      entries.push({ topic: t.topic, topicTitle: t.title, id: heading.id, heading: heading.text, level: heading.level, text,
        haystack: `${heading.text}\n${text}`.toLowerCase() });
    };
    for (const line of lines) {
      if (/^```/.test(line)) inFence = !inFence;
      if (!inFence && /^#{1,6}[ \t]+\S/.test(line)) {
        flush();
        h++;
        body = [];
      } else {
        body.push(line);
      }
    }
    flush();
  }
  return entries;
}

/** A query's words, lower-cased (empty for a blank query). */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The best `limit` sections for `query`: each must contain every word; heading hits rank first. */
export function searchGuide(index: readonly SearchEntry[], query: string, limit = 20): SearchResult[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const scored: Array<{ entry: SearchEntry; score: number; order: number }> = [];
  index.forEach((entry, order) => {
    if (!terms.every((t) => entry.haystack.includes(t))) return;
    const heading = entry.heading.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (heading.includes(t)) score += 10;
      // A few body hits count, but not so many that a long section always wins.
      score += Math.min(occurrences(entry.text.toLowerCase(), t), 5);
    }
    scored.push({ entry, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map(({ entry }) => ({ entry, snippet: snippet(entry.text, terms) }));
}

/** How often `term` appears in `text`. */
function occurrences(text: string, term: string): number {
  let n = 0;
  for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) n++;
  return n;
}

/** About `size` characters of `text` around the first term it contains, cut at word boundaries. */
export function snippet(text: string, terms: readonly string[], size = 140): string {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), Infinity);
  if (text.length <= size) return text;
  let start = at === Infinity ? 0 : Math.max(0, at - Math.floor(size / 3));
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  let end = Math.min(text.length, start + size);
  if (end < text.length) end = text.lastIndexOf(" ", end) > start ? text.lastIndexOf(" ", end) : end;
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** What the live region says for a finished search: "3 results for “queue”", "No results for “zzz”". */
export function searchAnnouncement(query: string, count: number): string {
  const q = query.trim();
  if (!q) return "";
  if (count === 0) return `No results for “${q}”`;
  return `${count} result${count === 1 ? "" : "s"} for “${q}”`;
}
