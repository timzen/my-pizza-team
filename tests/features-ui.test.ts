/**
 * tests/features-ui.test.ts — The UI side of the feature toggles
 * (ui/src/lib/features.ts): defaults, which routes each toggle guards, the
 * nav/quick-create filtering, and that the hand-mirrored names and mappings
 * agree with the daemon's (shared/types.ts, daemon/features.ts).
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import {
  FEATURE_NAMES, featureForPath, featureForProposalKind, featureForWorkDefForm, filterByFeatures, resolveFeatures,
} from "../ui/src/lib/features.ts";
import { FEATURE_NAMES as SHARED_FEATURE_NAMES, resolveFeatures as sharedResolveFeatures } from "../shared/types.ts";
import { featureForProposalKind as daemonFeatureForProposalKind } from "../daemon/features.ts";

test("UI feature names and defaults mirror shared/types.ts", () => {
  assertEquals([...FEATURE_NAMES], [...SHARED_FEATURE_NAMES]);
  for (const raw of [undefined, {}, { stories: false }, { tasks: false, schedules: false }]) {
    assertEquals(resolveFeatures(raw), sharedResolveFeatures({ features: raw }));
  }
  // A daemon too old to report features: everything on.
  assertEquals(resolveFeatures(null), { stories: true, tasks: true, schedules: true });
});

test("featureForProposalKind matches the daemon's gate", () => {
  for (const kind of ["task", "story", "story-task", "schedule"] as const) {
    assertEquals(featureForProposalKind(kind), daemonFeatureForProposalKind(kind));
  }
});

test("featureForPath: each kind's pages, and ungated ones", () => {
  for (const p of ["/work/board", "/board", "/config/workflows", "/config/workflows/default", "/story/s1", "/stories/new", "/story/s1/tasks/new", "/task/s1/t1"]) {
    assertEquals(featureForPath(p), "stories", p);
  }
  for (const p of ["/work/tasks", "/tasks", "/templates", "/templates/atlas"]) assertEquals(featureForPath(p), "tasks", p);
  assertEquals(featureForPath("/work/schedule"), "schedules");
  assertEquals(featureForPath("/schedule"), "schedules");
  // Work's Pending and Archived tabs mix every kind, so they aren't gated on one.
  for (const p of ["/work", "/work/pending", "/work/archived", "/pending", "/backlog", "/archived"]) {
    assertEquals(featureForPath(p), null, p);
  }
  for (const p of ["/", "/queue", "/thoughts", "/thoughts/n1/triage", "/config", "/config/context", "/config/triage", "/config/theme", "/help", "/usage", "/work-defs/w1"]) {
    assertEquals(featureForPath(p), null, p);
  }
  // The new-WorkDef form's kind comes from ?type= (Template belongs to Tasks).
  assertEquals(featureForPath("/work-defs/new", "?type=Scheduled"), "schedules");
  assertEquals(featureForPath("/work-defs/new", "?type=Template"), "tasks");
  assertEquals(featureForPath("/work-defs/new"), "tasks");
  assertEquals(featureForWorkDefForm("?type=Solitary&template=x"), "tasks");
});

test("filterByFeatures: drops disabled kinds, keeps ungated items, hides gated ones until loaded", () => {
  const items = [
    { id: "thoughts" },
    { id: "board", feature: "stories" as const },
    { id: "tasks", feature: "tasks" as const },
    { id: "schedule", feature: "schedules" as const },
  ];
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
  assertEquals(ids(filterByFeatures(items, { stories: true, tasks: true, schedules: true })), ["thoughts", "board", "tasks", "schedule"]);
  assertEquals(ids(filterByFeatures(items, { stories: false, tasks: true, schedules: false })), ["thoughts", "tasks"]);
  assertEquals(ids(filterByFeatures(items, { stories: false, tasks: false, schedules: false })), ["thoughts"]);
  assertEquals(ids(filterByFeatures(items, null)), ["thoughts"]);
});
