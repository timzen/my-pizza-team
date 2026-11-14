/**
 * tests/stall-notify.test.ts — What a stalled teammate tells the people
 * watching, and the Interrupt it lets them send (docs/DESIGN.md "Stalled
 * Teammates"; daemon/stall-notes.ts, Store.checkStalls, daemon/routes/stalls.ts,
 * MemberStore.requestInterrupt).
 *
 * On a fake clock (`store.clock`): one Inbox note and one `[stalled]` thread
 * comment per stall episode however many checks see it; the note ends when
 * progress resumes (read state kept) and a later stall is a new episode; an
 * ended note seen stalled again is reopened quietly; unread notes count in the
 * Inbox badge, and the notes routes list and mark them. The interrupt
 * directive's lifecycle: 404 / 409 unsupported / 201, a pending one returned not
 * doubled, handed only to an agent that declared `interrupt`, and its outcome
 * on `GET /api/agents` (`lastInterrupt`, `interruptSupported`).
 */

import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { makeTeam, get, post, put, type Team } from "./_team.ts";
import { INTERRUPT_ACTION, INTERRUPT_CAPABILITY, type AgentActivityReport, type AgentListResponse, type StallNotesResponse, type StatusResponse } from "../shared/protocol.ts";
import type { WorkItem } from "../shared/types.ts";
import { stallComment, stallNoteId } from "../daemon/stall-notes.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A team on a fake clock (a little ahead of real time: the claim stamps real time), with Pi teammate m1. */
function team(capabilities: string[] = [INTERRUPT_CAPABILITY]): Team & { clock: { now: number } } {
  const t = makeTeam();
  const clock = { now: Date.now() + 5_000 };
  t.store.clock = () => clock.now;
  t.store.registerMember("m1", "bright-muad-dib", "/tmp", {}, { harness: "pi", capabilities });
  return Object.assign(t, { clock });
}

/** A Solitary task's item, claimed by m1, which is working on it. */
function claimed(t: Team): WorkItem {
  const def = t.store.createWorkDef({ title: "model-switch-failover-4", goal: "g", acceptanceCriteria: "a" });
  const item = t.store.getActiveWorkItem(def.id)!;
  assert(t.store.claimWorkItem(item.id, "m1"), "claimed");
  t.store.heartbeat("m1", "working");
  return item;
}

const PREVIEW = "node --test tests/persona-model.test.mjs | grep fail";
const bash = (since: number): AgentActivityReport => ({ activity: { state: "tool", tool: "bash", since, preview: PREVIEW }, lastProgressAt: since });
const stalledComments = (t: Team, item: WorkItem) => t.store.getCommentsForRef(item.ref).map((c) => c.body).filter((b) => b.startsWith("[stalled]"));

test("one note and one thread comment per stall episode, however many checks see it", () => {
  const t = team();
  try {
    const item = claimed(t);
    const start = t.clock.now;
    t.store.heartbeat("m1", "working", bash(start));
    t.clock.now = start + 20 * MIN;
    assertEquals(t.store.checkStalls(), [], "not stalled yet");
    t.clock.now = start + 31 * MIN;
    const opened = t.store.checkStalls();
    assertEquals(opened.length, 1);
    const note = opened[0]!;
    assertEquals(note.id, stallNoteId("m1", start));
    assertEquals(note.memberName, "bright-muad-dib");
    assertEquals(note.workItemId, item.id);
    assertEquals(note.workItemTitle, "model-switch-failover-4");
    assertEquals(note.workDefId, item.ref.workDefId);
    assertEquals(note.activity?.preview, PREVIEW);
    assertEquals([note.read, note.ended], [false, false]);
    assertEquals(stalledComments(t, item), [`[stalled] no progress for 31m: bash \`${PREVIEW}\``]);
    // Thirteen hours of checks later: still the one note, the one comment.
    for (let h = 1; h <= 13; h++) { t.clock.now = start + h * HOUR; t.store.checkStalls(); }
    assertEquals(t.store.stallNotes.list().length, 1);
    assertEquals(stalledComments(t, item).length, 1);
    assertEquals(t.store.getCommentsForRef(item.ref).find((c) => c.body.startsWith("[stalled]"))?.from, "daemon");
  } finally { t.cleanup(); }
});

test("the note ends when progress resumes (read state kept); a later stall is a new episode", () => {
  const t = team();
  try {
    const item = claimed(t);
    const start = t.clock.now;
    t.store.heartbeat("m1", "working", bash(start));
    t.clock.now = start + HOUR;
    const [first] = t.store.checkStalls();
    assert(t.store.stallNotes.markRead(first!.id), "marked read");
    // The tool returned: progress.
    t.store.heartbeat("m1", "working", { activity: { state: "model", since: t.clock.now }, lastProgressAt: t.clock.now });
    t.store.checkStalls();
    const ended = t.store.stallNotes.list().find((n) => n.id === first!.id)!;
    assertEquals([ended.ended, ended.read], [true, true], "resolved, and not raised again");
    assert(ended.endedAt, "endedAt stamped");
    // It hangs again, on another command.
    const again = t.clock.now;
    t.store.heartbeat("m1", "working", bash(again));
    t.clock.now = again + 45 * MIN;
    const [second] = t.store.checkStalls();
    assert(second && second.id !== first!.id, "a new episode");
    assertEquals(t.store.stallNotes.list().length, 2);
    assertEquals(stalledComments(t, item).length, 2);
  } finally { t.cleanup(); }
});

