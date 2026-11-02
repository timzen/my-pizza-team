/**
 * tests/help-ui.test.ts — The in-app Help's URLs (ui/src/lib/help.ts):
 * `helpPath` (how the rest of the UI links into the guide), reading a topic and
 * an anchor back out of a URL, which paths are the Help, and that
 * `HELP_TOPICS` names exactly the pages in docs/guide/, in order.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import {
  HELP_HOME_TOPIC, HELP_ROOT, HELP_TOPICS, MOBILE_HELP_ROOT, anchorOfHash, helpPath, helpTopicParam, isHelpPath,
  resolveTopic, topicOfFile,
} from "../ui/src/lib/help.ts";
import { guidePages } from "../ui/src/lib/guide.ts";
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
