/**
 * tests/triage-ui.test.ts — The web UI's triage wording and rules
 * (ui/src/lib/triage.ts): what a badge means, what a proposal reads as, which
 * fields the Edit-before-accept form shows, when **Triage now** is unavailable,
 * and how the thread groups into rounds. Also the Inbox's routing for a triage
 * run (ui/src/lib/work-item-link.ts).
 */

import { assertEquals } from "@std/assert";
import {
  analysesWithDecisions,
  badgeTitle,
  editableFields,
  kindLabel,
  outcomeLabel,
  triageNowBlocked,
  triagePath,
  type TriageThreadEntry,
} from "../ui/src/lib/triage.ts";
import { hasThreadTab, workItemPath } from "../ui/src/lib/work-item-link.ts";

Deno.test("badge tooltips say what to expect, since the icon is the label", () => {
  assertEquals(badgeTitle("proposal").includes("accept, edit, or reject"), true);
  assertEquals(badgeTitle("question").includes("editing the note"), true);
  assertEquals(badgeTitle("nothing").includes("nothing to create"), true);
  assertEquals(badgeTitle("none"), "");
});

Deno.test("outcome and kind labels", () => {
  assertEquals(outcomeLabel("proposals"), "Proposed work");
  assertEquals(outcomeLabel("question"), "Question for you");
  assertEquals(outcomeLabel("nothing"), "Nothing to create");
  assertEquals(outcomeLabel(null), "No analysis yet");
  assertEquals(kindLabel("task"), "Standalone task");
  assertEquals(kindLabel("story-task", "payments"), "Task in story payments");
  assertEquals(kindLabel("story"), "New story");
  assertEquals(kindLabel("schedule"), "Scheduled job");
});

Deno.test("the Edit form shows the fields that kind actually has", () => {
  assertEquals(editableFields("task"), ["title", "goal", "acceptanceCriteria", "directory"]);
  assertEquals(editableFields("story-task"), ["title", "goal", "acceptanceCriteria", "directory"]);
  // A schedule owns its cron; a story's goal lives in its tasks.
  assertEquals(editableFields("schedule").includes("cron"), true);
  assertEquals(editableFields("story"), ["title", "directory"]);
});

Deno.test("Triage now is blocked only by things it can't override", () => {
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

Deno.test("the thread groups into rounds, each analysis with the decisions that answered it", () => {
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

Deno.test("a decision for an unknown proposal is ignored rather than crashing", () => {
  const rounds = analysesWithDecisions([decision("ghost", "accepted"), analysis("2026-09-29T10:00:00.000Z", ["p1"])]);
  assertEquals(rounds.length, 1);
  assertEquals(rounds[0]!.decisions, []);
});

Deno.test("triagePath encodes the note id", () => {
  assertEquals(triagePath("th-1"), "/thoughts/th-1/triage");
  assertEquals(triagePath("a/b"), "/thoughts/a%2Fb/triage");
});

Deno.test("the Inbox sends a triage run to its note's triage page, not the WorkDef", () => {
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
