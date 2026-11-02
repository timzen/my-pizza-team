/**
 * tests/field-help-ui.test.ts — The forms' field hints and the cron preview
 * (ui/src/lib/field-help.ts): every hint is one short sentence, every "Learn
 * more" opens a heading that exists in the real guide, `describedBy` builds an
 * `aria-describedby`, and `describeCron` / `cronPreview` put the common cron
 * shapes in words (and decline the rest).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import { FIELD_HELP, cronPreview, describeCron, describedBy, fieldHelp, type FieldHelpKey } from "../ui/src/lib/field-help.ts";
import { guideTopics } from "../ui/src/lib/guide.ts";
import { HELP_TOPICS } from "../ui/src/lib/help.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_SRC = path.join(ROOT, "ui/src");

/** The hints the program asked for by name: they must exist. */
const REQUIRED: FieldHelpKey[] = ["workflow", "persona", "directory", "pending", "taskOrder", "storyTasks", "cron", "acceptanceCriteria", "teamSize"];

test("FIELD_HELP: the required fields all have a hint", () => {
  for (const key of REQUIRED) assertEquals(typeof fieldHelp(key).text, "string", key);
});

test("FIELD_HELP: every hint is one short sentence", () => {
  const bad: string[] = [];
  for (const [key, help] of Object.entries(FIELD_HELP)) {
    const t = help.text;
    if (t.includes("\n")) bad.push(`${key}: more than one line`);
    if (t.length > 130) bad.push(`${key}: ${t.length} characters (keep it under 130)`);
    if (!/[.]$/.test(t)) bad.push(`${key}: doesn't end with a period`);
    if (t !== t.trim() || /\s{2}/.test(t)) bad.push(`${key}: stray whitespace`);
  }
  assertEquals(bad, []);
});

test("FIELD_HELP: every Learn more opens a heading that exists in the guide", () => {
  const dir = path.join(ROOT, "docs/guide");
  const modules = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  const topics = guideTopics(modules);
  const missing: string[] = [];
  for (const [key, help] of Object.entries(FIELD_HELP)) {
    const target = "learnMore" in help ? help.learnMore : undefined;
    if (!target) continue;
    if (!(HELP_TOPICS as readonly string[]).includes(target.topic)) { missing.push(`${key}: no topic ${target.topic}`); continue; }
    const t = topics.find((x) => x.topic === target.topic);
    if (!t) missing.push(`${key}: no page for ${target.topic}`);
    else if (target.anchor && !t.headings.some((h) => h.id === target.anchor)) missing.push(`${key}: no #${target.anchor} in ${target.topic}`);
  }
  assertEquals(missing, []);
});

test("FIELD_HELP: every hint is used by some form", () => {
  // A hint nobody renders is copy that rots: each key appears as field="<key>" (or in a ternary picking it).
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) files.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(UI_SRC);
  const all = files.join("\n");
  const used = (k: string) => [`field="${k}"`, `? "${k}"`, `: "${k}"`].some((form) => all.includes(form));
  const unused = Object.keys(FIELD_HELP).filter((k) => !used(k));
  assertEquals(unused, []);
});

test("describedBy: the ids that apply, space-separated; none leaves the attribute off", () => {
  assertEquals(describedBy("a-hint"), "a-hint");
  assertEquals(describedBy("a-error", "a-hint"), "a-error a-hint");
  assertEquals(describedBy(false, "a-hint", null, undefined, ""), "a-hint");
  assertEquals(describedBy(), undefined);
  assertEquals(describedBy(false, null, undefined, ""), undefined);
});

test("describeCron: the common shapes in words", () => {
  const cases: Array<[string, string]> = [
    ["0 9 * * 1-5", "Every weekday at 9:00"],
    ["0 9 * * *", "Every day at 9:00"],
    ["30 14 * * *", "Every day at 14:30"],
    ["0 2 * * 1", "Every Monday at 2:00"],
    ["0 9 * * 0,6", "Every Saturday and Sunday at 9:00"],
    ["0 9 * * 1,3,5", "Every Monday, Wednesday and Friday at 9:00"],
    ["0 9 * * 7", "Every Sunday at 9:00"],
    ["0 9 * * 0-6", "Every day at 9:00"],
    ["0 9,17 * * *", "Every day at 9:00 and 17:00"],
    ["0 9 1 * *", "On the 1st of every month at 9:00"],
    ["0 9 22 * *", "On the 22nd of every month at 9:00"],
    ["0 9 13 * *", "On the 13th of every month at 9:00"],
    ["0 0 1 1 *", "Every year on January 1 at 0:00"],
    ["0 * * * *", "Every hour"],
    ["15 * * * *", "Every hour at :15"],
    ["0 */2 * * *", "Every 2 hours"],
    ["5 */6 * * *", "Every 6 hours at :05"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["* * * * *", "Every minute"],
    ["*/15 * * * 1-5", "Every 15 minutes on weekdays"],
    ["0 * * * 1", "Every hour on Mondays"],
    ["0 * * * 0,6", "Every hour on weekends"],
    ["0 9-17 * * 1-5", "Every hour from 9:00 to 17:00 on weekdays"],
    ["  0  9 * *  1-5 ", "Every weekday at 9:00"],
  ];
  for (const [cron, words] of cases) assertEquals(describeCron(cron), words, cron);
});

test("describeCron: null for what isn't a 5-field cron, or a shape it doesn't phrase", () => {
  for (const cron of [null, undefined, "", "0 9 * *", "0 9 * * * *", "60 9 * * *", "0 24 * * *", "0 9 32 * *", "0 9 * 13 *", "0 9 * * 8",
    "x 9 * * *", "0 9 * * MON", "0 9 1 * 1", "*/5 9 * * *", "0 9 * 1,2 *", "0 17-9 * * *", "0 9 * * 5-1", "0 */0 * * *"]) {
    assertEquals(describeCron(cron), null, String(cron));
  }
});

test("cronPreview: the cron in words, else what to check", () => {
  assertEquals(cronPreview("0 9 * * 1-5"), "Every weekday at 9:00.");
  assertEquals(cronPreview(""), "No schedule yet: pick a preset or type five fields.");
  assertEquals(cronPreview("   "), "No schedule yet: pick a preset or type five fields.");
  assertEquals(cronPreview("0 9 *"), "Needs five fields, separated by spaces.");
  assertEquals(cronPreview("0 9 1 * 1"), "A custom schedule: check each field.");
});
