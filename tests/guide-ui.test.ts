/**
 * tests/guide-ui.test.ts — The user guide's topic pages and how the in-app Help
 * assembles them (ui/src/lib/guide.ts): reading order, GitHub-style heading
 * anchors, link retargeting to Help routes, Previous / Next, old one-page
 * anchors, the search index, and one section of a topic (the dock's Help
 * panel) — and, over the real docs/guide/*.md and
 * docs/PLUGINS.md, that every relative link points at a file and heading that
 * exist, that GUIDE.md and Getting Started list every page, and that each
 * page's headings nest without skipping a level.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import {
  GUIDE_REPO_URL, HeadingSlugger, adjacentTopics, buildSearchIndex, guideLinkTarget, guidePages, guideSection, guideTopics, headingSlug,
  inlineText, pageHeadings, plainText, rewriteGuideLinks, searchAnnouncement, searchGuide, snippet, topicForAnchor,
} from "../ui/src/lib/guide.ts";
import { helpPath } from "../ui/src/lib/help.ts";

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

test("HeadingSlugger: GitHub's -1, -2 for a repeated heading", () => {
  const s = new HeadingSlugger();
  assertEquals(["Setup", "Setup", "Setup-1", "Setup"].map((t) => s.slug(t)), ["setup", "setup-1", "setup-1-1", "setup-2"]);
});

test("inlineText: a heading's text as it renders", () => {
  assertEquals(inlineText("Describing your settings (`configSchema`) and **preview**"), "Describing your settings (configSchema) and preview");
  assertEquals(inlineText("See [the Queue](01-tasks-and-runs.md#the-queue) and *this*"), "See the Queue and this");
  assertEquals(inlineText("snake_case_name stays"), "snake_case_name stays");
});

test("pageHeadings: levels, text and anchors, skipping code blocks", () => {
  const md = "# Title\n\n## The `Queue`\n\n```\n# not a heading\n```\n\n### Retries ##\n\n## The Queue\n";
  assertEquals(pageHeadings(md), [
    { level: 1, text: "Title", id: "title" },
    { level: 2, text: "The Queue", id: "the-queue" },
    { level: 3, text: "Retries", id: "retries" },
    { level: 2, text: "The Queue", id: "the-queue-1" },
  ]);
});

test("guideLinkTarget: guide pages become Help routes, other repo files GitHub URLs", () => {
  const topics = new Map([["00-getting-started.md", "getting-started"], ["01-tasks-and-runs.md", "tasks-and-runs"], ["glossary.md", "glossary"]]);
  assertEquals(guideLinkTarget("glossary.md#moribund", topics), "/help/glossary#moribund");
  assertEquals(guideLinkTarget("01-tasks-and-runs.md", topics), "/help/tasks-and-runs");
  assertEquals(guideLinkTarget("00-getting-started.md#read-next", topics), "/help#read-next");
  assertEquals(guideLinkTarget("glossary.md", topics, "/m/help"), "/m/help/glossary");
  assertEquals(guideLinkTarget("../PLUGINS.md#triage-mode", topics), `${GUIDE_REPO_URL}/docs/PLUGINS.md#triage-mode`);
  assertEquals(guideLinkTarget("../../README.md", topics), `${GUIDE_REPO_URL}/README.md`);
  for (const unchanged of ["https://pi.mariozechner.at/", "#the-queue", "/work/board", "mailto:a@b.c"]) {
    assertEquals(guideLinkTarget(unchanged, topics), unchanged);
  }
});

test("rewriteGuideLinks leaves code blocks alone", () => {
  const md = "See [the Queue](01-tasks-and-runs.md#the-queue).\n\n```\n[x](glossary.md)\n```\n\n[g](glossary.md)";
  assertEquals(
    rewriteGuideLinks(md, new Map([["01-tasks-and-runs.md", "tasks-and-runs"], ["glossary.md", "glossary"]])),
    "See [the Queue](/help/tasks-and-runs#the-queue).\n\n```\n[x](glossary.md)\n```\n\n[g](/help/glossary)",
  );
});

/** A tiny guide for the topic, adjacency and search tests. */
const MINI = {
  "g/00-getting-started.md": "# Getting Started\n\nHello. Read [the glossary](glossary.md).\n\n## Read next\n\n- [Tasks](01-tasks.md)\n",
  "g/01-tasks.md": "# Tasks\n\nA task is work.\n\n## The Queue\n\nWaiting work sits in the queue until a teammate claims it.\n\n### Retries\n\nA failed run may retry.\n",
  "g/glossary.md": "# Glossary\n\n## MORIBUND\n\nA run whose teammate went quiet. Not the queue.\n",
};

