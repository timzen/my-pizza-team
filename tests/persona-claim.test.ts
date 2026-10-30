/**
 * tests/persona-claim.test.ts — The persona consumers at claim time: every kind
 * of work resolves its persona through `Store.resolveWorkPersona`, the claim
 * prompt carries it, and the claim records it on the WorkItem (the snapshot).
 * Also the `persona` checks on `PUT /api/config` workflows and the Assistant's
 * fallback for a selection that no longer resolves. See docs/DESIGN.md
 * "Personas: One Library, Selected by Reference" — "Prompt composition", "The
 * in-flight persona", "Resolution".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { DEFAULT_ASSISTANT_PERSONA } from "../daemon/routes/assistant.ts";
import { DEFAULT_TRIAGE_INSTRUCTIONS } from "../daemon/prompt.ts";
import type { TeamConfig } from "../shared/types.ts";

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-persona-claim-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...structuredClone(TEST_CONFIG), ...configOverride };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  store.registerMember("a1", "swift-neo", "/tmp");
  return { app, store, teamDir, config, cleanup: () => { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); } };
}

const json = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

type App = ReturnType<typeof buildApp>;

/** Claim the READY item for `defId` as a1; returns the prompt. */
async function claim(app: App, store: Store, defId: string): Promise<{ prompt: string; itemId: string }> {
  const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === defId)!;
  const body = await (await app.request(`/api/agents/claim/${item.id}`, json("POST", { agentId: "a1" }))).json();
  assertEquals(body.success, true);
  return { prompt: body.prompt as string, itemId: item.id };
}

// ─── Solitary / Scheduled ────────────────────────────────────────────

test("claim: a Solitary task's persona leads the prompt and is recorded (via task)", async () => {
  const { app, store, cleanup } = setup();
  try {
    const created = store.createPersona({ title: "Careful Reviewer", content: "# Review\n\nNever edit code." });
    assertEquals(created.ok, true);
    const def = store.createWorkDef({ title: "Review it", goal: "Look.", acceptanceCriteria: "", persona: "careful-reviewer" });
    const { prompt, itemId } = await claim(app, store, def.id);
    assertEquals(prompt.startsWith("## Your Role\n\n### Review\n\nNever edit code."), true);
    assertEquals(store.getWorkItem(itemId)!.persona, { id: "careful-reviewer", title: "Careful Reviewer", origin: "team", via: "task" });
    // The work-items API carries the snapshot.
    const listed = (await (await app.request("/api/work-items")).json()).items.find((i: { id: string }) => i.id === itemId);
    assertEquals(listed.persona.id, "careful-reviewer");
  } finally { cleanup(); }
});

test("GET /api/work-items?workDefId=: one WorkDef's run history, each run with its snapshot (kept after the persona is deleted)", async () => {
  const { app, store, cleanup } = setup();
  try {
    store.createPersona({ title: "Historian", content: "Record things." });
    const def = store.createWorkDef({ title: "Log it", goal: "g", acceptanceCriteria: "", persona: "historian" });
    const other = store.createWorkDef({ title: "Other", goal: "g", acceptanceCriteria: "" });
    const { itemId } = await claim(app, store, def.id);
    // The persona goes, and the def stops naming it: history keeps what the run recorded.
    await app.request(`/api/work-defs/${def.id}`, json("PUT", { persona: null }));
    store.deletePersona("historian");
    const body = await (await app.request(`/api/work-items?workDefId=${encodeURIComponent(def.id)}`)).json();
    assertEquals(body.total, 1);
    assertEquals(body.items.map((i: { id: string }) => i.id), [itemId]);
    assertEquals(body.items[0].persona, { id: "historian", title: "Historian", origin: "team", via: "task" });
    const others = await (await app.request(`/api/work-items?workDefId=${encodeURIComponent(other.id)}`)).json();
    assertEquals(others.items.length, 1);
    assertEquals(others.items[0].persona, undefined);
  } finally { cleanup(); }
});

