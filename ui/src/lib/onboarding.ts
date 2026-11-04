/**
 * lib/onboarding.ts — The Welcome checklist's words and rules, on the UI's side
 * (docs/DESIGN.md "First run: a checklist, not a tour").
 *
 * The daemon derives the steps from team state (`GET /api/onboarding`,
 * daemon/onboarding.ts); this module says what each step is called, the one
 * sentence that explains it, and where its "Learn more" opens the guide
 * (`WELCOME_STEPS`), and holds the card's pure rules: how far along the team is
 * and which step is next (`welcomeProgress`), whether the card shows its steps,
 * its "You're set" ending, or nothing (`welcomeMode`), and what a poll's answer
 * says that the last one didn't (`welcomeNews` — announced, so a step ticking
 * off is heard; the first answer is a baseline, an unchanged one says nothing:
 * docs/DESIGN.md "Polling Never Disturbs the Reader").
 *
 * The copy lives here so tests/onboarding-ui.test.ts can hold each step to a
 * short title and one sentence and check every "Learn more" is a real heading.
 * components/onboarding/WelcomeCard.tsx renders it. Only type imports and
 * `shared/protocol.ts`'s step order, so it's unit-tested directly.
 */

import { ONBOARDING_STEP_IDS, type OnboardingResponse, type OnboardingStep, type OnboardingStepId } from "../../../shared/protocol.ts";
import type { HelpTopic } from "./help.ts";

/** One step's words: a short imperative title, one sentence, and where to read more. */
export interface WelcomeStepCopy {
  /** A few words, no period ("Start the leader"). */
  title: string;
  /** One sentence, ending in a period: what the step is and why. */
  text: string;
  /** Where "Learn more" opens the guide (lib/help.ts `helpPath` terms). */
  learnMore: { topic: HelpTopic; anchor?: string };
}

/** Every step's copy, keyed by the daemon's step id (listed in `ONBOARDING_STEP_IDS` order). */
export const WELCOME_STEPS: Record<OnboardingStepId, WelcomeStepCopy> = {
  leaderOnline: {
    title: "Start the leader",
    text: "The leader is the assistant you chat with, and it starts teammates for you; start it with one click.",
    learnMore: { topic: "glossary", anchor: "leader" },
  },
  teammateOnline: {
    title: "Get a teammate",
    text: "Teammates are the agents that pick up work; spawn one now, or let the leader start them to meet the team size.",
    learnMore: { topic: "teammates", anchor: "the-team-tab" },
  },
  firstTaskCreated: {
    title: "Create your first task",
    text: "A task is a goal, what done means, and the folder to work in; try the sample, or write your own.",
    learnMore: { topic: "tasks-and-runs", anchor: "tasks-what-you-want-done" },
  },
  firstRunStarted: {
    title: "Watch it run",
    text: "Once a teammate picks the task up, the Queue shows who has it, and you can watch it work live.",
    learnMore: { topic: "tasks-and-runs", anchor: "the-queue" },
  },
  firstRunReviewed: {
    title: "Review the result",
    text: "Finished work lands in the Inbox, unread; open it to read the teammate's summary and decide what's next.",
    learnMore: { topic: "tasks-and-runs", anchor: "the-inbox" },
  },
  assistantUsed: {
    title: "Ask the assistant something",
    text: "Tell the assistant what you want in your own words, and it plans the work with you and writes the tasks.",
    learnMore: { topic: "assistant" },
  },
  thoughtCaptured: {
    title: "Capture a thought",
    text: "Thoughts are sticky notes for ideas that aren't work yet; a teammate reads them and suggests what could be.",
    learnMore: { topic: "thoughts-and-triage", anchor: "writing-a-note" },
  },
};

/** The guide topics the "You're set" ending points to, in reading order. */
export const WELCOME_NEXT_READING: ReadonlyArray<{ topic: HelpTopic; label: string }> = [
  { topic: "getting-started", label: "Getting Started" },
  { topic: "tasks-and-runs", label: "Tasks and runs" },
  { topic: "stories-and-workflows", label: "Stories and workflows" },
  { topic: "teammates", label: "Teammates" },
  { topic: "tips", label: "Tips" },
];

/** The window event that asks every mounted Welcome card to refetch (after a dismiss or a reopen). */
export const ONBOARDING_CHANGED_EVENT = "mpt:onboarding-changed";

/** How far along the checklist is. */
export interface WelcomeProgress {
  done: number;
  total: number;
  /** The first undone step, in order — the one the card highlights; null when all are done. */
  next: OnboardingStepId | null;
}

/**
 * Count the done steps and find the next one. Steps are taken in
 * `ONBOARDING_STEP_IDS` order whatever order they arrive in, and a step the
 * answer lacks counts as undone (an older daemon), so the meter can't overstate.
 */
export function welcomeProgress(steps: readonly OnboardingStep[]): WelcomeProgress {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ordered = ONBOARDING_STEP_IDS.map((id) => ({ id, done: byId.get(id)?.done === true }));
  return {
    done: ordered.filter((s) => s.done).length,
    total: ordered.length,
    next: ordered.find((s) => !s.done)?.id ?? null,
  };
}

/** What the card shows: nothing, its steps, or the "You're set" ending. */
export type WelcomeMode = "hidden" | "checklist" | "done";

/**
 * The card's mode for the daemon's answer. Unfinished and visible: the steps.
 * Finished: "You're set" — if the card is shown anyway (reopened from Help), or
 * this screen watched it get there (`sawChecklist`: the daemon latches
 * `completedAt` and stops calling it visible the moment the last step ticks, but
 * the user should see the ending before the card goes). Otherwise nothing.
 * `closed` is the user's Dismiss / Close on this screen, honored before the
 * daemon's next answer arrives.
 */
export function welcomeMode(res: OnboardingResponse | null, opts: { sawChecklist?: boolean; closed?: boolean } = {}): WelcomeMode {
  if (!res || opts.closed) return "hidden";
  if (welcomeProgress(res.steps).next === null) return res.visible || opts.sawChecklist ? "done" : "hidden";
  return res.visible ? "checklist" : "hidden";
}

/**
 * What changed between two answers, as sentences for the polite live region:
 * the steps that became done ("Done: Start the leader. 2 of 7.", several in one
 * sentence), then "You're set" when the last one did. Nothing for the first answer (`prev` null — a
 * baseline), nothing when nothing ticked, and nothing for a step that went
 * back to undone (the leader stopping isn't news worth interrupting for).
 */
export function welcomeNews(prev: OnboardingResponse | null, next: OnboardingResponse): string[] {
  if (!prev) return [];
  const was = new Set(prev.steps.filter((s) => s.done).map((s) => s.id));
  const progress = welcomeProgress(next.steps);
  const ticked = ONBOARDING_STEP_IDS.filter((id) => !was.has(id) && next.steps.some((s) => s.id === id && s.done));
  if (!ticked.length) return [];
  const news = [`Done: ${ticked.map((id) => WELCOME_STEPS[id].title).join(", ")}. ${progress.done} of ${progress.total}.`];
  if (progress.next === null) news.push("Welcome checklist complete: you're set.");
  return news;
}
