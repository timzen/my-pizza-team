/**
 * tests/guide-ui.test.ts — The user guide's topic pages and how the in-app Help
 * assembles them (ui/src/lib/guide.ts): reading order, GitHub-style heading
 * anchors, link retargeting — and, over the real docs/guide/*.md and
 * docs/PLUGINS.md, that every relative link points at a file and heading that
 * exist, that GUIDE.md and Getting Started list every page, and that each
 * page's headings nest without skipping a level.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import { GUIDE_REPO_URL, guideLinkTarget, guideMarkdown, guidePages, headingSlug, pageAnchors, rewriteGuideLinks } from "../ui/src/lib/guide.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE_DIR = path.join(ROOT, "docs/guide");
const PAGES = fs.readdirSync(GUIDE_DIR).filter((f) => f.endsWith(".md"));

test("guidePages: numbered pages in number order, then the unnumbered ones by name", () => {
  const order = guidePages({
    "../content/guide/glossary.md": "g",
    "../content/guide/10-tips.md": "t",
    "../content/guide/02-b.md": "b",
    "../content/guide/00-start.md": "s",
    "../content/guide/09-phone.md": "p",
  }).map((p) => p.file);
  assertEquals(order, ["00-start.md", "02-b.md", "09-phone.md", "10-tips.md", "glossary.md"]);
});

test("headingSlug: GitHub's anchors", () => {
  assertEquals(headingSlug("Pending: write first, run when it's right"), "pending-write-first-run-when-its-right");
  assertEquals(headingSlug("5. Add it, then restart"), "5-add-it-then-restart");
  assertEquals(headingSlug("Describing your settings (configSchema) and preview"), "describing-your-settings-configschema-and-preview");
  assertEquals(headingSlug("Experimental: Kiro and Claude Code teammates"), "experimental-kiro-and-claude-code-teammates");
  assertEquals(headingSlug("MORIBUND"), "moribund");
});

test("guideLinkTarget: guide pages become in-page anchors, other repo files GitHub URLs", () => {
  const pages = new Map([["01-tasks-and-runs.md", "tasks-and-runs"], ["glossary.md", "glossary"]]);
  assertEquals(guideLinkTarget("glossary.md#moribund", pages), "#moribund");
  assertEquals(guideLinkTarget("01-tasks-and-runs.md", pages), "#tasks-and-runs");
  assertEquals(guideLinkTarget("../PLUGINS.md#triage-mode", pages), `${GUIDE_REPO_URL}/docs/PLUGINS.md#triage-mode`);
  assertEquals(guideLinkTarget("../../README.md", pages), `${GUIDE_REPO_URL}/README.md`);
  for (const unchanged of ["https://pi.mariozechner.at/", "#the-queue", "/work/board", "mailto:a@b.c"]) {
    assertEquals(guideLinkTarget(unchanged, pages), unchanged);
  }
});

test("rewriteGuideLinks leaves code blocks alone", () => {
  const md = "See [the Queue](01-tasks-and-runs.md#the-queue).\n\n```\n[x](glossary.md)\n```\n\n[g](glossary.md)";
  assertEquals(
    rewriteGuideLinks(md, new Map([["01-tasks-and-runs.md", "tasks-and-runs"], ["glossary.md", "glossary"]])),
    "See [the Queue](#the-queue).\n\n```\n[x](glossary.md)\n```\n\n[g](#glossary)",
  );
});

test("pageAnchors: each page's title anchor, by file", () => {
  const anchors = pageAnchors(guidePages({ "g/04-assistant.md": "intro\n# The assistant\n## Style", "g/x.md": "no title" }));
  assertEquals([...anchors], [["04-assistant.md", "the-assistant"], ["x.md", "x"]]);
});

test("guideMarkdown joins the pages in order with a rule between them", () => {
  assertEquals(guideMarkdown({ "b/glossary.md": "# G\n", "b/00-a.md": "# A [g](glossary.md#x)\n" }), "# A [g](#x)\n\n---\n\n# G");
});

/** A markdown file's text outside fenced code blocks. */
function prose(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/^```[\s\S]*?^```/gm, "");
}

/** The anchors of a markdown file's headings. */
function anchors(file: string): Set<string> {
  return new Set([...prose(file).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => headingSlug(m[1] ?? "")));
}

test("every relative link in the guide and PLUGINS.md reaches a real file and heading", () => {
  const files = [...PAGES.map((f) => path.join(GUIDE_DIR, f)), path.join(ROOT, "docs/PLUGINS.md"), path.join(ROOT, "GUIDE.md")];
  const broken: string[] = [];
  for (const file of files) {
    for (const [, href = ""] of prose(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) continue;
      const [rel, anchor] = href.split("#");
      const target = rel ? path.resolve(path.dirname(file), rel) : file;
      if (!fs.existsSync(target)) broken.push(`${path.relative(ROOT, file)}: ${href} (no such file)`);
      else if (anchor && target.endsWith(".md") && !anchors(target).has(anchor)) broken.push(`${path.relative(ROOT, file)}: ${href} (no such heading)`);
    }
  }
  assertEquals(broken, []);
});

test("GUIDE.md and Getting Started list every guide page", () => {
  const index = fs.readFileSync(path.join(ROOT, "GUIDE.md"), "utf8");
  const start = fs.readFileSync(path.join(GUIDE_DIR, "00-getting-started.md"), "utf8");
  assertEquals(PAGES.filter((f) => !index.includes(`(docs/guide/${f})`)), []);
  assertEquals(PAGES.filter((f) => f !== "00-getting-started.md" && !start.includes(`(${f})`)), []);
});

test("each guide page opens with one `#` title and never skips a heading level", () => {
  // The Help page renders them in sequence, so a skip is an axe heading-order failure on /help.
  const bad: string[] = [];
  for (const f of PAGES) {
    const levels = [...prose(path.join(GUIDE_DIR, f)).matchAll(/^(#{1,6})\s/gm)].map((m) => (m[1] ?? "").length);
    if (levels[0] !== 1 || levels.filter((l) => l === 1).length !== 1) bad.push(`${f}: needs exactly one # title, first`);
    levels.forEach((l, i) => { if (i > 0 && l > (levels[i - 1] ?? 0) + 1) bad.push(`${f}: heading ${i + 1} jumps to level ${l}`); });
  }
  assertEquals(bad, []);
});
