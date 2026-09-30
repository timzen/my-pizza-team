/**
 * tests/triage.test.ts — Auto triage (TODO.md "Auto Triage").
 *
 * The turn rule is the fiddly part, so it's tested twice: the pure rules
 * (daemon/triage.ts) and then the Store's behaviour — lazy WorkDef creation, the
 * version stamped at *enqueue* (so an edit mid-run isn't swallowed and a failed
 * run doesn't re-cost every sweep), the prompt, and the note's lifecycle.
 */

import { assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { TEST_CONFIG } from "./_config.ts";
import { buildApp } from "../daemon/server.ts";
import { Store } from "../daemon/store.ts";
import { DEFAULT_TRIAGE_INSTRUCTIONS, buildTriagePrompt } from "../daemon/prompt.ts";
import {
  isTriageDue,
  noteFirstLine,
  thoughtIdFromTriageWorkDef,
  triageSkipReason,
  triageWorkDefId,
  triageWorkItemTitle,
} from "../daemon/triage.ts";
import { resolveTriage, type TeamConfig } from "../shared/types.ts";
import * as path from "@std/path";

// ─── The pure rules ──────────────────────────────────────────────────

const note = (over: Record<string, unknown> = {}) => ({
  status: "active" as const, content: "do a thing", updatedAt: "2026-09-29T10:00:00.000Z", ...over,
});
const due = (over: Record<string, unknown> = {}, quietMinutes = 10) =>
  triageSkipReason({ note: note(over), inFlight: false, now: Date.parse("2026-09-29T12:00:00.000Z"), quietMinutes });

Deno.test("triage rules: a changed note past the quiet period is due", () => {
  assertEquals(due(), null);
  assertEquals(due({ triagedVersion: "2026-09-29T09:00:00.000Z" }), null); // edited since
});

Deno.test("triage rules: archived and empty notes are never triaged", () => {
  assertEquals(due({ status: "archived" }), "archived");
  assertEquals(due({ content: "" }), "empty");
  assertEquals(due({ content: "   \n\n" }), "empty");
});

Deno.test("triage rules: an unchanged note is skipped — so a failed run doesn't retry every sweep", () => {
  // The version is stamped at enqueue, so "analyzed" covers a run that failed.
  assertEquals(due({ triagedVersion: "2026-09-29T10:00:00.000Z" }), "unchanged");
  assertEquals(due({ triagedVersion: "2026-09-29T11:00:00.000Z" }), "unchanged");
});

Deno.test("triage rules: one run at a time per note", () => {
  assertEquals(
    triageSkipReason({ note: note(), inFlight: true, now: Date.parse("2026-09-29T12:00:00.000Z"), quietMinutes: 10 }),
    "in-flight",
  );
});

Deno.test("triage rules: a note edited inside the quiet period waits for the next sweep", () => {
  assertEquals(due({ updatedAt: "2026-09-29T11:55:00.000Z" }), "too-fresh");
  assertEquals(due({ updatedAt: "2026-09-29T11:45:00.000Z" }), null); // 15 min ago
  // quietMinutes: 0 disables the wait.
  assertEquals(due({ updatedAt: "2026-09-29T11:59:59.000Z" }, 0), null);
  assertEquals(isTriageDue({ note: note(), inFlight: false, now: Date.parse("2026-09-29T12:00:00.000Z"), quietMinutes: 10 }), true);
});

Deno.test("triage ids and titles", () => {
  assertEquals(triageWorkDefId("th-1"), "triage-th-1");
  assertEquals(thoughtIdFromTriageWorkDef("triage-th-1"), "th-1");
  assertEquals(thoughtIdFromTriageWorkDef("some-task"), null);
  assertEquals(noteFirstLine("# Retry the webhook\n\nmore"), "Retry the webhook");
  assertEquals(noteFirstLine("\n\n- [ ] buy milk"), "buy milk");
  assertEquals(noteFirstLine("x".repeat(80)).length, 60);
  assertEquals(triageWorkItemTitle({ id: "th-1", content: "## Fix the thing\nbody" }), "Triage: Fix the thing");
  assertEquals(triageWorkItemTitle({ id: "th-1", content: "" }), "Triage note th-1");
});

Deno.test("triage config defaults: on, hourly, 10 minutes quiet", () => {
  assertEquals(resolveTriage({}), { enabled: true, intervalMinutes: 60, quietMinutes: 10 });
  assertEquals(resolveTriage({ triage: { enabled: false } }).enabled, false);
  assertEquals(resolveTriage({ triage: { quietMinutes: 0 } }).quietMinutes, 0);
  // Nonsense falls back rather than disabling the sweep or dividing by zero.
  assertEquals(resolveTriage({ triage: { intervalMinutes: 0 } }).intervalMinutes, 60);
});

// ─── The prompt ──────────────────────────────────────────────────────

Deno.test("triage prompt: instructions, the note, its group, stories, earlier analysis", () => {
  const p = buildTriagePrompt({
    note: { id: "th-1", content: "# Webhooks flake\nRetries would help." },
    groupName: "Q3",
    stories: [{ id: "payments", title: "Payments hardening" }],
    priorComments: [{ from: "swift-neo", body: "Looks like two tasks.", at: "2026-09-29T10:00:00.000Z" }],
  });
  assertStringIncludes(p, "## Your Role: Triage");
  assertStringIncludes(p, "Lean toward **proposing work**"); // the built-in default
  assertStringIncludes(p, "in group “Q3”");
  assertStringIncludes(p, "Retries would help.");
  assertStringIncludes(p, "`payments` — Payments hardening");
  assertStringIncludes(p, "> Looks like two tasks.");
  assertStringIncludes(p, "don't change the note");
  // The note's own headings are demoted so they can't compete with the prompt's.
  assertStringIncludes(p, "### Webhooks flake");
});

Deno.test("triage prompt: a team's triage.md replaces the built-in instructions", () => {
  const p = buildTriagePrompt({ note: { id: "th-1", content: "hi" }, instructions: "# Only propose chores" });
  assertStringIncludes(p, "Only propose chores");
  assertEquals(p.includes("Lean toward"), false);
  assertEquals(DEFAULT_TRIAGE_INSTRUCTIONS.length > 0, true);
});

// ─── The Store ───────────────────────────────────────────────────────

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = Deno.makeTempDirSync({ prefix: "mpt-triage-test-" });
  Deno.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...TEST_CONFIG, ...configOverride };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir, config };
}

