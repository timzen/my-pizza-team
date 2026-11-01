/**
 * tests/config-draft.test.ts — The Config page's draft rules
 * (ui/src/lib/config-draft.ts): the PUT body drops read-only fields and only
 * carries `features` when a toggle changed, name nouns are normalized, and the
 * Default Harness picker lists built-ins then valid custom harnesses.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { BUILT_IN_HARNESSES, configBody, harnessOptions, normalizeNoun, type ConfigData } from "../ui/src/lib/config-draft.ts";

const base: ConfigData = {
  port: 9999,
  tmuxSession: "mpt",
  defaultWorkflow: "coding",
  workflows: { coding: { states: ["todo", "done"] } },
  autosave: { flushIntervalMinutes: 30, commitIntervalHours: 24, autoCommit: true },
};

test("configBody: drops featureUsage and featureSources", () => {
  const draft: ConfigData = {
    ...base,
    featureUsage: { stories: { count: 1, description: "1 story" } },
    featureSources: [],
  };
  const body = configBody(draft, draft);
  assertEquals("featureUsage" in body, false);
  assertEquals("featureSources" in body, false);
  assertEquals(body.port, 9999);
  assertEquals("featureUsage" in draft, true, "the draft itself is untouched");
});

test("configBody: features only when a toggle changed", () => {
  const saved: ConfigData = { ...base, features: { stories: true, tasks: true, schedules: true } };
  assertEquals("features" in configBody({ ...saved }, saved), false);
  const changed = { ...saved, features: { stories: false, tasks: true, schedules: true } };
  assertEquals(configBody(changed, saved).features, changed.features);
});

test("normalizeNoun: lower-case, dashes for other characters, edge dash trimmed", () => {
  assertEquals(normalizeNoun("  Pizza "), "pizza");
  assertEquals(normalizeNoun("Big Cheese"), "big-cheese");
  assertEquals(normalizeNoun("!calzone!"), "calzone");
  assertEquals(normalizeNoun("   "), "");
});

test("harnessOptions: built-ins, then custom harnesses with a teammate command", () => {
  assertEquals(harnessOptions(undefined), BUILT_IN_HARNESSES);
  assertEquals(
    harnessOptions({
      mine: { teammate: "my-agent" },
      kiro: { teammate: "override" },
      broken: { teammate: "" },
    }).map((o) => o.label),
    ["Pi", "Kiro (experimental)", "Claude Code (experimental)", "mine (custom)"],
  );
});
