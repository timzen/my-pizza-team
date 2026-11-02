/**
 * guide.ts — Assembles the in-app Help from the user guide's topic pages
 * (docs/guide/*.md, copied into ui/src/content/guide/ by the UI's `prebuild`).
 *
 * The pages are written for GitHub first: they link to each other as
 * `01-tasks-and-runs.md#the-queue` and to the developer docs as
 * `../PLUGINS.md`. In the app those relative paths would resolve against
 * `/help` and land nowhere, so `rewriteGuideLinks` turns a link to another guide
 * page into an in-page anchor (all pages render on one Help page; a link to a
 * whole page goes to its title's anchor), and a link to any other repo file
 * into its GitHub URL. Pure, so tests/guide-ui.test.ts
 * can check it — and check that every link in the real pages resolves.
 */

/** Where repo files outside the guide (docs/PLUGINS.md, README.md) are read in the app. */
export const GUIDE_REPO_URL = "https://github.com/timzen/my-pizza-team/blob/main";

/** The guide pages' folder, relative to the repo root (links resolve against it). */
export const GUIDE_DIR = "docs/guide";

/** One topic page: its file name (`01-tasks-and-runs.md`) and its markdown. */
export interface GuidePage {
  file: string;
  markdown: string;
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

/** Resolve a relative path against a folder, POSIX-style (`docs/guide` + `../PLUGINS.md` → `docs/PLUGINS.md`). */
function resolvePath(dir: string, rel: string): string {
  const parts = dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Each page's anchor in the app — its `#` title's — keyed by file name, for
 * links to a whole page (`04-assistant.md` → `#the-assistant`).
 */
export function pageAnchors(pages: readonly GuidePage[]): Map<string, string> {
  return new Map(pages.map((p) => [p.file, headingSlug(/^#\s+(.+)$/m.exec(p.markdown)?.[1] ?? p.file.replace(/\.md$/, ""))]));
}

/**
 * Where one link in a guide page should point in the app. External URLs and
 * bare anchors are unchanged; a guide page becomes `#anchor` (its title's
 * anchor, from `pages`, for a link to the whole page); any other repo file
 * becomes its GitHub URL.
 */
export function guideLinkTarget(href: string, pages: ReadonlyMap<string, string>): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const hash = href.indexOf("#");
  const file = hash < 0 ? href : href.slice(0, hash);
  const anchor = hash < 0 ? "" : href.slice(hash);
  const page = pages.get(file);
  if (page !== undefined) return anchor || `#${page}`;
  return `${GUIDE_REPO_URL}/${resolvePath(GUIDE_DIR, file)}${anchor}`;
}

/**
 * A page's markdown with every inline link `[text](href)` retargeted by
 * `guideLinkTarget`. Fenced code blocks are left alone.
 */
export function rewriteGuideLinks(markdown: string, pages: ReadonlyMap<string, string>): string {
  // Odd-numbered pieces of a split on fences are code blocks.
  return markdown
    .split(/(^```[\s\S]*?^```)/m)
    .map((piece, i) => (i % 2 ? piece : piece.replace(/\]\(([^)\s]+)\)/g, (_m, href: string) => `](${guideLinkTarget(href, pages)})`)))
    .join("");
}

/** The whole guide as one markdown document: each page in order, links retargeted, a rule between pages. */
export function guideMarkdown(modules: Record<string, string>): string {
  const pages = guidePages(modules);
  const anchors = pageAnchors(pages);
  return pages.map((p) => rewriteGuideLinks(p.markdown.trim(), anchors)).join("\n\n---\n\n");
}