function cleanup(teamDir: string, store: Store) {
  store.close();
  try { Deno.removeSync(teamDir, { recursive: true }); } catch { /* */ }
}

/**
 * A note plus a clock the sweep will accept it from. `createThought` stamps
 * `updatedAt = now`, which is inside the quiet period, so tests sweep from
 * `LATER` rather than pretending the note is old.
 */
function note_(store: Store, content: string) {
  return store.createThought({ content });
}

/** An hour after "now": past the default 10-minute quiet period. */
const LATER = () => Date.now() + 60 * 60 * 1000;

/** Run an item the way an agent does: register, claim, then finish. */
function runItem(store: Store, itemId: string, state: "COMPLETE" | "FAILED", agentId = "a1") {
  if (!store.getMember(agentId)) store.registerMember(agentId, "swift-neo", "/tmp/repo");
  assertEquals(store.claimWorkItem(itemId, agentId), true);
  assertEquals(store.setWorkItemState(itemId, state).ok, true);
}

Deno.test("sweep: enqueues one item per changed note, creating its WorkDef lazily", () => {
  const { store, teamDir } = setup();
  try {
    const a = note_(store, "# Webhooks flake\nretries?");
    note_(store, ""); // empty: never triaged
    assertEquals(store.getWorkDef(triageWorkDefId(a.id)), null); // nothing yet

    const items = store.runTriageSweep(LATER());
    assertEquals(items.length, 1);
    assertEquals(items[0]!.title, "Triage: Webhooks flake");
    const def = store.getWorkDef(triageWorkDefId(a.id));
    assertEquals(def?.parent, { kind: "thought", id: a.id });
    assertEquals(def?.goal, ""); // a container, not authored work
    assertEquals(store.getWorkDefs().filter((d) => d.parent?.kind === "thought").length, 1);

    // Second sweep: nothing changed, so nothing is enqueued.
    assertEquals(store.runTriageSweep(LATER()).length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("sweep: the quiet period holds a just-edited note until the next sweep", () => {
  const { store, teamDir } = setup();
  try {
    const t = store.createThought({ content: "half-written thoug" });
    assertEquals(store.runTriageSweep(Date.now()).length, 0);
    assertEquals(store.triageStatusFor(t.id), "too-fresh");
    // An hour later it's fair game.
    assertEquals(store.runTriageSweep(LATER()).length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("sweep: disabled means no runs at all", () => {
  const { store, teamDir } = setup({ triage: { enabled: false } });
  try {
    note_(store, "something worth doing");
    assertEquals(store.runTriageSweep(LATER()).length, 0);
  } finally { cleanup(teamDir, store); }
});

Deno.test("turns: an edit while the run is in flight is picked up by the next sweep", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "first version");
    const [item] = store.runTriageSweep(LATER());
    const stamped = store.getThought(t.id)!.triagedVersion;
    assertEquals(stamped, store.getThought(t.id)!.updatedAt);

    // Author edits while the teammate is working: not eligible yet (in flight).
    store.updateThought(t.id, { content: "second version" });
    assertEquals(store.triageStatusFor(t.id, LATER()), "in-flight");
    assertNotEquals(store.getThought(t.id)!.updatedAt, stamped);

    // The run finishes; the edit is now due — the version compared is the one
    // handed over, not the time of the teammate's comment.
    runItem(store, item!.id, "COMPLETE");
    assertEquals(store.runTriageSweep(LATER()).length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("turns: a failed run counts as analyzed; Triage now retries it", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "something");
    const [item] = store.runTriageSweep(LATER());
    runItem(store, item!.id, "FAILED");

    // No retry loop: the note is unchanged, so the sweep leaves it alone.
    assertEquals(store.runTriageSweep(LATER()).length, 0);
    assertEquals(store.triageStatusFor(t.id, LATER()), "unchanged");

    const res = store.triageNow(t.id);
    assertEquals(res.ok, true);
  } finally { cleanup(teamDir, store); }
});

Deno.test("Triage now: overrides quiet/unchanged, refuses in-flight, archived, empty", () => {
  const { store, teamDir } = setup();
  try {
    const fresh = store.createThought({ content: "just typed" });
    assertEquals(store.triageNow(fresh.id).ok, true); // quiet period overridden
    const again = store.triageNow(fresh.id);
    assertEquals(again.ok, false);
    assertStringIncludes((again as { error: string }).error, "already being triaged");

    const empty = store.createThought({ content: "" });
    assertStringIncludes((store.triageNow(empty.id) as { error: string }).error, "nothing to triage");

    const archived = store.createThought({ content: "old idea" });
    store.archiveThought(archived.id);
    assertStringIncludes((store.triageNow(archived.id) as { error: string }).error, "archived");

    assertStringIncludes((store.triageNow("th-nope") as { error: string }).error, "not found");
  } finally { cleanup(teamDir, store); }
});

Deno.test("lifecycle: archiving a note cancels its run and archives its WorkDef; restore brings it back", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "an idea");
    const [item] = store.runTriageSweep(LATER());
    store.archiveThought(t.id);
    assertEquals(store.getWorkItem(item!.id)?.state, "CANCELED");
    assertEquals(store.getWorkDef(triageWorkDefId(t.id))?.status, "archived");

    store.restoreThought(t.id);
    assertEquals(store.getWorkDef(triageWorkDefId(t.id))?.status, "active");
  } finally { cleanup(teamDir, store); }
});

Deno.test("lifecycle: deleting a note deletes its triage WorkDef and thread", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "an idea");
    const [item] = store.runTriageSweep(LATER());
    store.addCommentForRef({ workDefId: triageWorkDefId(t.id) }, "swift-neo", "Two tasks here.");
    store.deleteThought(t.id);
    assertEquals(store.getWorkDef(triageWorkDefId(t.id)), null);
    assertEquals(store.getWorkItem(item!.id)?.state, "CANCELED");
  } finally { cleanup(teamDir, store); }
});

