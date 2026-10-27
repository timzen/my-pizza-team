/**
 * tests/triage-ui.test.ts — The web UI's triage wording and rules
 * (ui/src/lib/triage.ts): what a badge means, what a proposal reads as, which
 * fields the Edit-before-accept form shows, when **Triage now** is unavailable,
 * and how the thread groups into rounds. Also the Inbox's routing for a triage
 * run (ui/src/lib/work-item-link.ts), a note's or a triage-mode external item's.
 */

import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import {
  analysesWithDecisions,
  badgeTitle,
  editableFields,
  kindLabel,
  mirrorTriageNowBlocked,
  mirrorTriagePath,
  outcomeLabel,
  triageNowBlocked,
  triagePath,
  type TriageThreadEntry,
} from "../ui/src/lib/triage.ts";
import { hasThreadTab, isTriageRun, workItemPath } from "../ui/src/lib/work-item-link.ts";
import { isTriageMode } from "../ui/src/lib/external-sources.ts";

test("badge tooltips say what to expect, since the icon is the label", () => {
  assertEquals(badgeTitle("proposal").includes("accept, edit, or reject"), true);
  assertEquals(badgeTitle("question").includes("editing the note"), true);
  assertEquals(badgeTitle("nothing").includes("nothing to create"), true);
  assertEquals(badgeTitle("none"), "");
});

test("outcome and kind labels", () => {
  assertEquals(outcomeLabel("proposals"), "Proposed work");
  assertEquals(outcomeLabel("question"), "Question for you");
  assertEquals(outcomeLabel("nothing"), "Nothing to create");
  assertEquals(outcomeLabel(null), "No analysis yet");
  assertEquals(kindLabel("task"), "Standalone task");
  assertEquals(kindLabel("story-task", "payments"), "Task in story payments");
  assertEquals(kindLabel("story"), "New story");
  assertEquals(kindLabel("schedule"), "Scheduled job");
});

test("the Edit form shows the fields that kind actually has", () => {
  assertEquals(editableFields("task"), ["title", "goal", "acceptanceCriteria", "directory"]);
  assertEquals(editableFields("story-task"), ["title", "goal", "acceptanceCriteria", "directory"]);
  // A schedule owns its cron; a story's goal lives in its tasks.
  assertEquals(editableFields("schedule").includes("cron"), true);
  assertEquals(editableFields("story"), ["title", "directory"]);
});

test("Triage now is blocked only by things it can't override", () => {
  // The button exists to override these two.
  assertEquals(triageNowBlocked("unchanged"), null);
  assertEquals(triageNowBlocked("too-fresh"), null);
  assertEquals(triageNowBlocked(null), null);
  assertEquals(triageNowBlocked("in-flight")?.includes("already queued"), true);
  assertEquals(triageNowBlocked("archived")?.includes("Archived"), true);
  assertEquals(triageNowBlocked("empty")?.includes("nothing to triage"), true);
});

const analysis = (at: string, ids: string[], outcome: "proposals" | "question" = "proposals"): TriageThreadEntry => ({
  from: "swift-neo", body: "…", at, outcome,
  ...(outcome === "proposals" ? { proposals: ids.map((id) => ({ id, kind: "task" as const, title: `T ${id}`, goal: "g" })) } : {}),
});
const decision = (proposalId: string, action: "accepted" | "rejected"): TriageThreadEntry =>
  ({ kind: "decision", proposalId, action, from: "you", at: "2026-09-29T12:00:00.000Z" });

test("the thread groups into rounds, each analysis with the decisions that answered it", () => {
  const rounds = analysesWithDecisions([
    { from: "someone", body: "an ordinary comment", at: "2026-09-29T09:00:00.000Z" }, // not a round
    analysis("2026-09-29T10:00:00.000Z", ["p1", "p2"]),
    decision("p1", "accepted"),
    analysis("2026-09-29T13:00:00.000Z", ["p3"], "question"),
    decision("p2", "rejected"),
  ]);
  assertEquals(rounds.length, 2);
  assertEquals(rounds[0]!.analysis.at, "2026-09-29T10:00:00.000Z");
  // Both decisions belong to round 1's proposals, even the one filed later.
  assertEquals(rounds[0]!.decisions.map((d) => d.proposalId), ["p1", "p2"]);
  assertEquals(rounds[1]!.analysis.outcome, "question");
  assertEquals(rounds[1]!.decisions, []);
});

