/**
 * tests/config-tabs.test.ts — The Config page's tabs (ui/src/lib/config-tabs.ts):
 * route → tab mapping (incl. a workflow's detail keeping Workflows lit), which
 * tabs show for the feature toggles, which show the global Save button, and the
 * redirects from the old `/context` and `/workflows` pages.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import {
  CONFIG_TABS, configTabFromPath, legacyConfigPath, tabSavesConfig, visibleConfigTabs, workflowPath,
} from "../ui/src/lib/config-tabs.ts";

test("CONFIG_TABS: order and deep-linkable routes", () => {
  assertEquals(CONFIG_TABS.map((t) => t.label), ["General", "Teammates", "Workflows", "Context", "Triage", "Theme"]);
  assertEquals(CONFIG_TABS.map((t) => t.path), [
    "/config", "/config/teammates", "/config/workflows", "/config/context", "/config/triage", "/config/theme",
  ]);
});

test("configTabFromPath: each tab's route, detail routes, and unknown → general", () => {
  for (const t of CONFIG_TABS) assertEquals(configTabFromPath(t.path), t.tab, t.path);
  assertEquals(configTabFromPath("/config/"), "general");
  assertEquals(configTabFromPath("/config/workflows/coding"), "workflows");
  assertEquals(configTabFromPath("/config/nope"), "general");
  assertEquals(configTabFromPath("/config/general"), "general");
});

test("visibleConfigTabs: Workflows hidden while Stories are off (and until toggles load)", () => {
  const tabs = (f: Parameters<typeof visibleConfigTabs>[0]) => visibleConfigTabs(f).map((t) => t.tab);
  assertEquals(tabs({ stories: true, tasks: true, schedules: true }), ["general", "teammates", "workflows", "context", "triage", "theme"]);
  assertEquals(tabs({ stories: false, tasks: true, schedules: true }), ["general", "teammates", "context", "triage", "theme"]);
  assertEquals(tabs(null), ["general", "teammates", "context", "triage", "theme"]);
});

test("tabSavesConfig: only the config.json tabs show the global Save", () => {
  const saving = CONFIG_TABS.filter((t) => tabSavesConfig(t.tab)).map((t) => t.tab);
  assertEquals(saving, ["general", "teammates", "triage"]);
});

test("workflowPath: encodes the name", () => {
  assertEquals(workflowPath("coding"), "/config/workflows/coding");
  assertEquals(workflowPath("a b"), "/config/workflows/a%20b");
});

test("legacyConfigPath: old Context/Workflows URLs, nothing else", () => {
  assertEquals(legacyConfigPath("/context"), "/config/context");
  assertEquals(legacyConfigPath("/context/"), "/config/context");
  assertEquals(legacyConfigPath("/workflows"), "/config/workflows");
  assertEquals(legacyConfigPath("/workflows/coding"), "/config/workflows/coding");
  assertEquals(legacyConfigPath("/workflows/a%20b"), "/config/workflows/a%20b");
  for (const p of ["/", "/config", "/config/context", "/board", "/workflows/a/b", "/context/x"]) {
    assertEquals(legacyConfigPath(p), null, p);
  }
});