Deno.test("an archived note's queued triage item is never handed to an agent", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "an idea");
    store.registerMember("a1", "swift-neo", "/tmp/repo");
    store.runTriageSweep(LATER());
    assertNotEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp/repo" }), null);
    store.archiveThought(t.id);
    assertEquals(store.getNextWorkItem({ id: "a1", directory: "/tmp/repo" }), null);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a triage item runs in the leader's directory, or anywhere with no leader", () => {
  const { store, teamDir } = setup();
  try {
    const a = note_(store, "no leader yet");
    assertEquals(store.runTriageSweep(LATER())[0]!.directory, undefined);

    store.registerMember("leader-1", "leader", "/Users/x/code/proj");
    store.heartbeat("leader-1", "idle");
    const b = note_(store, "leader is up");
    const item = store.runTriageSweep(LATER()).find((wi) => wi.title.includes("leader is up"));
    assertEquals(item?.directory, "/Users/x/code/proj");
    assertEquals([a.id, b.id].length, 2);
  } finally { cleanup(teamDir, store); }
});

Deno.test("triage.md round-trips through the store; empty restores the default", () => {
  const { store, teamDir } = setup();
  try {
    assertEquals(store.getTriageInstructions(), undefined);
    store.setTriageInstructions("# Only propose chores");
    assertStringIncludes(store.getTriageInstructions()!, "chores");
    assertEquals(Deno.readTextFileSync(path.join(teamDir, "triage.md")).endsWith("\n"), true);
    store.setTriageInstructions("");
    assertEquals(store.getTriageInstructions(), undefined);
  } finally { cleanup(teamDir, store); }
});