test("guideSection: a heading and what's under it, up to the next heading at its level", () => {
  const tasks = guideTopics({
    ...MINI,
    "g/01-tasks.md": "# Tasks\n\nA task is work.\n\n## The Queue\n\nWaiting.\n\n```\n## not a heading\n```\n\n### Retries\n\nRetry.\n\n## Runs\n\nAttempts.\n",
  })[1]!;
  const queue = guideSection(tasks, "the-queue");
  assertEquals([queue.title, queue.level, queue.anchor], ["The Queue", 2, "the-queue"]);
  assertEquals(queue.markdown, "## The Queue\n\nWaiting.\n\n```\n## not a heading\n```\n\n### Retries\n\nRetry.");
  assertEquals(guideSection(tasks, "retries").markdown, "### Retries\n\nRetry.");
  assertEquals(guideSection(tasks, "runs").markdown, "## Runs\n\nAttempts.");
  // No anchor, the title's, or an unknown one: the whole topic.
  for (const a of [undefined, "", "tasks", "renamed-heading"]) {
    const whole = guideSection(tasks, a);
    assertEquals([whole.title, whole.level, whole.anchor, whole.markdown], ["Tasks", 1, "", tasks.markdown], String(a));
  }
});

test("guideTopics: topic ids, titles, headings and app links, in reading order", () => {
  const topics = guideTopics(MINI);
  assertEquals(topics.map((t) => [t.topic, t.title]), [["getting-started", "Getting Started"], ["tasks", "Tasks"], ["glossary", "Glossary"]]);
  assertEquals(topics[1]?.headings.map((h) => h.id), ["tasks", "the-queue", "retries"]);
  assertEquals(topics[0]?.markdown.includes("](/help/glossary)"), true);
  assertEquals(guideTopics(MINI, "/m/help")[0]?.markdown.includes("](/m/help/tasks)"), true);
});

test("adjacentTopics: previous and next in reading order", () => {
  const topics = guideTopics(MINI);
  const titles = (t: string) => { const { prev, next } = adjacentTopics(topics, t); return [prev?.title ?? null, next?.title ?? null]; };
  assertEquals(titles("getting-started"), [null, "Tasks"]);
  assertEquals(titles("tasks"), ["Getting Started", "Glossary"]);
  assertEquals(titles("glossary"), ["Tasks", null]);
  assertEquals(titles("nope"), [null, null]);
});

test("topicForAnchor: an old one-page anchor finds the topic that has it", () => {
  const topics = guideTopics(MINI);
  assertEquals(topicForAnchor(topics, "moribund"), "glossary");
  assertEquals(topicForAnchor(topics, "the-queue", "glossary"), "tasks");
  assertEquals(topicForAnchor(topics, "read-next", "getting-started"), "getting-started");
  assertEquals(topicForAnchor(topics, "nowhere"), null);
});

test("plainText: markdown as words", () => {
  assertEquals(plainText("> **Note:** see [this](x.md).\n\n- [ ] one `two`\n\n| a | b |\n|---|---|\n| c | d |\n\n```sh\nmpt start\n```"),
    "Note: see this. one two a b c d mpt start");
});

