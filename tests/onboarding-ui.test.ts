/**
 * tests/onboarding-ui.test.ts — The Welcome checklist's UI rules (ui/src/lib/onboarding.ts):
 * every step the daemon reports has a short title and one sentence, every
 * "Learn more" opens a heading that exists in the real guide, the progress
 * meter and the highlighted next step follow the daemon's step order, the
 * card's mode (steps / "You're set" / hidden) honors visible, dismissed and
 * watched-to-the-end, and a poll is announced only when a step ticked off.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEquals } from "./_assert.ts";
import { ONBOARDING_STEP_IDS, type OnboardingResponse, type OnboardingStepId } from "../shared/protocol.ts";
import { WELCOME_NEXT_READING, WELCOME_STEPS, welcomeMode, welcomeNews, welcomeProgress } from "../ui/src/lib/onboarding.ts";
import { guideTopics } from "../ui/src/lib/guide.ts";
import { HELP_TOPICS } from "../ui/src/lib/help.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A daemon answer with `done` steps done. */
function answer(done: OnboardingStepId[], over: Partial<OnboardingResponse> = {}): OnboardingResponse {
  const steps = ONBOARDING_STEP_IDS.map((id) => ({ id, done: done.includes(id) }));
  return {
    steps, complete: steps.every((s) => s.done), visible: true, hasHistory: false,
    dismissedAt: null, reopenedAt: null, completedAt: null, sampleTask: null, ...over,
  };
}

test("WELCOME_STEPS: one entry per daemon step, a short title and one sentence each", () => {
  assertEquals(Object.keys(WELCOME_STEPS).sort(), [...ONBOARDING_STEP_IDS].sort());
  const bad: string[] = [];
  for (const [key, { title, text }] of Object.entries(WELCOME_STEPS)) {
    if (title.length > 32) bad.push(`${key}: title is ${title.length} characters`);
    if (/[.!]$/.test(title)) bad.push(`${key}: title ends in punctuation`);
    if (text.length > 130) bad.push(`${key}: ${text.length} characters (keep it under 130)`);
    if (!text.endsWith(".")) bad.push(`${key}: doesn't end with a period`);
    if (/[.!?]\s+[A-Z]/.test(text)) bad.push(`${key}: more than one sentence`);
  }
  assertEquals(bad, []);
});

test("WELCOME_STEPS and WELCOME_NEXT_READING: every Learn more opens a real guide heading", () => {
  const dir = path.join(ROOT, "docs/guide");
  const modules = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  const topics = guideTopics(modules);
  const missing: string[] = [];
  const targets = [
    ...Object.entries(WELCOME_STEPS).map(([k, c]) => [k, c.learnMore] as const),
    ...WELCOME_NEXT_READING.map((r) => [r.label, { topic: r.topic, anchor: undefined }] as const),
  ];
  for (const [key, target] of targets) {
    if (!(HELP_TOPICS as readonly string[]).includes(target.topic)) { missing.push(`${key}: no topic ${target.topic}`); continue; }
    const t = topics.find((x) => x.topic === target.topic);
    if (!t) missing.push(`${key}: no page for ${target.topic}`);
    else if (target.anchor && !t.headings.some((h) => h.id === target.anchor)) missing.push(`${key}: no #${target.anchor} in ${target.topic}`);
  }
  assertEquals(missing, []);
});

test("welcomeProgress: counts done steps and picks the first undone, in the daemon's order", () => {
  assertEquals(welcomeProgress(answer([]).steps), { done: 0, total: 7, next: "leaderOnline" });
  assertEquals(welcomeProgress(answer(["leaderOnline", "assistantUsed"]).steps), { done: 2, total: 7, next: "teammateOnline" });
  // Out of order on the wire, still taken in order; a missing step counts as undone.
  const shuffled = answer(["leaderOnline", "teammateOnline"]).steps.slice().reverse().filter((s) => s.id !== "firstTaskCreated");
  assertEquals(welcomeProgress(shuffled), { done: 2, total: 7, next: "firstTaskCreated" });
  assertEquals(welcomeProgress(answer([...ONBOARDING_STEP_IDS]).steps).next, null);
});

test("welcomeMode: steps while visible, You're set once finished on screen or reopened, else hidden", () => {
  assertEquals(welcomeMode(null), "hidden");
  assertEquals(welcomeMode(answer([])), "checklist");
  assertEquals(welcomeMode(answer([], { visible: false })), "hidden"); // dismissed, or a team with history
  assertEquals(welcomeMode(answer([]), { closed: true }), "hidden"); // Dismiss, before the daemon answers
  const all = [...ONBOARDING_STEP_IDS];
  // The daemon latches completedAt and stops calling it visible as the last step ticks.
  assertEquals(welcomeMode(answer(all, { visible: false })), "hidden");
  assertEquals(welcomeMode(answer(all, { visible: false }), { sawChecklist: true }), "done");
  assertEquals(welcomeMode(answer(all, { visible: true })), "done"); // reopened from Help
  assertEquals(welcomeMode(answer(all, { visible: true }), { closed: true }), "hidden");
});

test("welcomeNews: the first answer is a baseline, an unchanged one is silent, a tick is announced", () => {
  assertEquals(welcomeNews(null, answer(["leaderOnline"])), []);
  assertEquals(welcomeNews(answer(["leaderOnline"]), answer(["leaderOnline"])), []);
  assertEquals(welcomeNews(answer(["leaderOnline"]), answer([])), []); // went back to undone: not news
  assertEquals(welcomeNews(answer([]), answer(["leaderOnline", "thoughtCaptured"])), [
    "Done: Start the assistant, Capture a thought. 2 of 7.",
  ]);
  const all = [...ONBOARDING_STEP_IDS];
  assertEquals(welcomeNews(answer(all.slice(0, 6)), answer(all)), [
    "Done: Capture a thought. 7 of 7.",
    "Welcome checklist complete: you're set.",
  ]);
});