// ─── The routes ──────────────────────────────────────────────────────

Deno.test("POST /api/thoughts/:id/triage enqueues a run; the claim prompt is the note", async () => {
  const { app, store, teamDir } = setup();
  try {
    const t = store.createThought({ content: "# Webhooks flake\nretries?" });
    const res = await app.request(`/api/thoughts/${t.id}/triage`, { method: "POST" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertStringIncludes(body.workItem.title, "Triage: Webhooks flake");

    // A teammate claims it and gets the triage prompt, not a WorkDef prompt.
    await app.request("/api/agents/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "a1", name: "swift-neo" }),
    });
    const claim = await app.request(`/api/agents/claim/${body.workItem.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "a1" }),
    });
    const claimed = await claim.json();
    assertStringIncludes(claimed.prompt, "## Your Role: Triage");
    assertStringIncludes(claimed.prompt, "retries?");

    // Second request while it's in flight is a 409.
    assertEquals((await app.request(`/api/thoughts/${t.id}/triage`, { method: "POST" })).status, 409);
    assertEquals((await app.request("/api/thoughts/th-nope/triage", { method: "POST" })).status, 404);
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET/PUT /api/triage/instructions", async () => {
  const { app, store, teamDir } = setup();
  try {
    let body = await (await app.request("/api/triage/instructions")).json();
    assertEquals(body.content, "");
    assertStringIncludes(body.default, "Lean toward");

    const put = await app.request("/api/triage/instructions", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# House rules" }),
    });
    assertEquals(put.status, 200);
    body = await (await app.request("/api/triage/instructions")).json();
    assertStringIncludes(body.content, "House rules");

    const bad = await app.request("/api/triage/instructions", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assertEquals(bad.status, 400);
  } finally { cleanup(teamDir, store); }
});

Deno.test("a triage note version survives a round-trip through the note file", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "an idea");
    const [item] = store.runTriageSweep(LATER());
    runItem(store, item!.id, "COMPLETE");
    const stamped = store.getThought(t.id)!.triagedVersion;
    assertEquals(typeof stamped, "string");
    // Re-read from disk through a fresh store: frontmatter carried it.
    const store2 = new Store(teamDir, TEST_CONFIG);
    try {
      assertEquals(store2.getThought(t.id)!.triagedVersion, stamped);
      // …and a position change doesn't touch either timestamp.
      store2.updateThought(t.id, { x: 50, y: 60 });
      assertEquals(store2.getThought(t.id)!.triagedVersion, stamped);
      assertEquals(store2.triageStatusFor(t.id, LATER()), "unchanged");
    } finally { store2.close(); }
  } finally { cleanup(teamDir, store); }
});

Deno.test("a triage WorkDef is owned by its note: no direct edit, delete, or Run", async () => {
  const { app, store, teamDir } = setup();
  try {
    const t = note_(store, "an idea");
    store.runTriageSweep(LATER());
    const defId = triageWorkDefId(t.id);

    const put = await app.request(`/api/work-defs/${defId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "something else" }),
    });
    assertEquals(put.status, 409);
    assertStringIncludes((await put.json()).error, `edit the note instead`);
    assertEquals(store.getWorkDef(defId)?.goal, ""); // untouched

    assertEquals((await app.request(`/api/work-defs/${defId}`, { method: "DELETE" })).status, 409);
    assertNotEquals(store.getWorkDef(defId), null);

    // Run on a triage thread means Triage now — refused here only because one
    // is already in flight from the sweep above.
    const run = await app.request(`/api/work-defs/${defId}/enqueue`, { method: "POST" });
    assertEquals(run.status, 409);
    assertStringIncludes((await run.json()).error, "already being triaged");
  } finally { cleanup(teamDir, store); }
});

// ─── Stage 2: proposals and decisions ────────────────────────────────

import {
  decisionSummary,
  foldProposals,
  latestAnalysis,
  pendingProposals,
  triageBadge,
  validateAnalysis,
  validateProposal,
} from "../daemon/triage.ts";
import type { ThreadEntry, TriageProposal } from "../shared/types.ts";

const ctx = { storyExists: (id: string) => id === "payments" };
const task = (over: Partial<TriageProposal> = {}): TriageProposal =>
  ({ id: "p1", kind: "task", title: "Add retries", goal: "Back off and retry", ...over });

Deno.test("validate: an outcome is required and must be one of the three", () => {
  assertStringIncludes(validateAnalysis({}, ctx)!, "outcome must be one of");
  assertStringIncludes(validateAnalysis({ outcome: "maybe" }, ctx)!, "outcome must be one of");
  assertEquals(validateAnalysis({ outcome: "nothing" }, ctx), null);
  assertEquals(validateAnalysis({ outcome: "question" }, ctx), null);
});

