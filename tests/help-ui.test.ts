/**
 * tests/help-ui.test.ts — The in-app Help's URLs (ui/src/lib/help.ts):
 * `helpPath` (how the rest of the UI links into the guide), reading a topic and
 * an anchor back out of a URL, which paths are the Help, and that
 * `HELP_TOPICS` names exactly the pages in docs/guide/, in order — and the
 * per-page help: `helpForPath` for every screen (each section it names exists
 * in the real guide), `parseHelpHref`, and when the `?` shortcut is typing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import {
  HELP_HOME_TOPIC, HELP_ROOT, HELP_TOPICS, MOBILE_HELP_ROOT, anchorOfHash, helpForPath, helpPath, helpTopicParam,
  isHelpPath, isHelpShortcut, isTypingTarget, parseHelpHref, resolveTopic, topicOfFile, type TypingTargetLike,
} from "../ui/src/lib/help.ts";
import { guidePages, guideTopics } from "../ui/src/lib/guide.ts";
import { MOBILE_ROOT } from "../ui/src/lib/mobile.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("helpPath: Getting Started is /help; a topic is /help/<topic>; an anchor its #section", () => {
  assertEquals(helpPath("getting-started"), "/help");
  assertEquals(helpPath("getting-started", "read-next"), "/help#read-next");
  assertEquals(helpPath("glossary"), "/help/glossary");
  assertEquals(helpPath("glossary", "moribund"), "/help/glossary#moribund");
  assertEquals(helpPath("tasks-and-runs", "#the-queue"), "/help/tasks-and-runs#the-queue");
  assertEquals(helpPath("glossary", ""), "/help/glossary");
  assertEquals(helpPath("", "x"), "/help#x");
  assertEquals(helpPath("glossary", "moribund", MOBILE_HELP_ROOT), "/m/help/glossary#moribund");
  assertEquals(helpPath("a b", "c d"), "/help/a%20b#c%20d");
});

test("topicOfFile: a guide file's topic", () => {
  assertEquals(topicOfFile("00-getting-started.md"), "getting-started");
  assertEquals(topicOfFile("10-tips.md"), "tips");
  assertEquals(topicOfFile("glossary.md"), "glossary");
});

test("HELP_TOPICS names every docs/guide page, in reading order", () => {
  const files = fs.readdirSync(path.join(ROOT, "docs/guide")).filter((f) => f.endsWith(".md"));
  const order = guidePages(Object.fromEntries(files.map((f) => [f, ""]))).map((p) => topicOfFile(p.file));
  assertEquals([...HELP_TOPICS], order);
  assertEquals(HELP_TOPICS[0], HELP_HOME_TOPIC);
});

test("helpTopicParam: the topic part of a Help path", () => {
  assertEquals(helpTopicParam("/help"), undefined);
  assertEquals(helpTopicParam("/help/"), undefined);
  assertEquals(helpTopicParam("/help/glossary"), "glossary");
  assertEquals(helpTopicParam("/help/glossary/"), "glossary");
  assertEquals(helpTopicParam("/m/help/phone", MOBILE_HELP_ROOT), "phone");
  assertEquals(helpTopicParam("/helpers"), undefined);
});

test("resolveTopic: forgiving about case and file names; none is Getting Started", () => {
  const topics = [...HELP_TOPICS];
  assertEquals(resolveTopic(undefined, topics), "getting-started");
  assertEquals(resolveTopic("", topics), "getting-started");
  assertEquals(resolveTopic("glossary", topics), "glossary");
  assertEquals(resolveTopic("Glossary", topics), "glossary");
  assertEquals(resolveTopic("01-tasks-and-runs.md", topics), "tasks-and-runs");
  assertEquals(resolveTopic("01-tasks-and-runs", topics), "tasks-and-runs");
  assertEquals(resolveTopic("nope", topics), null);
  assertEquals(resolveTopic("%E0%A4%A", topics), null); // a malformed escape doesn't throw
});

test("anchorOfHash: the decoded anchor", () => {
  assertEquals(anchorOfHash(""), "");
  assertEquals(anchorOfHash("#moribund"), "moribund");
  assertEquals(anchorOfHash("#a%20b"), "a b");
  assertEquals(anchorOfHash("#%E0%A4%A"), "%E0%A4%A");
});

test("isHelpPath: the desktop and phone Help, any topic — nothing else", () => {
  for (const p of ["/help", "/help/", "/help/glossary", "/m/help", "/m/help/phone"]) assertEquals(isHelpPath(p), true, p);
  for (const p of ["/", "/helpers", "/m", "/m/helpdesk", "/config/help"]) assertEquals(isHelpPath(p), false, p);
  assertEquals(MOBILE_HELP_ROOT, `${MOBILE_ROOT}${HELP_ROOT}`);
});

/** Every screen the per-page ? covers, and the section it should open. */
const SCREENS: Array<[path: string, topic: string, anchor: string | undefined, opts?: { workDefType?: string }]> = [
  ["/", "tasks-and-runs", "the-inbox"],
  ["/queue", "tasks-and-runs", "the-queue"],
  ["/thoughts", "thoughts-and-triage", undefined],
  ["/work/board", "stories-and-workflows", "the-board"],
  ["/story/add-user-auth", "stories-and-workflows", "stories"],
  ["/task/add-user-auth/add-user-auth-1", "stories-and-workflows", "reviewing-work"],
  ["/stories/new", "stories-and-workflows", "creating-a-story"],
  ["/story/add-user-auth/tasks/new", "stories-and-workflows", "managing-tasks"],
  ["/work", "tasks-and-runs", "the-work-tabs"],
  ["/work/tasks", "tasks-and-runs", "standalone-tasks-and-scheduled-jobs"],
  ["/work/schedule", "tasks-and-runs", "standalone-tasks-and-scheduled-jobs"],
  ["/work/pending", "tasks-and-runs", "pending-write-first-run-when-its-right"],
  ["/work/archived", "tasks-and-runs", "the-work-tabs"],
  ["/work/source/github", "sources", "a-sources-tab"],
  ["/work-defs/new", "tasks-and-runs", "standalone-tasks-and-scheduled-jobs"],
  ["/work-defs/nightly", "tasks-and-runs", "standalone-tasks-and-scheduled-jobs"],
  ["/work-defs/nightly", "tasks-and-runs", "standalone-tasks-and-scheduled-jobs", { workDefType: "Scheduled" }],
  ["/work-defs/triage-x", "thoughts-and-triage", "auto-triage-notes-that-become-work", { workDefType: "Triage" }],
  ["/work-defs/gh-1", "sources", "a-sources-tab", { workDefType: "External" }],
  ["/thoughts/note-1/triage", "thoughts-and-triage", "auto-triage-notes-that-become-work"],
  ["/config", "configuration", undefined],
  ["/config/teammates", "teammates", "one-teammate-per-directory"],
  ["/config/sources", "sources", "setting-up-a-source-from-the-ui"],
  ["/config/sources/github", "sources", "setting-up-a-source-from-the-ui"],
  ["/config/workflows", "stories-and-workflows", "workflows"],
  ["/config/workflows/default", "stories-and-workflows", "viewing-and-editing-a-workflow"],
  ["/config/personas", "personas", "the-library"],
  ["/config/personas/pkg/reviewer", "personas", "the-library"],
  ["/config/triage", "thoughts-and-triage", "auto-triage-notes-that-become-work"],
  ["/config/theme", "configuration", undefined],
  ["/usage", "teammates", "usage-what-the-team-costs"],
  ["/teammates/Pepperoni", "teammates", "watching-a-teammate"],
  ["/m", "phone", undefined],
  ["/m/chat", "phone", undefined],
  ["/m/inbox", "phone", undefined],
];