test("buildSearchIndex: one entry per section, ids matching the headings", () => {
  const index = buildSearchIndex(guideTopics(MINI));
  assertEquals(index.map((e) => `${e.topic}#${e.id}`), [
    "getting-started#getting-started", "getting-started#read-next", "tasks#tasks", "tasks#the-queue", "tasks#retries", "glossary#glossary", "glossary#moribund",
  ]);
  assertEquals(index[3]?.text, "Waiting work sits in the queue until a teammate claims it.");
});

test("searchGuide: every word must match; heading hits first; blank finds nothing", () => {
  const index = buildSearchIndex(guideTopics(MINI));
  const ids = (q: string) => searchGuide(index, q).map((r) => r.entry.id);
  assertEquals(ids("queue"), ["the-queue", "moribund"]);
  assertEquals(ids("QUEUE teammate"), ["the-queue", "moribund"]);
  assertEquals(ids("queue claims"), ["the-queue"]);
  assertEquals(ids("retry"), ["retries"]);
  assertEquals(ids("zzz"), []);
  assertEquals(ids("   "), []);
  assertEquals(searchGuide(index, "queue", 1).length, 1);
});

test("snippet: the text around the first match, cut at words", () => {
  const text = "alpha ".repeat(40) + "needle here " + "omega ".repeat(40);
  const s = snippet(text, ["needle"], 60);
  assertEquals(s.startsWith("…") && s.endsWith("…") && s.includes("needle"), true, s);
  assertEquals(snippet("short text", ["x"]), "short text");
});

test("searchAnnouncement: what the live region says", () => {
  assertEquals(searchAnnouncement("queue", 3), "3 results for “queue”");
  assertEquals(searchAnnouncement(" queue ", 1), "1 result for “queue”");
  assertEquals(searchAnnouncement("zzz", 0), "No results for “zzz”");
  assertEquals(searchAnnouncement("  ", 0), "");
});

test("the real guide: every topic has a title and unique anchors, and the search finds it", () => {
  const modules = Object.fromEntries(PAGES.map((f) => [`docs/guide/${f}`, fs.readFileSync(path.join(GUIDE_DIR, f), "utf8")]));
  const topics = guideTopics(modules);
  for (const t of topics) {
    assertEquals(new Set(t.headings.map((h) => h.id)).size, t.headings.length, `${t.file}: duplicate anchors`);
    assertEquals(t.headings[0]?.level, 1, t.file);
  }
  const index = buildSearchIndex(topics);
  assertEquals(index.length, topics.reduce((n, t) => n + t.headings.length, 0));
  assertEquals(searchGuide(index, "moribund").some((r) => r.entry.topic === "glossary" && r.entry.id === "moribund"), true);
  // Every in-app link a page carries goes to a real topic and heading.
  const broken: string[] = [];
  for (const t of topics) {
    for (const [, href = ""] of t.markdown.replace(/^```[\s\S]*?^```/gm, "").matchAll(/\]\(([^)\s]+)\)/g)) {
      if (!href.startsWith("/help")) continue;
      const [p = "", anchor] = href.split("#");
      const target = topics.find((x) => helpPath(x.topic) === p);
      if (!target) broken.push(`${t.file}: ${href} (no topic)`);
      else if (anchor && !target.headings.some((h) => h.id === anchor)) broken.push(`${t.file}: ${href} (no heading)`);
    }
  }
  assertEquals(broken, []);
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
  // The Help page renders each at its own levels under its `#` h1, so a skip is an axe heading-order failure there.
  const bad: string[] = [];
  for (const f of PAGES) {
    const levels = [...prose(path.join(GUIDE_DIR, f)).matchAll(/^(#{1,6})\s/gm)].map((m) => (m[1] ?? "").length);
    if (levels[0] !== 1 || levels.filter((l) => l === 1).length !== 1) bad.push(`${f}: needs exactly one # title, first`);
    levels.forEach((l, i) => { if (i > 0 && l > (levels[i - 1] ?? 0) + 1) bad.push(`${f}: heading ${i + 1} jumps to level ${l}`); });
  }
  assertEquals(bad, []);
});
