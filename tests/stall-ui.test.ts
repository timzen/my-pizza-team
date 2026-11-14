/**
 * tests/stall-ui.test.ts — How the web UI shows a stalled teammate
 * (docs/DESIGN.md "Stalled Teammates"; ui/src/lib/stall.ts, lib/team.ts
 * `statusText`, components/team/TeamParts, StallCallout, components/inbox/StallNotes).
 *
 * The wording is pure and checked directly: the row's status text ("Stalled
 * 13h — bash: node --test …" in place of "Working"), the teammate page's
 * callout, and what Interrupt says (unsupported → Pair; sent; failed). The
 * fast suite has no DOM, so the rendering is source checks: the row's status
 * icon becomes an amber ⚠ and the row gets no new controls; the teammate page
 * shows the callout, read-only on the phone; the Inbox (desktop and phone)
 * shows the stall notes, linking the teammate and the work item.
 */

import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { INTERRUPT_UNSUPPORTED_TEXT, interruptState, stallActivityText, stallCallout, stallStatusText } from "../ui/src/lib/stall.ts";
import { statusText, teammateSummary, type Teammate } from "../ui/src/lib/team.ts";
import type { AgentStall, InterruptView } from "../shared/protocol.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-14T03:12:00Z");
const NOW = T0 + 13 * 60 * MIN;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const STALL: AgentStall = { since: T0, stallMinutes: 30, workItemId: "wi-1", activity: { state: "tool", tool: "bash", since: T0, preview: "node --test …" } };
const src = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../ui/src", rel), "utf8");

const agent = (over: Partial<Teammate> = {}): Teammate => ({
  id: "m1", name: "bright-muad-dib", directory: "/tmp", status: "working", currentWork: null, lastHeartbeat: null,
  ...over,
} as Teammate);

test("the row's status text: stalled for how long, on what — else the plain status", () => {
  assertEquals(stallStatusText(STALL, NOW), "Stalled 13h — bash: node --test …");
  assertEquals(statusText(agent({ stalled: STALL }), NOW), "Stalled 13h — bash: node --test …");
  assertEquals(statusText(agent()), "Working", "not stalled");
  assertEquals(statusText(agent({ stalled: null })), "Working");
  assert(teammateSummary(agent({ stalled: STALL })).startsWith("bright-muad-dib · Stalled "), "the summary (the row's link name) says it too");
  assertEquals(stallActivityText({ state: "tool", tool: "bash", since: T0 }), "bash");
  assertEquals(stallActivityText({ state: "model", since: T0 }), "waiting on the model");
  assertEquals(stallActivityText(null), "no activity reported");
});

test("the teammate page's callout: duration, the tool and its preview, since when, last progress", () => {
  assertEquals(stallCallout(STALL, NOW, hhmm), {
    title: "Stalled for 13h",
    running: "bash `node --test …`",
    runningSince: "since 03:12",
    lastProgress: "No progress since 03:12 (stall threshold 30m).",
  });
  const old = stallCallout({ ...STALL, activity: null }, T0 + 40 * MIN, hhmm);
  assertEquals([old.running, old.runningSince], [null, null], "an older harness reports no activity");
});

test("Interrupt's state: unsupported points to Pair; a pending or done ask is sent; a failed one says why", () => {
  const ask = (status: InterruptView["status"], at = T0 + MIN, error: string | null = null): InterruptView =>
    ({ id: "d1", status, error, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() });
  assertEquals(interruptState({ interruptSupported: false }, STALL), { kind: "unsupported", text: INTERRUPT_UNSUPPORTED_TEXT });
  assertStringIncludes(INTERRUPT_UNSUPPORTED_TEXT, "Pair");
  assertEquals(interruptState({ interruptSupported: true, lastInterrupt: null }, STALL).kind, "ready");
  assertEquals(interruptState({ interruptSupported: true, lastInterrupt: ask("pending") }, STALL).kind, "sent");
  assertEquals(interruptState({ interruptSupported: true, lastInterrupt: ask("done") }, STALL).kind, "sent");
  const failed = interruptState({ interruptSupported: true, lastInterrupt: ask("failed", T0 + MIN, "no run in flight to interrupt") }, STALL);
  assertEquals(failed, { kind: "failed", text: "Interrupt failed: no run in flight to interrupt." });
  // An ask from before this stall began speaks for an earlier one.
  assertEquals(interruptState({ interruptSupported: true, lastInterrupt: ask("failed", T0 - MIN, "x") }, STALL).kind, "ready");
});

test("Team tab row: a stalled teammate's status icon is an amber ⚠, and the row gets no new controls", () => {
  const parts = src("components/team/TeamParts.tsx");
  const icon = parts.slice(parts.indexOf("export function StatusIcon("), parts.indexOf("export function ModelName("));
  assert(icon.includes("if (teammate.stalled) return <AlertTriangle {...common} className={cn(className, STALLED_ICON)} />;"), "the ⚠ replaces the working loader");
  assert(icon.includes("const label = statusText(teammate);"), "named by the stall text");
  assert(/const STALLED_ICON = "text-amber-600 dark:text-amber-400";/.test(parts), "amber");
  const row = parts.slice(parts.indexOf("export function TeammateRow("));
  assert(row.includes("<Tooltip content={statusText(teammate)} describe={false}>"), "the status tooltip says it");
  assertEquals((row.match(/<button /g) ?? []).length, 2, "still only reset and dismiss");
  assert(!/interrupt/i.test(row), "no Interrupt on the row");
});

test("teammate page: the stall callout under the header, with Interrupt — read-only on the phone", () => {
  const page = src("pages/TeammatePage.tsx");
  assert(page.includes("<StallCallout agent={agent} readOnly={phone} onChanged={refetchAgents} />"), "the callout");
  const callout = src("components/team/StallCallout.tsx");
  assert(callout.includes("if (!stall) return null;"), "nothing when not stalled");
  assert(callout.includes("`/api/agents/${encodeURIComponent(agent.id)}/interrupt`"), "Interrupt posts the route");
  assert(callout.includes("{!readOnly && state.kind !== \"unsupported\" && ("), "no button on the phone or for an older harness");
  assert(callout.includes("Pair"), "points to Pair");
  assert(callout.includes("confirm({"), "asks first");
});

test("Inbox: the stall notes on the desktop and the phone, linking the teammate and the work item", () => {
  assert(src("pages/InboxPage.tsx").includes("<StallNotes unreadOnly={unreadOnly} onChanged={notifyInboxChanged} />"));
  assert(src("mobile/MobileInbox.tsx").includes("<StallNotes unreadOnly={unreadOnly} onChanged={onChanged} teammatePath={(id) => `${MOBILE_ROOT}/teammates/${encodeURIComponent(id)}`} />"));
  const notes = src("components/inbox/StallNotes.tsx");
  assert(notes.includes("<Link to={teammatePath(note.memberId)}"), "the teammate");
  assert(notes.includes("workItemPath({ ref: { workDefId: note.workDefId }, parent: note.parent })"), "the work item");
  assert(notes.includes("`/api/stalls/notes/${encodeURIComponent(note.id)}/read?read=${read}`"), "mark read");
});

test("phone Team tab: the rows are the desktop's, so the stalled marker shows there, read-only", () => {
  const team = src("mobile/MobileTeam.tsx");
  assert(team.includes("<TeammateRow key={t.id} teammate={t} href={teammatePath(t.id)} skewReason={skewReasonFor(t.id)} />"), "no onReset/onDismiss: no actions");
});