Deno.test("validate: 'proposals' needs at least one, and the others none", () => {
  assertStringIncludes(validateAnalysis({ outcome: "proposals" }, ctx)!, "needs at least one proposal");
  assertStringIncludes(validateAnalysis({ outcome: "proposals", proposals: [] }, ctx)!, "needs at least one proposal");
  assertStringIncludes(validateAnalysis({ outcome: "nothing", proposals: [task()] }, ctx)!, "carries no proposals");
  assertEquals(validateAnalysis({ outcome: "proposals", proposals: [task()] }, ctx), null);
});

Deno.test("validate: ids are required and unique, and the message says which proposal", () => {
  assertStringIncludes(validateAnalysis({ outcome: "proposals", proposals: [{ kind: "task", title: "x", goal: "y" }] }, ctx)!, "needs an id");
  assertStringIncludes(
    validateAnalysis({ outcome: "proposals", proposals: [task(), task()] }, ctx)!,
    'duplicate id "p1"',
  );
  assertStringIncludes(
    validateAnalysis({ outcome: "proposals", proposals: [task(), task({ id: "p2", goal: "" })] }, ctx)!,
    'proposal 2 ("p2"): needs a goal',
  );
});

Deno.test("validate: each kind's own requirements", () => {
  assertStringIncludes(validateProposal({ kind: "nope" as never, title: "x" }, ctx)!, "kind must be one of");
  assertStringIncludes(validateProposal(task({ title: "  " }), ctx)!, "needs a title");
  // story-task must name a story that exists — the prompt lists them.
  assertStringIncludes(validateProposal(task({ kind: "story-task" }), ctx)!, "needs the storyId");
  assertStringIncludes(validateProposal(task({ kind: "story-task", storyId: "ghost" }), ctx)!, 'no story "ghost"');
  assertEquals(validateProposal(task({ kind: "story-task", storyId: "payments" }), ctx), null);
  // schedule needs a real cron.
  assertStringIncludes(validateProposal(task({ kind: "schedule" }), ctx)!, "valid 5-field cron");
  assertStringIncludes(validateProposal(task({ kind: "schedule", cron: "every friday" }), ctx)!, "valid 5-field cron");
  assertEquals(validateProposal(task({ kind: "schedule", cron: "0 9 * * 1-5" }), ctx), null);
  // story carries tasks instead of a goal.
  assertStringIncludes(validateProposal({ id: "p", kind: "story", title: "Hardening" }, ctx)!, "at least one task");
  assertStringIncludes(
    validateProposal({ id: "p", kind: "story", title: "H", tasks: [{ title: "t", goal: "" }] }, ctx)!,
    "task 1 needs a goal",
  );
  assertEquals(validateProposal({ id: "p", kind: "story", title: "H", tasks: [{ title: "t", goal: "g" }] }, ctx), null);
});

const analysis = (proposals: TriageProposal[], at = "2026-09-29T10:00:00.000Z"): ThreadEntry =>
  ({ from: "swift-neo", body: "…", at, outcome: "proposals", proposals });
const decision = (proposalId: string, action: "accepted" | "rejected", workDefId?: string): ThreadEntry =>
  ({ kind: "decision", proposalId, action, from: "you", at: "2026-09-29T11:00:00.000Z", ...(workDefId ? { workDefId } : {}) });

Deno.test("fold: state is a read of the append-only file, top to bottom", () => {
  const entries = [analysis([task(), task({ id: "p2", title: "Alert on failure" })]), decision("p1", "accepted", "td-1")];
  const folded = foldProposals(entries);
  assertEquals(folded.length, 2);
  assertEquals(folded[0]!.decision?.action, "accepted");
  assertEquals(folded[0]!.decision?.workDefId, "td-1");
  assertEquals(folded[1]!.decision, undefined); // still pending
  assertEquals(pendingProposals(entries).map((s) => s.proposal.id), ["p2"]);
});

Deno.test("fold: ordinary comments and unknown lines don't disturb it", () => {
  const entries: ThreadEntry[] = [
    { from: "swift-neo", body: "just a comment", at: "2026-09-29T09:00:00.000Z" },
    analysis([task()]),
  ];
  assertEquals(foldProposals(entries).length, 1);
  assertEquals(latestAnalysis(entries)?.outcome, "proposals");
});

