/**
 * tests/config-draft.test.ts — The Config page's draft rules
 * (ui/src/lib/config-draft.ts): the PUT body drops read-only fields and only
 * carries `features` when a toggle changed, name nouns are normalized, and the
 * Default Harness picker lists built-ins then valid custom harnesses, and the
 * Persona Models editor's rows and edits.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import {
  BUILT_IN_HARNESSES, configBody, harnessOptions, isValidModelAlias, modelAliasRows, normalizeNoun, setModelAlias,
  terminalSwitchWarning, type ConfigData,
} from "../ui/src/lib/config-draft.ts";

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

test("configBody: drops the read-only agentsOnOtherTerminal, keeps terminal", () => {
  const draft: ConfigData = { ...base, terminal: "herdr", agentsOnOtherTerminal: [{ name: "neo", terminal: "tmux" }] };
  const body = configBody(draft, draft);
  assertEquals("agentsOnOtherTerminal" in body, false);
  assertEquals(body.terminal, "herdr");
});

test("terminalSwitchWarning: on a change, and while agents run under another terminal", () => {
  assertEquals(terminalSwitchWarning(base, base), null);
  // Unset and "tmux" are the same setting.
  assertEquals(terminalSwitchWarning({ ...base, terminal: null }, base), null);
  assertEquals(
    terminalSwitchWarning({ ...base, terminal: "herdr" }, base),
    "Applies to new windows only: agents already running stay in tmux.",
  );
  const saved: ConfigData = { ...base, terminal: "herdr", agentsOnOtherTerminal: [{ name: "neo", terminal: "tmux" }] };
  assertEquals(
    terminalSwitchWarning(saved, saved),
    "1 agent is still running under another terminal: neo (tmux). New windows open in herdr.",
  );
});

test("persona models: rows are sorted, edits add/replace/remove, and nothing left clears the block", () => {
  const aliases = { pi: { strong: "acme/s", fast: "acme/f" }, kiro: { strong: "k" } };
  assertEquals(modelAliasRows(aliases).map((r) => `${r.harness}:${r.alias}=${r.modelId}`), ["kiro:strong=k", "pi:fast=acme/f", "pi:strong=acme/s"]);
  assertEquals(modelAliasRows(undefined), []);
  assertEquals(setModelAlias(aliases, "pi", "strong", "acme/s2")?.pi, { strong: "acme/s2", fast: "acme/f" });
  assertEquals(setModelAlias(undefined, "pi", "strong", "acme/s"), { pi: { strong: "acme/s" } });
  assertEquals(setModelAlias(aliases, "kiro", "strong", null), { pi: { strong: "acme/s", fast: "acme/f" } }, "an emptied harness is dropped");
  assertEquals(setModelAlias({ pi: { strong: "x" } }, "pi", "strong", null), null, "null clears the block on save");
  assertEquals(aliases.kiro, { strong: "k" }, "the draft itself is untouched");
  assertEquals([isValidModelAlias("strong"), isValidModelAlias("v1.2_x-y"), isValidModelAlias("two words"), isValidModelAlias("-x")], [true, true, false, false]);
});
