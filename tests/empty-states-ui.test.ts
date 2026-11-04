/**
 * tests/empty-states-ui.test.ts — The lists' empty states (ui/src/lib/empty-states.ts):
 * every explanation is one short sentence under a short title, every "Learn more"
 * opens a heading that exists in the real guide, every entry is rendered by some
 * screen (and the lists the program named all have one), `listView` keeps
 * "empty" and "no matches" apart (and both off screen while loading), and
 * `spawnState` says whether the Team tab's Spawn would happen, and why not.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import {
  EMPTY_STATES, LEADER_COMMAND, NO_MATCHES_TEXT, emptyStateCopy, listView, spawnState, type EmptyStateKey,
} from "../ui/src/lib/empty-states.ts";
import { guideTopics } from "../ui/src/lib/guide.ts";
import { HELP_TOPICS } from "../ui/src/lib/help.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_SRC = path.join(ROOT, "ui/src");

/** The lists the onboarding program asked for by name: each must have an empty state. */
const REQUIRED: EmptyStateKey[] = [
  "inbox", "queue", "board", "tasks", "schedule", "pending", "archived", "thoughts", "thoughtsList", "source",
  "team", "usage", "personas", "storyTasks",
];

test("EMPTY_STATES: every list the program named has one", () => {
  for (const key of REQUIRED) assertEquals(typeof EMPTY_STATES[key].text, "string", key);
});

test("EMPTY_STATES: a short title and one short sentence each", () => {
  const bad: string[] = [];
  for (const [key, copy] of Object.entries(EMPTY_STATES)) {
    const { title, text } = copy;
    if (title.length > 40) bad.push(`${key}: title is ${title.length} characters (keep it under 40)`);
    if (/[.!]$/.test(title)) bad.push(`${key}: title ends in punctuation`);
    if (text.includes("\n")) bad.push(`${key}: more than one line`);
    if (text.length > 130) bad.push(`${key}: ${text.length} characters (keep it under 130)`);
    if (!/[.]$/.test(text)) bad.push(`${key}: doesn't end with a period`);
    // One sentence: no full stop followed by another sentence inside it.
    if (/[.!?]\s+[A-Z]/.test(text)) bad.push(`${key}: more than one sentence`);
    for (const s of [title, text]) if (s !== s.trim() || /\s{2}/.test(s)) bad.push(`${key}: stray whitespace`);
  }
  assertEquals(bad, []);
});

test("EMPTY_STATES: an empty state never reads like 'no matches'", () => {
  for (const [key, copy] of Object.entries(EMPTY_STATES)) {
    assertEquals(/match/i.test(copy.title + copy.text), false, key);
  }
  assertEquals(NO_MATCHES_TEXT, "Nothing matches the filters.");
});

test("EMPTY_STATES: every Learn more opens a heading that exists in the guide", () => {
  const dir = path.join(ROOT, "docs/guide");
  const modules = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  const topics = guideTopics(modules);
  const missing: string[] = [];
  for (const [key, copy] of Object.entries(EMPTY_STATES)) {
    const target = copy.learnMore;
    if (!(HELP_TOPICS as readonly string[]).includes(target.topic)) { missing.push(`${key}: no topic ${target.topic}`); continue; }
    const t = topics.find((x) => x.topic === target.topic);
    if (!t) missing.push(`${key}: no page for ${target.topic}`);
    else if (target.anchor && !t.headings.some((h) => h.id === target.anchor)) missing.push(`${key}: no #${target.anchor} in ${target.topic}`);
  }
  assertEquals(missing, []);
});

test("EMPTY_STATES: every entry is rendered by some screen", () => {
  // Copy nobody renders rots: each key appears as kind="<key>" in a .tsx.
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
  assertEquals(Object.keys(EMPTY_STATES).filter((k) => !all.includes(`kind="${k}"`)), []);
});

test("emptyStateCopy: fills a source's name, with a fallback", () => {
  assertEquals(emptyStateCopy("source", { label: "Jira" }).title, "Nothing mirrored from Jira yet");
  assertEquals(emptyStateCopy("source").title, "Nothing mirrored from this source yet");
  assertEquals(emptyStateCopy("source", { label: "Jira" }).text.includes("{label}"), false);
  assertEquals(emptyStateCopy("board"), EMPTY_STATES.board);
});

test("listView: loading, empty, no matches, and the list are four different things", () => {
  assertEquals(listView({ loaded: false, total: 0, shown: 0 }), "loading");
  assertEquals(listView({ loaded: false, total: 3, shown: 3 }), "loading");
  assertEquals(listView({ loaded: true, total: 0, shown: 0 }), "empty");
  assertEquals(listView({ loaded: true, total: 5, shown: 0 }), "no-matches");
  assertEquals(listView({ loaded: true, total: 5, shown: 2 }), "list");
});

test("spawnState: the daemon realizes a spawn — a leader isn't needed", () => {
  assertEquals(spawnState({ spawning: { canSpawn: true }, notReady: null }), { canSpawn: true });
  // Before /health answers, don't claim the daemon can't.
  assertEquals(spawnState(null), { canSpawn: true });
});

test("spawnState: when the daemon can't, it's blocked — and says why, with the daemon's fix", () => {
  // There is no leader-realized fallback any more, so a connected leader doesn't help.
  const s = spawnState({ spawning: { canSpawn: false, reason: "tmux not found", fix: "install tmux" } });
  assertEquals(s.canSpawn, false);
  assertEquals(s.blockedReason?.includes("tmux not found; install tmux"), true);
  assertEquals(s.blockedReason?.includes("leader"), false);
  assertEquals(spawnState({ spawning: { canSpawn: false } }).blockedReason?.includes("()"), false);
});

test("spawnState: a failing readiness probe is reported, but doesn't block a spawn", () => {
  assertEquals(
    spawnState({ spawning: { canSpawn: true }, notReady: { ready: false, reason: "credentials expired" } }),
    { canSpawn: true, notReadyReason: "credentials expired" },
  );
  assertEquals(spawnState({ spawning: { canSpawn: true }, notReady: { ready: false } }).notReadyReason, "the readiness probe is failing");
  assertEquals(spawnState({ spawning: { canSpawn: true }, notReady: { ready: true } }).notReadyReason, undefined);
});

test("LEADER_COMMAND is the CLI's real command", () => {
  assertEquals(LEADER_COMMAND, "mpt lead");
  assertEquals(fs.readFileSync(path.join(ROOT, "README.md"), "utf8").includes("`mpt lead`"), true);
});