test("claim: a Solitary task without a persona gets no persona block and no snapshot", async () => {
  const { app, store, cleanup } = setup();
  try {
    const def = store.createWorkDef({ title: "Plain", goal: "Do it.", acceptanceCriteria: "" });
    const { prompt, itemId } = await claim(app, store, def.id);
    assertEquals(prompt.includes("## Your Role"), false);
    assertEquals(prompt.startsWith("## Task: Plain"), true);
    assertEquals(store.getWorkItem(itemId)!.persona, undefined);
  } finally { cleanup(); }
});

test("claim: a persona that no longer resolves falls back to builtin:worker (never fails the claim)", async () => {
  const { app, store, cleanup } = setup();
  try {
    store.createPersona({ title: "Gone", content: "Soon deleted." });
    const def = store.createWorkDef({ title: "Orphan", goal: "g", acceptanceCriteria: "", persona: "gone" });
    store.deletePersona("gone");
    const { prompt, itemId } = await claim(app, store, def.id);
    const worker = store.getPersona("builtin:worker")!;
    assertStringIncludes(prompt, `## Your Role\n\n${worker.content.trim().split("\n")[0]}`);
    assertEquals(store.getWorkItem(itemId)!.persona, {
      id: "builtin:worker", title: worker.title, origin: "builtin", via: "task", fallbackFrom: "gone",
    });
  } finally { cleanup(); }
});

test("claim: every run of a schedule uses its persona (via schedule)", async () => {
  const { app, store, cleanup } = setup();
  try {
    store.createPersona({ title: "Summarizer", content: "Be brief." });
    const res = await (await app.request("/api/work-defs", json("POST", {
      type: "Scheduled", cron: "0 9 * * 1-5", title: "Daily", goal: "Summarize.", persona: "summarizer",
    }))).json();
    assertEquals(res.success, true);
    const id = res.workDef.id as string;
    assertEquals((await app.request(`/api/work-defs/${id}/enqueue`, json("POST", {}))).status, 200);
    const { prompt, itemId } = await claim(app, store, id);
    assertEquals(prompt.startsWith("## Your Role\n\nBe brief."), true);
    assertEquals(store.getWorkItem(itemId)!.persona?.via, "schedule");
  } finally { cleanup(); }
});

// ─── Board ───────────────────────────────────────────────────────────

test("claim: a board task gets its workflow state's persona (via workflow-state); none = state framing, no snapshot", async () => {
  const { app, store, cleanup } = setup();
  try {
    store.createStory("s1", "S1", "D", "open", [], [{ title: "T1", description: "D1" }], "default");
    const bare = await claim(app, store, "s1-1");
    assertStringIncludes(bare.prompt, "You are working in the 'in_progress' state");
    assertEquals(store.getWorkItem(bare.itemId)!.persona, undefined);

    store.createPersona({ title: "Implementer", content: "Small diffs." });
    assertEquals(store.setStatePersona("default", "in_progress", "implementer").ok, true);
    store.createStory("s2", "S2", "D", "open", [], [{ title: "T2", description: "D2" }], "default");
    const framed = await claim(app, store, "s2-1");
    assertEquals(framed.prompt.startsWith("## Your Role: in_progress\n\nSmall diffs."), true);
    assertEquals(store.getWorkItem(framed.itemId)!.persona, { id: "implementer", title: "Implementer", origin: "team", via: "workflow-state" });
  } finally { cleanup(); }
});

// ─── Triage ──────────────────────────────────────────────────────────

