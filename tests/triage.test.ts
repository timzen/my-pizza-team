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
