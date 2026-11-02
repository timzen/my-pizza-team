/**
 * daemon/onboarding.ts — The Welcome checklist's progress, derived from team state.
 *
 * A new team's Home shows a Welcome card whose steps tick off as the user
 * actually does things — not as they click through a script (docs/DESIGN.md
 * "First run: a checklist, not a tour"). So each step is a question asked of
 * the state the daemon already keeps (members, WorkDefs, the WorkItem queue,
 * the assistant chat, the Thoughts board), every time it's asked:
 *
 *   - `collectOnboardingFacts` reads those facts from the Store (cheap COUNTs,
 *     a first-match WorkDef scan);
 *   - `deriveOnboarding` turns facts plus the persisted marks into the
 *     response — pure, so tests/onboarding.test.ts pins the rules directly.
 *
 * Only what can't be derived is persisted, in the settings table: when the card
 * was dismissed, reopened (from Help), and first seen complete.
 */

import type { Store } from "./store.ts";
import type { OnboardingResponse, OnboardingSampleTask, OnboardingStep, OnboardingStepId } from "../shared/protocol.ts";
import { ONBOARDING_STEP_IDS } from "../shared/protocol.ts";
import { isPoolTeammate } from "./store/members.ts";

/** Settings-table keys: the only onboarding state that is stored. */
export const ONBOARDING_DISMISSED_KEY = "onboarding.dismissedAt";
export const ONBOARDING_REOPENED_KEY = "onboarding.reopenedAt";
export const ONBOARDING_COMPLETED_KEY = "onboarding.completedAt";

/**
 * Finished runs (COMPLETE/FAILED WorkItems) that make a team "one with history":
 * it was using MPT before the checklist existed, so it counts as onboarded and
 * gets no card unless the user reopens it.
 */
export const ONBOARDING_HISTORY_RUNS = 3;

/** The built-in persona the sample task runs with. */
export const SAMPLE_TASK_PERSONA = "builtin:worker";

/** The facts the steps are derived from — what `collectOnboardingFacts` reads. */
export interface OnboardingFacts {
  leaderOnline: boolean;
  /** Pool teammates (not the leader) online now. */
  teammatesOnline: number;
  /** An authored WorkDef exists (not a note's triage container, not an external mirror). */
  hasTask: boolean;
  /** WorkItems a teammate has claimed (IN_PROGRESS, MORIBUND, COMPLETE, FAILED). */
  claimedRuns: number;
  /** COMPLETE/FAILED WorkItems. */
  finishedRuns: number;
  /** COMPLETE/FAILED WorkItems marked read in the Inbox. */
  reviewedRuns: number;
  /** When the user first wrote to the assistant (ISO), or null. */
  firstUserMessageAt: string | null;
  /** When the first (oldest) note was created (ISO), or null when there are none. */
  firstThoughtAt: string | null;
}

/** The persisted marks (settings table), ISO or null. */
export interface OnboardingMarks {
  dismissedAt: string | null;
  reopenedAt: string | null;
  completedAt: string | null;
}

/** Read the facts from the Store. Cheap enough to run on every poll. */
export function collectOnboardingFacts(store: Store): OnboardingFacts {
  const members = store.getMembers().filter((m) => m.status !== "offline");
  const thoughts = store.getThoughts();
  let firstThoughtAt: string | null = null;
  for (const t of thoughts) if (!firstThoughtAt || t.createdAt < firstThoughtAt) firstThoughtAt = t.createdAt;
  return {
    leaderOnline: store.getLeader() !== null,
    teammatesOnline: members.filter((m) => isPoolTeammate(m.name)).length,
    // A note's triage container and an external mirror aren't tasks the user wrote.
    hasTask: store.hasWorkDef((d) => d.parent?.kind !== "thought" && d.parent?.kind !== "external"),
    claimedRuns: store.countWorkItems({ states: ["IN_PROGRESS", "MORIBUND", "COMPLETE", "FAILED"] }),
    finishedRuns: store.countWorkItems({ states: ["COMPLETE", "FAILED"] }),
    reviewedRuns: store.countWorkItems({ states: ["COMPLETE", "FAILED"], read: true }),
    firstUserMessageAt: store.getFirstUserMessageAt(),
    firstThoughtAt,
  };
}

/** Read the persisted marks from the settings table. */
export function readOnboardingMarks(store: Store): OnboardingMarks {
  return {
    dismissedAt: store.getSetting(ONBOARDING_DISMISSED_KEY),
    reopenedAt: store.getSetting(ONBOARDING_REOPENED_KEY),
    completedAt: store.getSetting(ONBOARDING_COMPLETED_KEY),
  };
}

/** Each step's done-ness (and time, where the state records one), in display order. */
export function deriveOnboardingSteps(f: OnboardingFacts): OnboardingStep[] {
  const done: Record<OnboardingStepId, { done: boolean; at?: string }> = {
    leaderOnline: { done: f.leaderOnline },
    // Teammates unregister when they leave, so "has registered" is "online now,
    // or one has claimed a run" — a past claim proves a teammate was here.
    teammateOnline: { done: f.teammatesOnline > 0 || f.claimedRuns > 0 },
    firstTaskCreated: { done: f.hasTask },
    firstRunStarted: { done: f.claimedRuns > 0 },
    firstRunReviewed: { done: f.reviewedRuns > 0 },
    assistantUsed: { done: f.firstUserMessageAt !== null, ...(f.firstUserMessageAt ? { at: f.firstUserMessageAt } : {}) },
    thoughtCaptured: { done: f.firstThoughtAt !== null, ...(f.firstThoughtAt ? { at: f.firstThoughtAt } : {}) },
  };
  return ONBOARDING_STEP_IDS.map((id) => ({ id, ...done[id] }));
}

/**
 * The whole response from facts and marks. `visible` — show the card — is true
 * when it was reopened, or else when it hasn't been dismissed, completed, or
 * outgrown (a team with history). `completedAt` here is the stored mark; the
 * route latches it the first time every step is done.
 */
export function deriveOnboarding(
  facts: OnboardingFacts, marks: OnboardingMarks, sampleTask: OnboardingSampleTask | null,
): OnboardingResponse {
  const steps = deriveOnboardingSteps(facts);
  const complete = steps.every((s) => s.done);
  const hasHistory = facts.finishedRuns >= ONBOARDING_HISTORY_RUNS;
  const visible = marks.reopenedAt !== null || (marks.dismissedAt === null && marks.completedAt === null && !hasHistory);
  return { steps, complete, visible, hasHistory, ...marks, sampleTask };
}

/**
 * The sample task: "Summarize this project", in the leader's directory (null
 * when no leader is online — the card then asks for one), with the built-in
 * worker persona. Only a prefill: nothing is created until the user clicks Run.
 */
export function sampleTaskFor(store: Store): OnboardingSampleTask {
  return {
    title: "Summarize this project",
    goal:
      "Read this directory's README, docs and source layout, and write a short summary of the project: " +
      "what it is for, how it is organized, how to build and test it, and anything that looks unfinished. " +
      "Post the summary as your result. Don't change any files.",
    acceptanceCriteria:
      "MUST NOT modify, create or delete files.\n" +
      "MUST describe the project's purpose and its main parts in a few short paragraphs.\n" +
      "SHOULD name the build and test commands, if there are any.",
    directory: store.getLeader()?.directory ?? null,
    persona: SAMPLE_TASK_PERSONA,
  };
}
