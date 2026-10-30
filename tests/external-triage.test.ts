/**
 * tests/external-triage.test.ts — Triage mode for external (pull-only) Work
 * Sources, driven by the in-repo fixture source (daemon/sources/fixture.ts).
 * See docs/DESIGN.md "External sources" — "Triage mode".
 *
 * Covers: a source (or one item) in triage mode → sync → a "Triage: …" item is
 * enqueued once per revision, in the mirror's or the leader's directory → the
 * claim prompt is the triage prompt with the mirror's content → `propose_work`
 * is accepted → proposals listed → accept creates the work (never runs it) with
 * a decision linking it → reject recorded → a content change is a new turn, an
 * unchanged revision isn't → Run = Triage now → the mode survives a restart →
 * `propose_work` is still refused for a work-mode item.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { FixtureSource } from "../daemon/sources/fixture.ts";
import { effectiveMode, mirroredWorkDefId, mirrorModeKey } from "../daemon/sources/mirror.ts";
import { fileSourceKv } from "../daemon/store/source-kv.ts";
import { buildExternalTriagePrompt, buildTriagePrompt } from "../daemon/prompt.ts";
import type { TriageProposal } from "../shared/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const SOURCE = "simt";

/**
 * A team with the fixture source as SIM-T. It declares `builtin:triage` as its
 * triage persona — a triage-mode source must have one (docs/DESIGN.md "Work
 * Source personas"; the requirement itself is covered in source-personas.test.ts).
 */
function setup(mode: "work" | "triage" = "triage", triagePersona: string | undefined = "builtin:triage") {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-ext-triage-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const folder = path.join(teamDir, "external");
  fs.mkdirSync(folder);
  const store = new Store(teamDir, TEST_CONFIG);
  store.registerWorkSource(new FixtureSource({ dir: folder, id: SOURCE, label: "SIM-T", syncEveryMs: null, mode, triagePersona }));
  const app = buildApp(store, TEST_CONFIG, teamDir);
  return { store, app, teamDir, folder };
}

function cleanup(store: Store, teamDir: string): void {
  store.close();
  try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeItem(folder: string, externalId: string, title: string, goal: string, extra: { mode?: string; directory?: string } = {}): void {
  const fm = [`title: ${title}`, `url: "https://simt.example/${externalId}"`];
  if (extra.mode) fm.push(`mode: ${extra.mode}`);
  if (extra.directory) fm.push(`directory: ${extra.directory}`);
  fs.writeFileSync(
    path.join(folder, `${externalId}.md`),
    `---\n${fm.join("\n")}\n---\n## Goal\n\n${goal}\n\n## Acceptance Criteria\n\n- MUST be fixed\n`,
  );
}

const task = (over: Partial<TriageProposal> = {}): TriageProposal =>
  ({ id: "p1", kind: "task", title: "Add retries", goal: "Retry the webhook three times", ...over });

async function claim(app: ReturnType<typeof buildApp>, itemId: string, agentId = "a1"): Promise<string> {
  const res = await app.request(`/api/agents/claim/${itemId}`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ agentId }),
  });
  assertEquals(res.status, 200);
  return (await res.json()).prompt as string;
}