test("an ended note seen stalled again is reopened quietly — same episode, no second comment", () => {
  const t = team();
  try {
    const item = claimed(t);
    const start = t.clock.now;
    t.store.heartbeat("m1", "working", bash(start));
    t.clock.now = start + HOUR;
    t.store.checkStalls();
    // The agent goes quiet (offline: not stalled), then comes back still stuck on the same call.
    t.store.updateMemberStatus("m1", "offline");
    t.store.checkStalls();
    assertEquals(t.store.stallNotes.list()[0]!.ended, true);
    t.store.heartbeat("m1", "working", bash(start));
    assertEquals(t.store.checkStalls(), [], "nothing new opened");
    assertEquals(t.store.stallNotes.list().length, 1);
    assertEquals(t.store.stallNotes.list()[0]!.ended, false);
    assertEquals(stalledComments(t, item).length, 1);
  } finally { t.cleanup(); }
});

test("routes: the notes list, mark read, and count in the Inbox badge", async () => {
  const t = team();
  try {
    claimed(t);
    const start = t.clock.now;
    t.store.heartbeat("m1", "working", bash(start));
    t.clock.now = start + HOUR;
    const badge = async () => (await (await get(t.app, "/api/status")).json() as StatusResponse).unreadInboxCount;
    const before = await badge();
    t.store.checkStalls();
    assertEquals(await badge(), before + 1);
    const list = await (await get(t.app, "/api/stalls/notes?read=false")).json() as StallNotesResponse;
    assertEquals(list.notes.length, 1);
    const id = list.notes[0]!.id;
    assertEquals((await post(t.app, `/api/stalls/notes/${encodeURIComponent(id)}/read`)).status, 200);
    assertEquals(await badge(), before);
    assertEquals(((await (await get(t.app, "/api/stalls/notes?read=false")).json()) as StallNotesResponse).notes.length, 0);
    assertEquals(((await (await get(t.app, "/api/stalls/notes")).json()) as StallNotesResponse).notes.length, 1);
    assertEquals((await post(t.app, `/api/stalls/notes/${encodeURIComponent(id)}/read?read=false`)).status, 200);
    assertEquals(await badge(), before + 1);
    assertEquals((await post(t.app, "/api/stalls/notes/nope/read")).status, 404);
  } finally { t.cleanup(); }
});

test("stallComment words the activity like mpt status", () => {
  const since = Date.parse("2026-11-14T00:00:00Z");
  assertEquals(stallComment({ since, activity: null, stallMinutes: 30, workItemId: "w" }, since + 13 * HOUR), "[stalled] no progress for 13h: no activity reported");
});

// ─── Interrupt ───────────────────────────────────────────────────────

test("interrupt: 404 unknown, 409 unsupported (with the Pair pointer), 201 for a harness that declared it", async () => {
  const t = team([]);
  try {
    assertEquals((await post(t.app, "/api/agents/ghost/interrupt")).status, 404);
    const old = await post(t.app, "/api/agents/m1/interrupt");
    assertEquals(old.status, 409);
    const body = await old.json() as { unsupported?: boolean; error?: string };
    assertEquals(body.unsupported, true);
    assertStringIncludes(body.error ?? "", "Pair");
    const agents = await (await get(t.app, "/api/agents")).json() as AgentListResponse;
    assertEquals(agents.agents.find((a) => a.id === "m1")?.interruptSupported, false);
    // Even one queued somehow is never handed to an older harness.
    t.store.createLeaderDirectiveForMember("m1", INTERRUPT_ACTION, {});
    assertEquals(t.store.getMemberDirectives("m1").filter((d) => d.action === INTERRUPT_ACTION).length, 0);
    assertEquals((await post(t.app, "/api/agents/m1/interrupt", { reason: 42 })).status, 400);
  } finally { t.cleanup(); }
});

test("interrupt: the directive's lifecycle — pending (not doubled), polled by the agent, done or failed on GET /api/agents", async () => {
  const t = team();
  try {
    claimed(t);
    const res = await post(t.app, "/api/agents/m1/interrupt", { reason: "  it has been 13 hours  " });
    assertEquals(res.status, 201);
    const { directive } = await res.json() as { directive: { id: string; action: string; params: Record<string, unknown> } };
    assertEquals(directive.action, INTERRUPT_ACTION);
    assertEquals(directive.params, { reason: "it has been 13 hours" });
    // A second click while it is pending: the same ask.
    const again = await (await post(t.app, "/api/agents/m1/interrupt")).json() as { directive: { id: string } };
    assertEquals(again.directive.id, directive.id);
    // The agent polls it (self-handled: never on the leader's list).
    const polled = await (await get(t.app, "/api/agents/m1/directives")).json() as { directives: Array<{ id: string; action: string }> };
    assertEquals(polled.directives.map((d) => d.action), [INTERRUPT_ACTION]);
    assert(!t.store.getLeaderDirectives().some((d) => d.id === directive.id), "not the spawner's");
    const view = async () => ((await (await get(t.app, "/api/agents")).json()) as AgentListResponse).agents.find((a) => a.id === "m1")!;
    assertEquals((await view()).interruptSupported, true);
    assertEquals((await view()).lastInterrupt?.status, "pending");
    assertEquals((await put(t.app, `/api/agents/m1/directives/${directive.id}`, { status: "done" })).status, 200);
    assertEquals((await view()).lastInterrupt?.status, "done");
    assertEquals(((await (await get(t.app, "/api/agents/m1/directives")).json()) as { directives: unknown[] }).directives.length, 0);
    // A new ask after that one is a new directive; the agent may refuse it with a reason.
    const next = await (await post(t.app, "/api/agents/m1/interrupt")).json() as { directive: { id: string } };
    assert(next.directive.id !== directive.id, "a fresh ask");
    await put(t.app, `/api/agents/m1/directives/${next.directive.id}`, { status: "failed", error: "no run in flight to interrupt" });
    const last = (await view()).lastInterrupt!;
    assertEquals([last.status, last.error], ["failed", "no run in flight to interrupt"]);
  } finally { t.cleanup(); }
});
