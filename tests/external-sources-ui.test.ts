/**
 * tests/external-sources-ui.test.ts — The UI's generic view of external
 * (pull-only) Work Sources: one read-only Work tab per registered source
 * (ui/src/lib/work-items.ts) and the mirrored-def helpers behind its list and
 * the read-only detail page (ui/src/lib/external-sources.ts).
 * See docs/DESIGN.md "Work Sources: WorkDef Kinds as Plugins".
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import {
  defaultWorkItemsPath,
  externalSourceIdFromPath,
  externalSourcePath,
  hasAnyWorkItemsFeature,
  isExternalSourceOn,
  visibleWorkItemsTabs,
  workItemsTabLinks,
} from "../ui/src/lib/work-items.ts";
import {
  latestStateLabel,
  latestStateTone,
  mirroredDefHomePath,
  openInLabel,
  readOnlyHint,
  shortRevision,
} from "../ui/src/lib/external-sources.ts";
import { sectionForWorkDefType } from "../ui/src/lib/nav-section.ts";

const ALL_ON = { stories: true, tasks: true, schedules: true };
const ALL_OFF = { stories: false, tasks: false, schedules: false };
const JIRA = { id: "jira", label: "Jira" };
const FIXTURE = { id: "fixture", label: "Fixture" };

test("workItemsTabLinks: with no external source, exactly the kind and lifecycle tabs", () => {
  for (const sources of [null, []]) {
    assertEquals(workItemsTabLinks(ALL_ON, sources).map((t) => t.path), visibleWorkItemsTabs(ALL_ON).map((t) => t.path));
  }
  assertEquals(workItemsTabLinks(null, [JIRA]), [], "nothing until the toggles load");
});

test("workItemsTabLinks: one tab per external source, after the kinds and before Pending/Archived", () => {
  const links = workItemsTabLinks(ALL_ON, [JIRA, FIXTURE]);
  assertEquals(links.map((t) => t.label), ["Board", "Tasks", "Schedule", "Jira", "Fixture", "Pending", "Archived"]);
  const jira = links.find((t) => t.key === "source:jira")!;
  assertEquals(jira.path, "/work/source/jira");
  assertEquals(jira.isActive("/work/source/jira"), true);
  assertEquals(jira.isActive("/work/source/fixture"), false);
  assertEquals(links.find((t) => t.key === "board")!.isActive("/work/source/jira"), false);
});

test("external tabs keep Work reachable when every kind is off", () => {
  assertEquals(hasAnyWorkItemsFeature(ALL_OFF), false);
  assertEquals(hasAnyWorkItemsFeature(ALL_OFF, [JIRA]), true);
  assertEquals(workItemsTabLinks(ALL_OFF, [JIRA]).map((t) => t.label), ["Jira"]);
  assertEquals(defaultWorkItemsPath(ALL_OFF, [JIRA]), "/work/source/jira");
  assertEquals(defaultWorkItemsPath(ALL_ON, [JIRA]), "/work/board", "a kind tab still comes first");
});

test("externalSourcePath / externalSourceIdFromPath round-trip, and reject other routes", () => {
  assertEquals(externalSourceIdFromPath(externalSourcePath("my-src")), "my-src");
  assertEquals(externalSourceIdFromPath("/work/board"), null);
  assertEquals(externalSourceIdFromPath("/work/source"), null);
  assertEquals(externalSourceIdFromPath("/work/source/a/b"), null);
});

test("mirrored-def list helpers: latest state, revision, and the external link", () => {
  assertEquals(latestStateLabel(null), "Never run");
  assertEquals(latestStateLabel("IN_PROGRESS"), "In progress");
  assertEquals(latestStateLabel("COMPLETE"), "Complete");
  assertEquals(latestStateTone("READY"), "active");
  assertEquals(latestStateTone("FAILED"), "bad");
  assertEquals(latestStateTone("CANCELED"), "neutral");
  assertEquals(shortRevision(undefined), "—");
  assertEquals(shortRevision("2024-05-01T10:00"), "2024-05-01T10:00");
  assertEquals(shortRevision("a".repeat(64)), "aaaaaaaa");
  assertEquals(openInLabel("Jira"), "Open in Jira");
});

test("a mirrored def's page: read-only hint, Back to its source's tab, Work highlighted", () => {
  assertEquals(mirroredDefHomePath({ sourceId: "jira" }), "/work/source/jira");
  const hint = readOnlyHint("Jira");
  assertEquals(hint.includes("pull only") && hint.includes("edit it there"), true);
  assertEquals(sectionForWorkDefType("External"), "work-items");
});

test("workItemsTabLinks: a switched-off external source's tab hides; one without a toggle always shows", () => {
  const jira = { id: "jira", label: "Jira", feature: "jira" };
  const alwaysOn = { id: "fixture", label: "Fixture" };
  const labels = (features: Record<string, boolean>) => workItemsTabLinks({ ...ALL_ON, ...features }, [jira, alwaysOn]).map((t) => t.label);
  assertEquals(labels({ jira: true }), ["Board", "Tasks", "Schedule", "Jira", "Fixture", "Pending", "Archived"]);
  assertEquals(labels({ jira: false }), ["Board", "Tasks", "Schedule", "Fixture", "Pending", "Archived"]);
  // A flag the UI hasn't heard of yet means on, like the daemon.
  assertEquals(labels({}).includes("Jira"), true);
  assertEquals(isExternalSourceOn(jira, null), false, "nothing until the toggles load");
  assertEquals(hasAnyWorkItemsFeature({ ...ALL_OFF, jira: false }, [jira]), false);
});