Deno.test("badge: the latest outcome, and nothing once every proposal is decided", () => {
  assertEquals(triageBadge([]), "none");
  assertEquals(triageBadge([analysis([task()])]), "proposal");
  assertEquals(triageBadge([analysis([task()]), decision("p1", "rejected")]), "none");
  assertEquals(triageBadge([analysis([task()]), decision("p1", "accepted", "td-1")]), "none");
  assertEquals(triageBadge([{ from: "a", body: "b", at: "x", outcome: "nothing" }]), "nothing");
  assertEquals(triageBadge([{ from: "a", body: "b", at: "x", outcome: "question" }]), "question");
  // A later analysis replaces the badge even when older proposals are undecided.
  assertEquals(
    triageBadge([analysis([task()]), { from: "a", body: "b", at: "z", outcome: "question" }]),
    "question",
  );
});

Deno.test("decisionSummary tells the next run what the author did", () => {
  const lines = decisionSummary([
    analysis([task(), task({ id: "p2", title: "Alert" })]),
    decision("p1", "accepted", "td-1"),
    decision("p2", "rejected"),
  ]);
  assertEquals(lines, [
    "task: Add retries — accepted (created td-1)",
    "task: Alert — REJECTED by the author",
  ]);
});

/** Post an analysis the way the teammate does, through the Store. */
function postAnalysis(store: Store, thoughtId: string, proposals: TriageProposal[], outcome: "proposals" | "nothing" | "question" = "proposals") {
  const res = store.addTriageAnalysis(thoughtId, "swift-neo", "Here's what I think.", outcome, proposals);
  assertEquals(res.ok, true, (res as { error?: string }).error);
}

Deno.test("an analysis lands in the thread; a bad one is refused with a fixable reason", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "webhooks flake");
    store.runTriageSweep(LATER());

    const bad = store.addTriageAnalysis(t.id, "swift-neo", "x", "proposals", [task({ goal: "" })]);
    assertEquals(bad.ok, false);
    assertStringIncludes((bad as { error: string }).error, "needs a goal");
    assertEquals(store.getTriageThread(t.id).entries.length, 0); // nothing written

    postAnalysis(store, t.id, [task()]);
    const thread = store.getTriageThread(t.id);
    assertEquals(thread.badge, "proposal");
    assertEquals(thread.latestOutcome, "proposals");
    assertEquals(thread.pending.length, 1);
    // The analysis is a comment, so the existing thread UI and prompt see it.
    assertEquals(store.getCommentsForRef({ workDefId: thread.workDefId }).length, 1);
  } finally { cleanup(teamDir, store); }
});

Deno.test("accept a task proposal: creates the WorkDef, doesn't run it, links both ways", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "webhooks flake");
    store.runTriageSweep(LATER());
    postAnalysis(store, t.id, [task()]);

    const res = store.acceptProposal(t.id, "p1");
    assertEquals(res.ok, true);
    const workDefId = (res as { decision: { workDefId?: string } }).decision.workDefId!;
    const def = store.getWorkDef(workDefId)!;
    assertEquals(def.title, "Add retries");
    assertEquals(def.goal, "Back off and retry");
    assertEquals(def.origin, { thought: t.id, proposal: "p1" }); // note → work
    // Create only: nothing queued for it.
    assertEquals(store.getWorkItems({ states: ["READY"] }).items.some((wi) => wi.ref.workDefId === workDefId), false);
    // …and the decision is in the thread, so the badge clears.
    assertEquals(store.getTriageThread(t.id).badge, "none");
    assertEquals(store.getTriageBadges()[t.id], undefined);
  } finally { cleanup(teamDir, store); }
});

Deno.test("accept: story-task, story, and schedule proposals create the right shapes", () => {
  const { store, teamDir } = setup();
  try {
    store.createStory("payments", "Payments hardening", "Make payments boring.");
    const t = note_(store, "several things");
    store.runTriageSweep(LATER());
    postAnalysis(store, t.id, [
      task({ id: "p1", kind: "story-task", storyId: "payments", title: "Retry the sender" }),
      { id: "p2", kind: "story", title: "Webhook reliability", description: "End to end.", tasks: [{ title: "Retries", goal: "back off" }, { title: "Alerting", goal: "page on final failure" }] },
      task({ id: "p3", kind: "schedule", title: "Nightly webhook report", cron: "0 9 * * 1-5" }),
    ]);

    const a = store.acceptProposal(t.id, "p1") as { ok: true; decision: { workDefId?: string; storyId?: string } };
    assertEquals(a.decision.storyId, "payments");
    assertEquals(store.getWorkDef(a.decision.workDefId!)?.parent, { kind: "story", id: "payments" });
    assertEquals(store.getTasksForStory("payments").length, 1);

    const b = store.acceptProposal(t.id, "p2") as { ok: true; decision: { storyId?: string } };
    const story = store.getStory(b.decision.storyId!)!;
    assertEquals(story.title, "Webhook reliability");
    assertEquals(store.getTasksForStory(story.id).length, 2);
    assertEquals(store.getWorkDef(store.getTasksForStory(story.id)[0]!.id)?.origin?.proposal, "p2");

    const c = store.acceptProposal(t.id, "p3") as { ok: true; decision: { workDefId?: string } };
    const sched = store.getWorkDef(c.decision.workDefId!)!;
    assertEquals(sched.parent?.kind, "schedule");
    assertEquals(store.getSchedules().find((s) => s.id === sched.parent!.id)?.cron, "0 9 * * 1-5");
  } finally { cleanup(teamDir, store); }
});