function propose(app: ReturnType<typeof buildApp>, itemId: string, body: unknown) {
  return app.request(`/api/agents/work-items/${itemId}/proposals`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}

test("effectiveMode: the item's own mode wins, then the source's, then work", () => {
  assertEquals(effectiveMode({}, undefined), "work");
  assertEquals(effectiveMode({}, "triage"), "triage");
  assertEquals(effectiveMode({ mode: "work" }, "triage"), "work");
  assertEquals(effectiveMode({ mode: "triage" }, "work"), "triage");
});

test("external triage prompt: the item is the subject; a note's prompt is unchanged in shape", () => {
  const p = buildExternalTriagePrompt({
    item: { id: "simt~T-1", sourceLabel: "SIM-T", externalId: "T-1", title: "Webhooks flake", goal: "They time out.", url: "https://x/T-1" },
    priorComments: [{ from: "swift-neo", body: "Looks like one task.", at: "t" }],
    priorDecisions: ["task: Add retries — REJECTED by the author"],
  });
  assertStringIncludes(p, "## Your Role: Triage");
  assertStringIncludes(p, "## The Item (`T-1` from SIM-T)");
  assertStringIncludes(p, "### Webhooks flake");
  assertStringIncludes(p, "Link: https://x/T-1");
  assertStringIncludes(p, "They time out.");
  assertStringIncludes(p, "## Earlier Analysis of This Item");
  assertStringIncludes(p, "REJECTED by the author");
  assertStringIncludes(p, "propose_work");
  assertEquals(p.includes("## Task:"), false);
  const note = buildTriagePrompt({ note: { id: "th-1", content: "hi" } });
  assertStringIncludes(note, "## The Note (`th-1`)");
  assertStringIncludes(note, "don't change the note — the author answers you by editing it.");
});

test("triage mode: sync → triage item → propose_work → accept/reject → next revision is a new turn", async () => {
  const { store, app, teamDir, folder } = setup();
  try {
    writeItem(folder, "T-1", "Webhooks flake", "Deliveries time out under load.");
    const first = await store.syncWorkSource(SOURCE);
    assertEquals(first.enqueued.length, 1);
    const defId = mirroredWorkDefId(SOURCE, "T-1");
    const def = store.getWorkDef(defId)!;
    assert(store.isTriageModeMirror(def));
    assertEquals(fileSourceKv(teamDir, SOURCE).get(mirrorModeKey(defId)), "triage");

    // The item reads as a triage run; no mirror directory and no leader → none.
    const item = store.getWorkItem(first.enqueued[0]!)!;
    assertEquals(item.title, "Triage: Webhooks flake");
    assertEquals(item.directory ?? null, null);

    // An unchanged revision never re-runs.
    assertEquals((await store.syncWorkSource(SOURCE)).enqueued.length, 0);

    // The claim prompt is the triage prompt built from the mirror.
    store.registerMember("a1", "swift-neo", "/x", {});
    const prompt = await claim(app, item.id);
    assertStringIncludes(prompt, "## Your Role: Triage");
    assertStringIncludes(prompt, "from SIM-T");
    assertStringIncludes(prompt, "Deliveries time out under load.");
    assertStringIncludes(prompt, "https://simt.example/T-1");
    assertEquals(prompt.includes("## Task:"), false);

    // propose_work: validated as for a note; only the holder may post.
    assertEquals((await propose(app, item.id, { agentId: "a1", body: "x", outcome: "proposals", proposals: [] })).status, 400);
    assertEquals((await propose(app, item.id, { agentId: "other", body: "x", outcome: "nothing" })).status, 403);
    const ok = await propose(app, item.id, {
      agentId: "a1", body: "Two things here.", outcome: "proposals",
      proposals: [task(), task({ id: "p2", title: "Alert on failure" })],
    });
    assertEquals(ok.status, 200);
    const okBody = await ok.json();
    assertEquals(okBody.workDefId, defId);
    assertEquals(okBody.thoughtId, undefined);

    // The proposals, folded with decisions.
    const view = await (await app.request(`/api/work-defs/${defId}/triage`)).json();
    assertEquals(view.latestState, "IN_PROGRESS");
    assertEquals(view.subject, "mirror");
    assertEquals(view.mirror.mode, "triage");
    assertEquals(view.badge, "proposal");
    assertEquals(view.pending.length, 2);
    assertEquals(view.latestOutcome, "proposals");

    // The UI's surfaces: the source's list carries the badge; the item's runs say they're triage.
    const rows = (await (await app.request(`/api/work-sources/${SOURCE}/defs`)).json()).defs as Array<{ id: string; mode: string; triageBadge?: string }>;
    assertEquals(rows.find((r) => r.id === defId)?.triageBadge, "proposal");
    assertEquals((await (await app.request(`/api/work-items/${item.id}`)).json()).item.triage, true);

    // Accept creates the task (never runs it) and the decision links it.
    const accept = await app.request(`/api/work-defs/${defId}/triage/proposals/p1/accept`, { method: "POST" });
    assertEquals(accept.status, 200);
    const decision = (await accept.json()).decision as { action: string; workDefId?: string };
    assertEquals(decision.action, "accepted");
    const created = store.getWorkDef(decision.workDefId!)!;
    assertEquals(created.title, "Add retries");
    assertEquals(created.origin, { workDef: defId, proposal: "p1" });
    assertEquals(store.getExecutionStatsFor(created.id).executionCount, 0);

    // Reject is recorded; deciding twice is a conflict; an unknown id is a 404.
    assertEquals((await app.request(`/api/work-defs/${defId}/triage/proposals/p2/reject`, { method: "POST" })).status, 200);
    assertEquals((await app.request(`/api/work-defs/${defId}/triage/proposals/p2/reject`, { method: "POST" })).status, 409);
    assertEquals((await app.request(`/api/work-defs/${defId}/triage/proposals/nope/accept`, { method: "POST" })).status, 404);
    const after = await (await app.request(`/api/work-defs/${defId}/triage`)).json();
    assertEquals(after.badge, "none");
    const rowsAfter = (await (await app.request(`/api/work-sources/${SOURCE}/defs`)).json()).defs as Array<{ id: string; triageBadge?: string }>;
    assertEquals(rowsAfter.find((r) => r.id === defId)?.triageBadge, "none");
    assertEquals(after.pending.length, 0);
    // The decisions are lines in the mirror's own thread, not comments.
    const lines = fs.readFileSync(path.join(teamDir, "tasks", defId, "comments.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.filter((l) => l.kind === "decision").length, 2);
    assertEquals(store.getCommentsForRef({ workDefId: defId }).length, 1);

    // Finish; an unchanged revision still doesn't re-run, a changed one does.
    assertEquals(store.setWorkItemState(item.id, "COMPLETE").ok, true);
    assertEquals((await store.syncWorkSource(SOURCE)).enqueued.length, 0);
    writeItem(folder, "T-1", "Webhooks flake", "Deliveries time out under load — now also on retries.");
    const second = await store.syncWorkSource(SOURCE);
    assertEquals(second.enqueued.length, 1);
    const next = await claim(app, second.enqueued[0]!);
    assertStringIncludes(next, "now also on retries");
    assertStringIncludes(next, "## Earlier Analysis of This Item");
    assertStringIncludes(next, "Alert on failure — REJECTED by the author");
    assertStringIncludes(next, `Add retries — accepted (created ${created.id})`);

    // Run = Triage now: refused while in flight, then forces the current revision.
    assertEquals((await app.request(`/api/work-defs/${defId}/enqueue`, { method: "POST" })).status, 409);
    assertEquals(store.setWorkItemState(second.enqueued[0]!, "FAILED").ok, true);
    const run = await app.request(`/api/work-defs/${defId}/enqueue`, { method: "POST" });
    assertEquals(run.status, 200);
    assertEquals(store.getWorkItem((await run.json()).workItemId)!.title, "Triage: Webhooks flake");
  } finally { cleanup(store, teamDir); }
});

test("triage mode: runs in the mirror's directory, else the leader's", async () => {
  const { store, teamDir, folder } = setup();
  try {
    store.registerMember("leader-1", "leader", "/Users/x/code/proj");
    store.heartbeat("leader-1", "idle");
    writeItem(folder, "T-1", "No directory", "g");
    writeItem(folder, "T-2", "Own directory", "g", { directory: "/repo/own" });
    const out = await store.syncWorkSource(SOURCE);
    const items = out.enqueued.map((id) => store.getWorkItem(id)!);
    assertEquals(items.find((i) => i.title === "Triage: No directory")?.directory, "/Users/x/code/proj");
    assertEquals(items.find((i) => i.title === "Triage: Own directory")?.directory, "/repo/own");
  } finally { cleanup(store, teamDir); }
});

test("per-item mode overrides the source's, and propose_work is refused for a work-mode item", async () => {
  const { store, app, teamDir, folder } = setup("work");
  try {
    writeItem(folder, "W-1", "Just do it", "Plain work.");
    writeItem(folder, "T-1", "Triage me", "Look at this.", { mode: "triage" });
    const out = await store.syncWorkSource(SOURCE);
    assertEquals(out.enqueued.length, 2);
    const work = out.enqueued.map((id) => store.getWorkItem(id)!).find((i) => i.ref.workDefId === mirroredWorkDefId(SOURCE, "W-1"))!;
    const triage = out.enqueued.map((id) => store.getWorkItem(id)!).find((i) => i.ref.workDefId === mirroredWorkDefId(SOURCE, "T-1"))!;
    assertEquals(work.title, "Just do it");
    assertEquals(triage.title, "Triage: Triage me");

    store.registerMember("a1", "swift-neo", "/x", {});
    const workPrompt = await claim(app, work.id);
    assertStringIncludes(workPrompt, "## Task: Just do it");
    const refused = await propose(app, work.id, { agentId: "a1", body: "x", outcome: "nothing" });
    assertEquals(refused.status, 400);
    assertStringIncludes((await refused.json()).error, "only for a triage work item");

    // The triage routes refuse a work-mode mirror.
    assertEquals((await app.request(`/api/work-defs/${mirroredWorkDefId(SOURCE, "W-1")}/triage`)).status, 409);
    assertEquals((await app.request(`/api/work-defs/${mirroredWorkDefId(SOURCE, "W-1")}/triage/proposals/p1/accept`, { method: "POST" })).status, 404);

    // The rows say which is which.
    const rows = (await (await app.request(`/api/work-sources/${SOURCE}/defs`)).json()).defs as Array<{ externalId: string; mode: string }>;
    assertEquals(rows.find((r) => r.externalId === "T-1")?.mode, "triage");
    assertEquals(rows.find((r) => r.externalId === "W-1")?.mode, "work");
    // Only a triage-mode row has a badge, and only its runs are flagged triage.
    const badges = rows as Array<{ externalId: string; triageBadge?: string }>;
    assertEquals(badges.find((r) => r.externalId === "T-1")?.triageBadge, "none");
    assertEquals("triageBadge" in badges.find((r) => r.externalId === "W-1")!, false);
    assertEquals((await (await app.request(`/api/work-items/${work.id}`)).json()).item.triage, undefined);
    assertEquals((await (await app.request(`/api/work-items/${triage.id}`)).json()).item.triage, true);
  } finally { cleanup(store, teamDir); }
});

test("triage mode survives a restart, and an accepted proposal's origin reloads", async () => {
  const { store, teamDir, folder } = setup();
  try {
    writeItem(folder, "T-1", "Webhooks flake", "g");
    const out = await store.syncWorkSource(SOURCE);
    const defId = mirroredWorkDefId(SOURCE, "T-1");
    store.registerMember("a1", "swift-neo", "/x", {});
    assert(store.claimWorkItem(out.enqueued[0]!, "a1"));
    assertEquals(store.addTriageAnalysisForWorkDef(defId, "a1", "One task.", "proposals", [task()]).ok, true);
    const res = store.acceptProposalOn(defId, "p1") as { ok: true; decision: { workDefId?: string } };
    assert(res.ok);

    // A fresh Store with no source registered still knows the mode.
    const store2 = new Store(teamDir, TEST_CONFIG);
    try {
      assert(store2.isTriageModeMirror(store2.getWorkDef(defId)!));
      assertEquals(store2.getWorkDef(res.decision.workDefId!)?.origin, { workDef: defId, proposal: "p1" });
      assertEquals(store2.getTriageThreadForWorkDef(defId).proposals[0]?.decision?.action, "accepted");
    } finally { store2.close(); }
  } finally { cleanup(store, teamDir); }
});

test("a source switching an item back to work mode takes effect on the next sync", async () => {
  const { store, teamDir, folder } = setup("work");
  try {
    writeItem(folder, "T-1", "Flip", "g", { mode: "triage" });
    await store.syncWorkSource(SOURCE);
    const defId = mirroredWorkDefId(SOURCE, "T-1");
    assert(store.isTriageModeMirror(store.getWorkDef(defId)!));
    writeItem(folder, "T-1", "Flip", "g");
    await store.syncWorkSource(SOURCE);
    assertEquals(store.isTriageModeMirror(store.getWorkDef(defId)!), false);
    assertEquals(store.triageSubjectOf(defId), null);
  } finally { cleanup(store, teamDir); }
});
