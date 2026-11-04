/**
 * daemon/routes/onboarding.ts — The Welcome checklist: progress, dismiss/reopen, the sample task.
 *
 * `GET /api/onboarding` answers the card's steps, derived from team state on
 * every request (daemon/onboarding.ts), plus whether to show the card and the
 * sample task to prefill. The first time every step is done it latches
 * `onboarding.completedAt` in the settings table, so the card stays gone even if
 * a step later reads false again (the leader stopped, say). Dismiss and reopen
 * are the only other writes. `POST /api/onboarding/sample-task` creates and
 * enqueues the sample as a Solitary task — the card's Run; nothing is created
 * before that. See docs/DESIGN.md "First run: a checklist, not a tour".
 */

import type { RouteContext } from "./types.ts";
import { readBody, fail } from "./http.ts";
import type { CreateSampleTaskRequest, CreateSampleTaskResponse, OnboardingResponse } from "../../shared/protocol.ts";
import {
  ONBOARDING_COMPLETED_KEY, ONBOARDING_DISMISSED_KEY, ONBOARDING_REOPENED_KEY,
  collectOnboardingFacts, deriveOnboarding, readOnboardingMarks, sampleTaskFor,
} from "../onboarding.ts";
import { FEATURE_DISABLED_STATUS, featureDisabledBody, isFeatureEnabled } from "../features.ts";

/** The feature the sample task belongs to (Solitary tasks). */
const TASKS_FEATURE = "tasks";

/** A non-empty trimmed string, or undefined. */
function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function registerOnboardingRoutes(ctx: RouteContext): void {
  const { app, store, config } = ctx;

  /** The current response, latching `completedAt` the first time it's complete. */
  const current = (): OnboardingResponse => {
    const facts = collectOnboardingFacts(store);
    const sample = isFeatureEnabled(config, TASKS_FEATURE) ? sampleTaskFor(store) : null;
    let res = deriveOnboarding(facts, readOnboardingMarks(store), sample);
    if (res.complete && res.completedAt === null) {
      store.setSetting(ONBOARDING_COMPLETED_KEY, new Date().toISOString());
      res = deriveOnboarding(facts, readOnboardingMarks(store), sample);
    }
    return res;
  };

  app.get("/api/onboarding", (c) => c.json(current() satisfies OnboardingResponse));

  // Dismiss hides the card (whatever the steps say); it clears a reopen.
  app.post("/api/onboarding/dismiss", (c) => {
    store.setSetting(ONBOARDING_DISMISSED_KEY, new Date().toISOString());
    store.setSetting(ONBOARDING_REOPENED_KEY, null);
    return c.json(current() satisfies OnboardingResponse);
  });

  // Reopen (Help's "Show the Welcome checklist") shows it again, even for a
  // team that's complete or has history, until it's dismissed again.
  app.post("/api/onboarding/reopen", (c) => {
    store.setSetting(ONBOARDING_REOPENED_KEY, new Date().toISOString());
    store.setSetting(ONBOARDING_DISMISSED_KEY, null);
    return c.json(current() satisfies OnboardingResponse);
  });

  app.post("/api/onboarding/sample-task", async (c) => {
    if (!isFeatureEnabled(config, TASKS_FEATURE)) {
      return c.json(featureDisabledBody(TASKS_FEATURE), FEATURE_DISABLED_STATUS);
    }
    const body = (await readBody(c)) as CreateSampleTaskRequest;
    const sample = sampleTaskFor(store);
    const directory = text(body.directory) ?? sample.directory;
    if (!directory) {
      return fail(c, 400, "No assistant is online to take a directory from; pass 'directory' (the project to summarize)");
    }
    const def = store.createWorkDef({
      title: text(body.title) ?? sample.title,
      goal: text(body.goal) ?? sample.goal,
      acceptanceCriteria: text(body.acceptanceCriteria) ?? sample.acceptanceCriteria,
      directory,
      persona: sample.persona,
    });
    return c.json({
      success: true, workDefId: def.id, workItemId: store.getActiveWorkItem(def.id)?.id ?? null,
    } satisfies CreateSampleTaskResponse, 201);
  });
}