test("a decision for an unknown proposal is ignored rather than crashing", () => {
  const rounds = analysesWithDecisions([decision("ghost", "accepted"), analysis("2026-09-29T10:00:00.000Z", ["p1"])]);
  assertEquals(rounds.length, 1);
  assertEquals(rounds[0]!.decisions, []);
});

test("triagePath encodes the note id", () => {
  assertEquals(triagePath("th-1"), "/thoughts/th-1/triage");
  assertEquals(triagePath("a/b"), "/thoughts/a%2Fb/triage");
});

test("the Inbox sends a triage run to its note's triage page, not the WorkDef", () => {
  const triage = { ref: { workDefId: "triage-th-1" }, parent: { kind: "thought" as const, id: "th-1" } };
  assertEquals(workItemPath(triage), "/thoughts/th-1/triage");
  // …and that page has no Details/Thread tabs to deep-link into.
  assertEquals(hasThreadTab(triage), false);

  // Everything else is unchanged.
  assertEquals(
    workItemPath({ ref: { workDefId: "s-1" }, parent: { kind: "story", id: "payments" } }),
    "/task/payments/s-1",
  );
  assertEquals(workItemPath({ ref: { workDefId: "wd-1" } }), "/work-defs/wd-1");
  assertEquals(hasThreadTab({ ref: { workDefId: "wd-1" } }), true);
});

test("an external item's badge tooltip says where to answer, since it can't be edited here", () => {
  assertEquals(badgeTitle("proposal", "item").includes("from this item"), true);
  assertEquals(badgeTitle("question", "item").includes("in its source"), true);
  assertEquals(badgeTitle("nothing", "item").includes("this item"), true);
  // The note wording is unchanged by default.
  assertEquals(badgeTitle("question"), badgeTitle("question", "note"));
});

test("Triage now on an external item is blocked only while a run is in flight or it's archived", () => {
  assertEquals(mirrorTriageNowBlocked(null, false), null);
  assertEquals(mirrorTriageNowBlocked("COMPLETE", false), null);
  assertEquals(mirrorTriageNowBlocked("FAILED", false), null);
  assertEquals(mirrorTriageNowBlocked("CANCELED", false), null);
  for (const s of ["READY", "IN_PROGRESS", "MORIBUND"]) {
    assertEquals(mirrorTriageNowBlocked(s, false)?.includes("already queued"), true);
  }
  assertEquals(mirrorTriageNowBlocked(null, true)?.includes("Archived"), true);
});

test("a triage-mode external item's triage view is its WorkDef page's Triage tab", () => {
  assertEquals(mirrorTriagePath("simt~T-1"), "/work-defs/simt~T-1?tab=triage");
  assertEquals(mirrorTriagePath("a/b"), "/work-defs/a%2Fb?tab=triage");
  assertEquals(isTriageMode({ mode: "triage" }), true);
  assertEquals(isTriageMode({ mode: "work" }), false);
  assertEquals(isTriageMode({}), false);
  assertEquals(isTriageMode(undefined), false);
});

test("the Inbox sends a triage-mode external item's run to its Triage tab", () => {
  const run = { ref: { workDefId: "simt~T-1" }, parent: { kind: "external" as const, id: "T-1", source: "simt" }, triage: true };
  assertEquals(workItemPath(run), "/work-defs/simt~T-1?tab=triage");
  assertEquals(hasThreadTab(run), false);
  assertEquals(isTriageRun(run), true);
  // A work-mode external item's run opens its Thread, as any WorkDef's does.
  const work = { ref: { workDefId: "simt~T-2" }, parent: { kind: "external" as const, id: "T-2", source: "simt" } };
  assertEquals(workItemPath(work), "/work-defs/simt~T-2");
  assertEquals(hasThreadTab(work), true);
  assertEquals(isTriageRun(work), false);
  assertEquals(isTriageRun({ ref: { workDefId: "triage-th-1" }, parent: { kind: "thought" as const, id: "th-1" } }), true);
});