Deno.test("accept creates but never starts: a task waits for Run; a story task follows board rules", () => {
  const { store, teamDir } = setup();
  try {
    store.createStory("payments", "Payments hardening", "Boring payments.");
    const t = note_(store, "two things");
    store.runTriageSweep(LATER());
    postAnalysis(store, t.id, [task(), task({ id: "p2", kind: "story-task", storyId: "payments", title: "Retry the sender" })]);

    // A Solitary task is created idle — nothing queued for it.
    const a = store.acceptProposal(t.id, "p1") as { ok: true; decision: { workDefId?: string } };
    assertEquals(store.getWorkItems({ states: ["READY"] }).items.some((wi) => wi.ref.workDefId === a.decision.workDefId), false);

    // A story task enters its story's workflow, which admits it exactly as it
    // would a task you added by hand — so it *is* queued. Not a triage rule; the
    // board's (the hand-added task below proves they behave the same).
    const b = store.acceptProposal(t.id, "p2") as { ok: true; decision: { workDefId?: string } };
    assertEquals(store.getWorkItems({ states: ["READY"] }).items.some((wi) => wi.ref.workDefId === b.decision.workDefId), true);
    store.createStory("other", "Other", "d");
    const byHand = store.addTask("other", { title: "By hand", description: "g" })!;
    assertEquals(store.getWorkItems({ states: ["READY"] }).items.some((wi) => wi.ref.workDefId === byHand.id), true);
  } finally { cleanup(teamDir, store); }
});

Deno.test("accept with overrides (the Edit path), or recording work created elsewhere", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "webhooks flake");
    store.runTriageSweep(LATER());
    postAnalysis(store, t.id, [task(), task({ id: "p2", title: "Alert" })]);

    const edited = store.acceptProposal(t.id, "p1", { overrides: { title: "Retry with backoff", goal: "Exponential, 5 tries" } }) as { ok: true; decision: { workDefId?: string } };
    const def = store.getWorkDef(edited.decision.workDefId!)!;
    assertEquals(def.title, "Retry with backoff");
    assertEquals(def.goal, "Exponential, 5 tries");

    // The author created it through the normal form; we only record the decision.
    const own = store.createWorkDef({ title: "Alerting, my way", goal: "…", acceptanceCriteria: "" }, false);
    const rec = store.acceptProposal(t.id, "p2", { existingWorkDefId: own.id }) as { ok: true; decision: { workDefId?: string } };
    assertEquals(rec.decision.workDefId, own.id);
    assertEquals(store.getWorkDefs().filter((d) => d.title === "Alert").length, 0); // nothing duplicated
  } finally { cleanup(teamDir, store); }
});

Deno.test("reject is one line and not a turn; a decided proposal can't be decided twice", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "webhooks flake");
    const [item] = store.runTriageSweep(LATER());
    runItem(store, item!.id, "COMPLETE");
    postAnalysis(store, t.id, [task()]);
    const before = store.getThought(t.id)!.updatedAt;

    assertEquals(store.rejectProposal(t.id, "p1").ok, true);
    assertEquals(store.getTriageThread(t.id).proposals[0]!.decision?.action, "rejected");
    // Not a turn: the note is untouched, so no new run is due.
    assertEquals(store.getThought(t.id)!.updatedAt, before);
    assertEquals(store.runTriageSweep(LATER()).length, 0);

    const twice = store.rejectProposal(t.id, "p1");
    assertEquals(twice.ok, false);
    assertStringIncludes((twice as { error: string }).error, "already rejected");
    assertStringIncludes((store.acceptProposal(t.id, "p1") as { error: string }).error, "already rejected");
    assertStringIncludes((store.rejectProposal(t.id, "nope") as { error: string }).error, 'No proposal "nope"');
  } finally { cleanup(teamDir, store); }
});