test("claim: note triage uses triage.persona, else builtin:triage (via triage)", async () => {
  const { app, store, cleanup } = setup();
  try {
    const t1 = store.createThought({ content: "Should we add a cache?" });
    const first = store.triageNow(t1.id);
    assertEquals(first.ok, true);
    const def1 = store.ensureTriageWorkDef(t1.id)!;
    const a = await claim(app, store, def1.id);
    assertStringIncludes(a.prompt, DEFAULT_TRIAGE_INSTRUCTIONS.trim().split("\n")[0]!);
    assertEquals(store.getWorkItem(a.itemId)!.persona?.id, "builtin:triage");
    assertEquals(store.getWorkItem(a.itemId)!.persona?.via, "triage");

    store.createPersona({ title: "Note triager", content: "Triage notes tersely." });
    assertEquals((await app.request("/api/config", json("PUT", {
      ...(await (await app.request("/api/config")).json()), triage: { persona: "note-triager" },
    }))).status, 200);
    store.registerMember("a2", "calm-oak", "/tmp");
    const t2 = store.createThought({ content: "Rename the repo?" });
    assertEquals(store.triageNow(t2.id).ok, true);
    const def2 = store.ensureTriageWorkDef(t2.id)!;
    const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === def2.id)!;
    const body = await (await app.request(`/api/agents/claim/${item.id}`, json("POST", { agentId: "a2" }))).json();
    assertStringIncludes(body.prompt, "## Your Role: Triage\n\nTriage notes tersely.");
    assertEquals(store.getWorkItem(item.id)!.persona, { id: "note-triager", title: "Note triager", origin: "team", via: "triage" });
  } finally { cleanup(); }
});

// ─── PUT /api/config: workflow state personas ────────────────────────

test("PUT /api/config: a workflow state's persona must resolve when it changes; a stale unchanged one is kept", async () => {
  const { app, store, teamDir, cleanup } = setup();
  try {
    const base = await (await app.request("/api/config")).json();
    const withPersona = (persona: unknown, type = "agent") => ({
      ...base,
      workflows: { ...base.workflows, default: { ...base.workflows.default, states: base.workflows.default.states.map((s: { name: string }) => s.name === "in_progress" ? { ...s, type, persona } : s) } },
    });
    let res = await app.request("/api/config", json("PUT", withPersona("nope")));
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).error, `persona "nope" doesn't exist`);
    assertEquals((await app.request("/api/config", json("PUT", withPersona(42)))).status, 400);

    store.createPersona({ title: "Implementer", content: "Small diffs." });
    assertEquals((await app.request("/api/config", json("PUT", withPersona("implementer")))).status, 200);
    assertEquals(store.getWorkflows().default!.states.find((s) => s.name === "in_progress")!.persona, "implementer");
    // Manual states have no teammate, so a newly set persona there is refused.
    assertEquals((await app.request("/api/config", json("PUT", withPersona("builtin:worker", "manual")))).status, 400);

    // The persona is deleted out from under the workflow (a hand edit): saving the
    // rest of the config still works, and the stale reference is left for the fallback.
    fs.rmSync(path.join(teamDir, "personas", "implementer.md"));
    const again = await (await app.request("/api/config")).json();
    assertEquals((await app.request("/api/config", json("PUT", { ...again, maxTeammates: 3 }))).status, 200);
    assertEquals(store.getWorkflows().default!.states.find((s) => s.name === "in_progress")!.persona, "implementer");
  } finally { cleanup(); }
});

// ─── Assistant ───────────────────────────────────────────────────────

test("assistant: a selection that no longer resolves runs as builtin:assistant", async () => {
  const { app, store, teamDir, cleanup } = setup();
  try {
    store.createPersona({ title: "Pizzaiolo", content: "Gruff." });
    assertEquals((await app.request("/api/assistant/persona", json("PUT", { personaId: "pizzaiolo" }))).status, 200);
    store.deletePersona("pizzaiolo"); // nothing re-points assistant.persona in this test
    fs.rmSync(path.join(teamDir, "personas", "pizzaiolo.md"), { force: true });
    const body = await (await app.request("/api/assistant/persona")).json();
    assertEquals(body.personaId, null);
    assertEquals(body.entry, null);
    assertEquals(body.persona.id, "builtin:assistant");
    assertStringIncludes(body.systemPrompt, DEFAULT_ASSISTANT_PERSONA);
    assertEquals(store.resolveAssistantPersona().fallbackFrom, "pizzaiolo");
  } finally { cleanup(); }
});
