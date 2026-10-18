/**
 * tests/work-items-ui.test.ts — The Work surface's rules
 * (ui/src/lib/work-items.ts): which sub-tabs the feature toggles show, where
 * `/work` lands, route → tab, the legacy-URL redirects, and the
 * "active only" rule for scheduled jobs.
 */

import { assertEquals } from "@std/assert";
import {
  WORK_ITEMS_TABS,
  defaultWorkItemsPath,
  hasAnyWorkItemsFeature,
  isActiveScheduledJob,
  legacyWorkItemsPath,
  visibleWorkItemsTabs,
  workItemsTabFromPath,
} from "../ui/src/lib/work-items.ts";

const ALL_ON = { stories: true, tasks: true, schedules: true };
const ALL_OFF = { stories: false, tasks: false, schedules: false };
const tabs = (f: typeof ALL_ON | null) => visibleWorkItemsTabs(f).map((t) => t.tab);

Deno.test("WORK_ITEMS_TABS: Board · Tasks · Schedule · Pending · Archived under /work", () => {
  assertEquals(WORK_ITEMS_TABS.map((t) => t.label), ["Board", "Tasks", "Schedule", "Pending", "Archived"]);
  for (const t of WORK_ITEMS_TABS) assertEquals(t.path, `/work/${t.tab}`);
});

Deno.test("visibleWorkItemsTabs: each kind's tab follows its toggle; Pending/Archived stay while any is on", () => {
  assertEquals(tabs(ALL_ON), ["board", "tasks", "schedule", "pending", "archived"]);
  assertEquals(tabs({ stories: false, tasks: true, schedules: false }), ["tasks", "pending", "archived"]);
  assertEquals(tabs({ stories: true, tasks: false, schedules: true }), ["board", "schedule", "pending", "archived"]);
  assertEquals(tabs(ALL_OFF), []);
  // Not loaded yet: nothing, so a switched-off kind never flashes in.
  assertEquals(tabs(null), []);
});

Deno.test("hasAnyWorkItemsFeature: the nav item hides only when all three kinds are off", () => {
  assertEquals(hasAnyWorkItemsFeature(ALL_ON), true);
  assertEquals(hasAnyWorkItemsFeature({ stories: false, tasks: false, schedules: true }), true);
  assertEquals(hasAnyWorkItemsFeature(ALL_OFF), false);
  assertEquals(hasAnyWorkItemsFeature(null), false);
});

Deno.test("defaultWorkItemsPath: /work lands on the first enabled tab", () => {
  assertEquals(defaultWorkItemsPath(ALL_ON), "/work/board");
  assertEquals(defaultWorkItemsPath({ stories: false, tasks: true, schedules: true }), "/work/tasks");
  assertEquals(defaultWorkItemsPath({ stories: false, tasks: false, schedules: true }), "/work/schedule");
  assertEquals(defaultWorkItemsPath(ALL_OFF), null);
  assertEquals(defaultWorkItemsPath(null), null);
});

Deno.test("workItemsTabFromPath: only /work/<known tab>", () => {
  assertEquals(workItemsTabFromPath("/work/board"), "board");
  assertEquals(workItemsTabFromPath("/work/archived"), "archived");
  assertEquals(workItemsTabFromPath("/work"), null);
  assertEquals(workItemsTabFromPath("/work/nope"), null);
  assertEquals(workItemsTabFromPath("/board"), null);
});

Deno.test("legacyWorkItemsPath: old list URLs move under /work; Templates go to Tasks", () => {
  assertEquals(legacyWorkItemsPath("/board"), "/work/board");
  assertEquals(legacyWorkItemsPath("/tasks"), "/work/tasks");
  assertEquals(legacyWorkItemsPath("/schedule"), "/work/schedule");
  assertEquals(legacyWorkItemsPath("/pending"), "/work/pending");
  assertEquals(legacyWorkItemsPath("/backlog"), "/work/pending");
  assertEquals(legacyWorkItemsPath("/archived"), "/work/archived");
  assertEquals(legacyWorkItemsPath("/templates"), "/work/tasks");
  assertEquals(legacyWorkItemsPath("/templates/atlas"), "/work/tasks");
  // The surface's old root redirects to /work, keeping the rest of the path.
  assertEquals(legacyWorkItemsPath("/work-items"), "/work");
  assertEquals(legacyWorkItemsPath("/work-items/board"), "/work/board");
  assertEquals(legacyWorkItemsPath("/work-items/source/jira"), "/work/source/jira");
  for (const p of ["/", "/story/s1", "/task/s1/t1", "/work/board", "/board/x", "/thoughts"]) {
    assertEquals(legacyWorkItemsPath(p), null, p);
  }
});

Deno.test("isActiveScheduledJob: active only when both definition and Schedule are", () => {
  assertEquals(isActiveScheduledJob({}, undefined), true);
  assertEquals(isActiveScheduledJob({}, { pending: false }), true);
  assertEquals(isActiveScheduledJob({ pending: true }, { pending: false }), false);
  assertEquals(isActiveScheduledJob({}, { pending: true }), false);
});