Deno.test("the next run's prompt carries what the author decided", async () => {
  const { app, store, teamDir } = setup();
  try {
    const t = note_(store, "webhooks flake");
    const [first] = store.runTriageSweep(LATER());
    runItem(store, first!.id, "COMPLETE");
    postAnalysis(store, t.id, [task(), task({ id: "p2", title: "Alert on failure" })]);
    store.acceptProposal(t.id, "p1");
    store.rejectProposal(t.id, "p2");

    store.updateThought(t.id, { content: "webhooks flake — and the retries didn't help" });
    const second = store.triageNow(t.id) as { ok: true; workItem: { id: string } };
    await app.request("/api/agents/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "a2", name: "calm-otter" }),
    });
    const claim = await app.request(`/api/agents/claim/${second.workItem.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "a2" }),
    });
    const prompt = (await claim.json()).prompt as string;
    assertStringIncludes(prompt, "What the Author Did With Earlier Proposals");
    assertStringIncludes(prompt, "Alert on failure — REJECTED");
    assertStringIncludes(prompt, "Don't re-propose something they rejected");
    assertStringIncludes(prompt, "propose_work");
  } finally { cleanup(teamDir, store); }
});

Deno.test("POST /api/agents/work-items/:id/proposals is for the holder of a triage item only", async () => {
  const { app, store, teamDir } = setup();
  try {
    const t = note_(store, "webhooks flake");
    const [item] = store.runTriageSweep(LATER());
    store.registerMember("a1", "swift-neo", "/tmp/repo");
    store.claimWorkItem(item!.id, "a1");

    const post = (body: unknown) =>
      app.request(`/api/agents/work-items/${item!.id}/proposals`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });

    assertEquals((await post({ agentId: "a1" })).status, 400); // no body
    assertEquals((await post({ agentId: "someone-else", body: "x", outcome: "nothing" })).status, 403);
    const invalid = await post({ agentId: "a1", body: "x", outcome: "proposals", proposals: [] });
    assertEquals(invalid.status, 400);
    assertStringIncludes((await invalid.json()).error, "needs at least one proposal");

    const ok = await post({ agentId: "a1", body: "Two things here.", outcome: "proposals", proposals: [task()] });
    assertEquals(ok.status, 200);
    assertEquals(store.getTriageThread(t.id).pending.length, 1);

    // A non-triage item can't use it.
    const solitary = store.createWorkDef({ title: "Ordinary", goal: "g", acceptanceCriteria: "" });
    const other = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === solitary.id)!;
    store.claimWorkItem(other.id, "a1");
    const wrong = await app.request(`/api/agents/work-items/${other.id}/proposals`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "a1", body: "x", outcome: "nothing" }),
    });
    assertEquals(wrong.status, 400);
    assertStringIncludes((await wrong.json()).error, "only for a triage work item");
  } finally { cleanup(teamDir, store); }
});

Deno.test("GET /api/thoughts/:id/triage and the accept/reject routes", async () => {
  const { app, store, teamDir } = setup();
  try {
    const t = note_(store, "webhooks flake");
    store.runTriageSweep(LATER());
    postAnalysis(store, t.id, [task(), task({ id: "p2", title: "Alert" })]);

    const view = await (await app.request(`/api/thoughts/${t.id}/triage`)).json();
    assertEquals(view.triaged, true);
    assertEquals(view.badge, "proposal");
    assertEquals(view.pending.length, 2);
    assertEquals(view.note.id, t.id);
    assertEquals(view.skipReason, "in-flight");

    const accept = await app.request(`/api/thoughts/${t.id}/proposals/p1/accept`, { method: "POST" });
    assertEquals(accept.status, 200);
    const reject = await app.request(`/api/thoughts/${t.id}/proposals/p2/reject`, { method: "POST" });
    assertEquals(reject.status, 200);
    assertEquals((await app.request(`/api/thoughts/${t.id}/proposals/p2/reject`, { method: "POST" })).status, 409);
    assertEquals((await app.request(`/api/thoughts/${t.id}/proposals/nope/accept`, { method: "POST" })).status, 404);

    const badges = await (await app.request("/api/triage/badges")).json();
    assertEquals(badges.badges[t.id], undefined); // all decided
    assertEquals((await (await app.request(`/api/thoughts/${t.id}/triage`)).json()).badge, "none");
  } finally { cleanup(teamDir, store); }
});

Deno.test("an accepted proposal's WorkDef keeps its origin across a reload", () => {
  const { store, teamDir } = setup();
  try {
    const t = note_(store, "webhooks flake");
    store.runTriageSweep(LATER());
    postAnalysis(store, t.id, [task()]);
    const res = store.acceptProposal(t.id, "p1") as { ok: true; decision: { workDefId?: string } };
    const store2 = new Store(teamDir, TEST_CONFIG);
    try {
      assertEquals(store2.getWorkDef(res.decision.workDefId!)?.origin, { thought: t.id, proposal: "p1" });
    } finally { store2.close(); }
  } finally { cleanup(teamDir, store); }
});