test("helpForPath: every screen opens its section of the guide", () => {
  for (const [p, topic, anchor, opts] of SCREENS) {
    const help = helpForPath(p, opts);
    assertEquals([help?.topic, help?.anchor], [topic, anchor], p);
    assertEquals(typeof help?.page === "string" && help.page.length > 0, true, `${p} has a page name`);
  }
  assertEquals(helpForPath("/work/board/")?.anchor, "the-board"); // a trailing slash
  assertEquals(helpForPath("/work-defs/x", { workDefType: "Scheduled" })?.page, "Scheduled job");
});

test("helpForPath: the Help itself and paths no screen lives at have none", () => {
  for (const p of ["/help", "/help/glossary", "/m/help", "/m/help/phone", "/nope", "/story", "/task/only-story", "/teammates", "/thoughts/x", "/config/nope", "/work/source"]) {
    assertEquals(helpForPath(p), null, p);
  }
});

test("helpForPath: every section it names is a heading in the real guide", () => {
  const dir = path.join(ROOT, "docs/guide");
  const modules = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  const topics = guideTopics(modules);
  const missing: string[] = [];
  for (const [p, , , opts] of SCREENS) {
    const help = helpForPath(p, opts)!;
    const t = topics.find((x) => x.topic === help.topic);
    if (!t) missing.push(`${p}: no topic ${help.topic}`);
    else if (help.anchor && !t.headings.some((h) => h.id === help.anchor)) missing.push(`${p}: no #${help.anchor} in ${help.topic}`);
  }
  assertEquals(missing, []);
});

