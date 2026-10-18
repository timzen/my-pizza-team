/**
 * tests/lifecycle-list.test.ts — The mixed Pending / Archived lists of Work
 * Items (ui/src/lib/lifecycle-list.ts): which stories, tasks, and scheduled
 * jobs each lists, what a pending row's Activate targets, the kind chips and
 * their feature toggles, search, and the newest-first order.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import {
  archivedRows,
  countByKind,
  enabledKinds,
  filterRows,
  pendingRows,
  sortNewestFirst,
  toggleKind,
  type LifecycleRow,
} from "../ui/src/lib/lifecycle-list.ts";

const stories = [
  { id: "s-active", title: "Active story" },
  { id: "s-pend", title: "Pending story", directory: "/repo/a", pending: true },
];
const schedules = [
  { id: "sch-on", cron: "0 9 * * *", lastEnqueuedAt: "2026-01-02T09:00:00Z" },
  { id: "sch-off", cron: "0 * * * *", pending: true },
];
const defs = [
  { id: "t-active", title: "Active task", type: "Solitary" },
  { id: "t-pend", title: "Pending task", type: "Solitary", pending: true, directory: "/repo/b" },
  { id: "b-pend", title: "Pending board task", type: "Board", parent: { kind: "story", id: "s-active" }, pending: true },
  { id: "j-active", title: "Active job", type: "Scheduled", parent: { kind: "schedule", id: "sch-on" } },
  { id: "j-def", title: "Job, pending definition", type: "Scheduled", parent: { kind: "schedule", id: "sch-on" }, pending: true },
  { id: "j-sched", title: "Job, pending schedule", type: "Scheduled", parent: { kind: "schedule", id: "sch-off" }, lastRunAt: "2026-01-03T00:00:00Z" },
];

test("pendingRows: pending stories, Solitary tasks, and held-back jobs; not board tasks or active work", () => {
  const rows = pendingRows(stories, defs, schedules);
  assertEquals(rows.map((r) => `${r.kind}:${r.id}`), ["story:s-pend", "task:t-pend", "schedule:j-def", "schedule:j-sched"]);
  const story = rows[0]!;
  assertEquals(story.href, "/story/s-pend");
  assertEquals(story.directory, "/repo/a");
  assertEquals(rows[1]!.href, "/work-defs/t-pend");
});

test("pendingRows: Activate targets the story, the definition first, then the Schedule", () => {
  const byId = new Map(pendingRows(stories, defs, schedules).map((r) => [r.id, r]));
  assertEquals(byId.get("s-pend")!.activate, { kind: "story", id: "s-pend" });
  assertEquals(byId.get("t-pend")!.activate, { kind: "workDef", id: "t-pend" });
  assertEquals(byId.get("j-def")!.activate, { kind: "workDef", id: "j-def" });
  assertEquals(byId.get("j-sched")!.activate, { kind: "schedule", id: "sch-off" });
  assertEquals(byId.get("j-sched")!.cron, "0 * * * *");
});

test("pendingRows: timestamps are the latest activity — last run, else the Schedule's last fire", () => {
  const byId = new Map(pendingRows(stories, defs, schedules).map((r) => [r.id, r]));
  assertEquals([byId.get("j-sched")!.at, byId.get("j-sched")!.atLabel], ["2026-01-03T00:00:00Z", "Last run"]);
  assertEquals([byId.get("j-def")!.at, byId.get("j-def")!.atLabel], ["2026-01-02T09:00:00Z", "Last fired"]);
  assertEquals([byId.get("s-pend")!.at, byId.get("s-pend")!.atLabel], [null, null]);
});

test("archivedRows: archived stories (synopsis, no detail page) and Solitary/Scheduled WorkDefs", () => {
  const rows = archivedRows(
    [{ id: "old", title: "Old story", archivedAt: "2026-02-01T00:00:00Z", synopsis: "done" }],
    [
      { id: "t", title: "Old task", type: "Solitary" },
      { id: "j", title: "Old job", type: "Scheduled", parent: { kind: "schedule", id: "sch-on" } },
      { id: "b", title: "Board task", type: "Board", parent: { kind: "story", id: "old" } },
      { id: "tr", title: "Triage", type: "Triage", parent: { kind: "thought", id: "n" } },
    ],
    schedules,
  );
  assertEquals(rows.map((r) => `${r.kind}:${r.id}`), ["story:old", "task:t", "schedule:j"]);
  assertEquals(rows[0]!.href, null);
  assertEquals(rows[0]!.synopsis, "done");
  assertEquals([rows[0]!.at, rows[0]!.atLabel], ["2026-02-01T00:00:00Z", "Archived"]);
  assertEquals(rows[2]!.cron, "0 9 * * *");
  assertEquals(rows[1]!.activate, undefined);
});

test("enabledKinds: a switched-off kind's chip is hidden; nothing until the toggles load", () => {
  assertEquals(enabledKinds(null), []);
  assertEquals(enabledKinds({ stories: true, tasks: true, schedules: true }), ["story", "task", "schedule"]);
  assertEquals(enabledKinds({ stories: false, tasks: true, schedules: false }), ["task"]);
});

test("toggleKind: multi-select on/off", () => {
  assertEquals(toggleKind(["story", "task", "schedule"], "task"), ["story", "schedule"]);
  assertEquals(toggleKind(["story"], "task"), ["story", "task"]);
});

const row = (kind: LifecycleRow["kind"], id: string, title: string, at: string | null = null, directory?: string): LifecycleRow =>
  ({ kind, id, title, at, atLabel: at ? "Archived" : null, href: null, directory });

test("filterRows: keeps selected kinds and matches title, id, or directory case-insensitively", () => {
  const rows = [row("story", "s1", "Fix Login"), row("task", "t1", "Audit deps", null, "/repo/api"), row("schedule", "j1", "Nightly")];
  assertEquals(filterRows(rows, ["story", "task"]).map((r) => r.id), ["s1", "t1"]);
  assertEquals(filterRows(rows, ["story", "task", "schedule"], "login").map((r) => r.id), ["s1"]);
  assertEquals(filterRows(rows, ["story", "task", "schedule"], " REPO/API ").map((r) => r.id), ["t1"]);
  assertEquals(filterRows(rows, ["story", "task", "schedule"], "j1").map((r) => r.id), ["j1"]);
  assertEquals(filterRows(rows, []).length, 0);
});

test("sortNewestFirst: dated rows newest first, then undated by title", () => {
  const rows = [
    row("task", "a", "Zeta"),
    row("story", "b", "Old", "2026-01-01T00:00:00Z"),
    row("schedule", "c", "Alpha"),
    row("task", "d", "New", "2026-03-01T00:00:00Z"),
  ];
  assertEquals(sortNewestFirst(rows).map((r) => r.id), ["d", "b", "c", "a"]);
  assertEquals(rows[0]!.id, "a", "input not mutated");
});

test("countByKind: counts per kind", () => {
  assertEquals(countByKind([row("story", "a", "A"), row("task", "b", "B"), row("task", "c", "C")]), { story: 1, task: 2, schedule: 0 });
});