test("parseHelpHref: a Help link's topic and anchor; anything else is null", () => {
  assertEquals(parseHelpHref("/help"), { topic: "getting-started" });
  assertEquals(parseHelpHref("/help#read-next"), { topic: "getting-started", anchor: "read-next" });
  assertEquals(parseHelpHref("/help/glossary"), { topic: "glossary" });
  assertEquals(parseHelpHref("/help/tasks-and-runs#the-queue"), { topic: "tasks-and-runs", anchor: "the-queue" });
  assertEquals(parseHelpHref("/help/a%20b#c%20d"), { topic: "a b", anchor: "c d" });
  assertEquals(parseHelpHref("/m/help/phone", MOBILE_HELP_ROOT), { topic: "phone" });
  for (const h of ["/helpers", "/work/board", "#x", "https://example.com/help"]) assertEquals(parseHelpHref(h), null, h);
});

/** A fake element for isTypingTarget. */
function el(tagName: string, extra: Partial<TypingTargetLike> & { role?: string; inDialog?: boolean } = {}): TypingTargetLike {
  const { role, inDialog, ...rest } = extra;
  return { tagName, getAttribute: (n) => (n === "role" ? role ?? null : null), closest: () => (inDialog ? {} : null), ...rest };
}

test("isTypingTarget: text fields, editors and dialogs are typing; buttons and the page aren't", () => {
  for (const t of [el("INPUT"), el("input", { type: "search" }), el("INPUT", { type: "email" }), el("TEXTAREA"), el("SELECT"),
    el("DIV", { isContentEditable: true }), el("DIV", { role: "textbox" }), el("BUTTON", { inDialog: true })]) {
    assertEquals(isTypingTarget(t), true, JSON.stringify(t));
  }
  for (const t of [null, undefined, el("BODY"), el("BUTTON"), el("A"), el("INPUT", { type: "checkbox" }), el("INPUT", { type: "radio" }), el("H1")]) {
    assertEquals(isTypingTarget(t), false, JSON.stringify(t));
  }
});

test("isHelpShortcut: a bare ? outside a text field", () => {
  assertEquals(isHelpShortcut({ key: "?", target: el("BODY") }), true);
  assertEquals(isHelpShortcut({ key: "?", target: el("BUTTON") }), true);
  assertEquals(isHelpShortcut({ key: "?", target: el("TEXTAREA") }), false);
  assertEquals(isHelpShortcut({ key: "?", ctrlKey: true, target: el("BODY") }), false);
  assertEquals(isHelpShortcut({ key: "?", metaKey: true, target: el("BODY") }), false);
  assertEquals(isHelpShortcut({ key: "?", altKey: true, target: el("BODY") }), false);
  assertEquals(isHelpShortcut({ key: "/", target: el("BODY") }), false);
});
