/**
 * tests/personas.test.ts — The persona library: team files, read-only built-ins
 * and package personas, `resolvePersona`'s fallback, "Used by", the
 * `/api/personas*` routes (lint, read-only, delete protection, duplicate), the
 * 410 stubs for the removed context library, `persona` on Solitary/Scheduled
 * WorkDefs, and the WorkItem's claim-time persona snapshot. See docs/DESIGN.md
 * "Personas: One Library, Selected by Reference".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertExists, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { listBuiltinPersonas } from "../daemon/personas/builtins.ts";
import { validatePersonaMarkdown } from "../daemon/personas/lint.ts";
import { personaRefOf, personaUsage, resolvePersona } from "../daemon/personas/resolve.ts";
import { freeTeamPersonaId } from "../daemon/personas/library.ts";
import { DEFAULT_ASSISTANT_PERSONA } from "../daemon/routes/assistant.ts";
import { DEFAULT_TRIAGE_INSTRUCTIONS } from "../daemon/prompt.ts";
import { parsePersonaId, type Persona, type TeamConfig } from "../shared/types.ts";

function setup(configOverride?: Partial<TeamConfig>) {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-personas-test-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const config = { ...structuredClone(TEST_CONFIG), ...configOverride };
  const store = new Store(teamDir, config);
  const app = buildApp(store, config, teamDir);
  return { app, store, teamDir, config, cleanup: () => { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); } };
}

const json = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// ─── Ids, built-ins, resolution (pure) ───────────────────────────────

test("persona ids: team slug, builtin:<name>, and <package>/<id> split on the last '/'", () => {
  assertEquals(parsePersonaId("reviewer"), { kind: "team" });
  assertEquals(parsePersonaId("builtin:worker"), { kind: "builtin", name: "worker" });
  assertEquals(parsePersonaId("@acme/mpt-personas/reviewer"), { kind: "package", packageName: "@acme/mpt-personas", name: "reviewer" });
  assertEquals(parsePersonaId("Bad Id").kind, "invalid");
  assertEquals(parsePersonaId("pkg/").kind, "invalid");
  assertEquals(freeTeamPersonaId("Code Reviewer!", (id) => id === "code-reviewer"), "code-reviewer-2");
});

test("built-ins wrap today's defaults unchanged, and lint clean", () => {
  const byId = new Map(listBuiltinPersonas().map((p) => [p.id, p]));
  assertEquals(byId.get("builtin:assistant")!.content, DEFAULT_ASSISTANT_PERSONA);
  assertEquals(byId.get("builtin:triage")!.content, DEFAULT_TRIAGE_INSTRUCTIONS);
  assertExists(byId.get("builtin:worker"));
  for (const p of byId.values()) {
    assertEquals(p.readOnly, true);
    assertEquals(validatePersonaMarkdown(p.content).errors, []);
  }
});

test("resolvePersona: found, missing → fallback with fallbackFrom, unset → none", () => {
  const lib: Record<string, Persona> = Object.fromEntries(listBuiltinPersonas().map((p) => [p.id, p]));
  lib["reviewer"] = { id: "reviewer", title: "Reviewer", description: "", tags: [], content: "Review.", origin: { kind: "team" }, readOnly: false };
  const lookup = (id: string) => lib[id] ?? null;
  const found = resolvePersona(lookup, "reviewer", { via: "workflow-state", fallback: "builtin:worker" })!;
  assertEquals([found.id, found.body, found.via, found.fallbackFrom], ["reviewer", "Review.", "workflow-state", undefined]);
  const missing = resolvePersona(lookup, "reviewr", { via: "workflow-state", fallback: "builtin:worker" })!;
  assertEquals([missing.id, missing.fallbackFrom], ["builtin:worker", "reviewr"]);
  assertEquals(resolvePersona(lookup, "reviewr", { via: "task", fallback: null }), null);
  assertEquals(resolvePersona(lookup, undefined, { via: "task", fallback: "builtin:worker" }), null);
  assertEquals(personaRefOf(missing), { id: "builtin:worker", title: lib["builtin:worker"]!.title, origin: "builtin", via: "workflow-state", fallbackFrom: "reviewr" });
});

test("personaUsage finds every kind of reference", () => {
  const usedBy = personaUsage("p", {
    workflows: { default: { states: [{ name: "code", type: "agent", persona: "p" }, { name: "qa", type: "manual", persona: "p" }] } },
    config: { triage: { persona: "p" }, assistant: { persona: "p" }, sourcePersonas: { jira: { persona: "p", triagePersona: "p" } } },
    workDefs: [{ id: "w1", title: "W1", persona: "p" }, { id: "w2", title: "W2" }],
    mirrorOverrides: [{ workDefId: "m1", source: "jira", persona: "p" }],
  });
  assertEquals(usedBy, [
    { kind: "workflow-state", workflow: "default", state: "code" },
    { kind: "triage" },
    { kind: "assistant" },
    { kind: "workdef", workDefId: "w1", title: "W1" },
    { kind: "mirror-override", workDefId: "m1", source: "jira" },
    { kind: "source-setting", source: "jira", field: "persona" },
    { kind: "source-setting", source: "jira", field: "triagePersona" },
  ]);
});

// ─── The Store ───────────────────────────────────────────────────────

test("Store: team personas round-trip through personas/<id>.md with frontmatter", () => {
  const { store, teamDir, cleanup } = setup();
  try {
    const res = store.createPersona({ title: "Code Reviewer", description: "Reads diffs", tags: ["review"], kinds: ["worker"], content: "Never edit code." });
    assertEquals(res.ok, true);
    const p = res.ok ? res.persona : null;
    assertEquals(p!.id, "code-reviewer");
    assertEquals(p!.origin, { kind: "team" });
    const raw = fs.readFileSync(path.join(teamDir, "personas", "code-reviewer.md"), "utf8");
    assertStringIncludes(raw, "title: Code Reviewer\ndescription: Reads diffs\ntags: [review]\nkinds: [worker]\n---\nNever edit code.");
    assertEquals(store.getPersona("code-reviewer")!.content, "Never edit code.");
    // Same title again: -2.
    const again = store.createPersona({ title: "Code Reviewer", content: "x" });
    assertEquals(again.ok && again.persona.id, "code-reviewer-2");
    // A given id must be free and valid.
    assertEquals(store.createPersona({ id: "code-reviewer", title: "T", content: "x" }).ok, false);
    assertEquals(store.createPersona({ id: "Bad/Id", title: "T", content: "x" }).ok, false);
    // The library lists team, then built-ins.
    const ids = store.listPersonas().map((x) => x.id);
    assertEquals(ids.slice(0, 2), ["code-reviewer", "code-reviewer-2"]);
    assertEquals(ids.includes("builtin:worker"), true);
  } finally { cleanup(); }
});

test("Store: a state persona that doesn't resolve falls back to builtin:worker", () => {
  const { store, cleanup } = setup();
  try {
    const wf = store.getWorkflows()["default"]!;
    store.saveWorkflow("default", { states: wf.states.map((s) => s.type === "agent" ? { ...s, persona: "gone" } : s) });
    const agentState = wf.states.find((s) => s.type === "agent")!.name;
    const r = store.resolveStatePersona("default", agentState)!;
    assertEquals([r.id, r.fallbackFrom, r.via], ["builtin:worker", "gone", "workflow-state"]);
  } finally { cleanup(); }
});

test("Store: package personas are read-only and namespaced by package name", () => {
  const { store, cleanup } = setup();
  try {
    const result = store.packagePersonas.register({ name: "@acme/mpt-personas", identity: "npm:@acme/mpt-personas" }, [
      { name: "reviewer", raw: "---\ntitle: Acme reviewer\ndescription: \"\"\ntags: []\n---\n### Review\n\nCarefully." },
      { name: "broken", raw: "```\nunclosed" },
      { name: "Bad Name", raw: "x" },
    ]);
    assertEquals(result.personas, ["@acme/mpt-personas/reviewer", "@acme/mpt-personas/broken"]);
    assertEquals(result.errors.length, 2); // the lint error and the bad name
    const p = store.getPersona("@acme/mpt-personas/reviewer")!;
    assertEquals([p.title, p.readOnly, p.origin.kind], ["Acme reviewer", true, "package"]);
    // A lint error marks the persona but it still loads (references still resolve).
    assertExists(store.getPersona("@acme/mpt-personas/broken")!.lintError);
    // A different package claiming the same name is refused.
    const dup = store.packagePersonas.register({ name: "@acme/mpt-personas", identity: "git:github.com/x/y" }, [{ name: "other", raw: "x" }]);
    assertEquals(dup.personas, []);
    assertEquals(store.getPersona("@acme/mpt-personas/other"), null);
  } finally { cleanup(); }
});

test("Store: recordWorkItemPersona snapshots the persona on the WorkItem (claim-time, never re-resolved)", () => {
  const { store, cleanup } = setup();
  try {
    const created = store.createPersona({ title: "Solo worker", content: "Work alone." });
    const def = store.createWorkDef({ title: "Solo", goal: "g", acceptanceCriteria: "", persona: created.ok ? created.persona.id : undefined });
    assertEquals(def.persona, "solo-worker");
    const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === def.id)!;
    assertEquals(item.persona, undefined);
    store.registerMember("a1", "swift-neo", "/tmp");
    const resolved = store.resolvePersona(def.persona, { via: "task", fallback: "builtin:worker" })!;
    assertEquals(store.claimWorkItem(item.id, "a1", personaRefOf(resolved)), true);
    assertEquals(store.getWorkItem(item.id)!.persona, { id: "solo-worker", title: "Solo worker", origin: "team", via: "task" });
    // Editing or deleting the persona later rewrites nothing recorded.
    store.updatePersona("solo-worker", { title: "Renamed" });
    store.deletePersona("solo-worker");
    assertEquals(store.getWorkItem(item.id)!.persona!.title, "Solo worker");
  } finally { cleanup(); }
});

// ─── Routes ──────────────────────────────────────────────────────────

test("routes: create/read/update/delete a team persona; saves are linted", async () => {
  const { app, cleanup } = setup();
  try {
    // A lint error refuses the save; warnings come back with it.
    const bad = await app.request("/api/personas", json("POST", { title: "Bad", content: "```\nunclosed" }));
    assertEquals(bad.status, 400);
    assertEquals((await bad.json()).errors.length, 1);
    const created = await app.request("/api/personas", json("POST", { title: "Reviewer", content: "# Review\n\nRead it.", kinds: ["worker", "nonsense"] }));
    assertEquals(created.status, 201);
    const body = await created.json();
    assertEquals(body.persona.id, "reviewer");
    assertEquals(body.persona.kinds, ["worker"]);
    assertEquals(body.warnings.length, 1); // the shallow heading

    const got = await (await app.request("/api/personas/reviewer")).json();
    assertEquals([got.persona.title, got.persona.readOnly, got.usedBy], ["Reviewer", false, []]);

    const upd = await app.request("/api/personas/reviewer", json("PUT", { content: "### Review\n\nRead it twice." }));
    assertEquals(upd.status, 200);
    assertEquals((await upd.json()).warnings, []);
    assertEquals((await app.request("/api/personas/reviewer", json("PUT", { content: "~~~\nopen" }))).status, 400);

    assertEquals((await app.request("/api/personas/reviewer", json("DELETE"))).status, 200);
    assertEquals((await app.request("/api/personas/reviewer")).status, 404);
    assertEquals((await app.request("/api/personas", json("POST", { content: "x" }))).status, 400);
  } finally { cleanup(); }
});

test("routes: built-in and package personas are read-only; duplicate copies them into the team", async () => {
  const { app, store, cleanup } = setup();
  try {
    store.packagePersonas.register({ name: "acme", identity: "/tmp/acme" }, [{ name: "reviewer", raw: "Acme review." }]);
    for (const id of ["builtin:worker", "acme/reviewer"]) {
      const enc = encodeURIComponent(id);
      assertEquals((await app.request(`/api/personas/${enc}`, json("PUT", { content: "x" }))).status, 409);
      assertEquals((await app.request(`/api/personas/${enc}`, json("DELETE"))).status, 409);
    }
    // An unencoded package id reaches the same persona (`:id{.+}`).
    assertEquals((await (await app.request("/api/personas/acme/reviewer")).json()).persona.id, "acme/reviewer");

    const dup = await app.request(`/api/personas/${encodeURIComponent("builtin:triage")}/duplicate`, json("POST", {}));
    assertEquals(dup.status, 201);
    const copy = (await dup.json()).persona;
    assertEquals([copy.id, copy.title, copy.duplicatedFrom, copy.readOnly], ["triage", "Triage", "builtin:triage", false]);
    assertEquals(copy.content, DEFAULT_TRIAGE_INSTRUCTIONS);
    const pkgDup = await (await app.request("/api/personas/acme/reviewer/duplicate", json("POST", { title: "Our reviewer" }))).json();
    assertEquals([pkgDup.persona.id, pkgDup.persona.duplicatedFrom], ["our-reviewer", "acme/reviewer"]);
    assertEquals((await app.request("/api/personas/nope/duplicate", json("POST", {}))).status, 404);
  } finally { cleanup(); }
});

test("routes: GET /api/personas?kind= lists hinted personas first", async () => {
  const { app, cleanup } = setup();
  try {
    const all = (await (await app.request("/api/personas?kind=assistant")).json()).personas as Persona[];
    assertEquals(all[0]!.id, "builtin:assistant");
    const triage = (await (await app.request("/api/personas?kind=triage")).json()).personas as Persona[];
    assertEquals(triage[0]!.id, "builtin:triage");
  } finally { cleanup(); }
});

test("routes: a persona in use can't be deleted (409 + usedBy); usage lists its users", async () => {
  const { app, store, cleanup } = setup();
  try {
    await app.request("/api/personas", json("POST", { title: "Helper", content: "Help." }));
    await app.request("/api/assistant/persona", json("PUT", { personaId: "helper" }));
    const agentState = store.getWorkflows()["default"]!.states.find((s) => s.type === "agent")!.name;
    assertEquals((await app.request(`/api/workflows/default/states/${agentState}`, json("PUT", { persona: "helper" }))).status, 200);
    const del = await app.request("/api/personas/helper", json("DELETE"));
    assertEquals(del.status, 409);
    const usedBy = (await del.json()).usedBy;
    assertEquals(usedBy, [{ kind: "workflow-state", workflow: "default", state: agentState }, { kind: "assistant" }]);
    assertEquals((await (await app.request("/api/personas/helper/usage")).json()).usedBy, usedBy);
    assertEquals((await app.request("/api/personas/nope/usage")).status, 404);
  } finally { cleanup(); }
});

test("routes: the context library is gone — 410 naming personas, and attachments are refused", async () => {
  const { app, store, cleanup } = setup();
  try {
    for (const [method, url] of [["GET", "/api/context"], ["POST", "/api/context"], ["GET", "/api/context/x"], ["PUT", "/api/context/x"], ["DELETE", "/api/context/x"]] as const) {
      const res = await app.request(url, json(method, method === "GET" || method === "DELETE" ? undefined : {}));
      assertEquals(res.status, 410);
      assertStringIncludes((await res.json()).error, "/api/personas");
    }
    const wd = await app.request("/api/work-defs", json("POST", { title: "T", goal: "g", contextRefs: ["x"] }));
    assertEquals(wd.status, 400);
    store.createStory("s1", "S", "d", "open", []);
    assertEquals((await app.request("/api/stories/s1/tasks", json("POST", { title: "T", description: "d", context: ["x"] }))).status, 400);
    assertEquals((await app.request("/api/stories/s1", json("PUT", { context: ["x"] }))).status, 400);
  } finally { cleanup(); }
});

test("routes: Solitary/Scheduled WorkDefs take an optional persona; board tasks refuse one", async () => {
  const { app, store, cleanup } = setup();
  try {
    await app.request("/api/personas", json("POST", { title: "Night owl", content: "Work quietly." }));
    assertEquals((await app.request("/api/work-defs", json("POST", { title: "T", goal: "g", persona: "nope" }))).status, 400);
    const solo = (await (await app.request("/api/work-defs", json("POST", { title: "Solo", goal: "g", persona: "night-owl", enqueue: false }))).json()).workDef;
    assertEquals(solo.persona, "night-owl");
    const sched = (await (await app.request("/api/work-defs", json("POST", { title: "Nightly", goal: "g", type: "Scheduled", cron: "0 3 * * *", persona: "builtin:worker" }))).json()).workDef;
    assertEquals(sched.persona, "builtin:worker");
    // Not part of the locked definition: an active def's persona can change, and be cleared.
    assertEquals((await app.request(`/api/work-defs/${sched.id}`, json("PUT", { persona: "night-owl" }))).status, 200);
    assertEquals(store.getWorkDef(sched.id)!.persona, "night-owl");
    assertEquals((await app.request(`/api/work-defs/${sched.id}`, json("PUT", { persona: null }))).status, 200);
    assertEquals(store.getWorkDef(sched.id)!.persona, undefined);
    // The persona shows up in "Used by".
    assertEquals(store.getPersonaUsage("night-owl"), [{ kind: "workdef", workDefId: solo.id, title: "Solo" }]);

    store.createStory("s1", "S", "d", "open", [], [{ title: "Board", description: "g" }], undefined, true);
    const boardId = store.getTasksForStory("s1")[0]!.id;
    const refused = await app.request(`/api/work-defs/${boardId}`, json("PUT", { persona: "night-owl" }));
    assertEquals(refused.status, 400);
    assertStringIncludes((await refused.json()).error, "workflow state");
  } finally { cleanup(); }
});

test("routes: the work-item and agent views carry the persona snapshot", async () => {
  const { app, store, cleanup } = setup();
  try {
    const def = store.createWorkDef({ title: "Solo", goal: "g", acceptanceCriteria: "" });
    const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === def.id)!;
    store.registerMember("a1", "swift-neo", "/tmp");
    store.claimWorkItem(item.id, "a1", { id: "builtin:worker", title: "Worker (built-in)", origin: "builtin", via: "task" });
    const items = (await (await app.request("/api/work-items?state=IN_PROGRESS")).json()).items;
    assertEquals(items[0].persona, { id: "builtin:worker", title: "Worker (built-in)", origin: "builtin", via: "task" });
    const agents = (await (await app.request("/api/agents")).json()).agents;
    assertEquals(agents[0].persona.id, "builtin:worker");
    assertEquals(agents[0].workItemId, item.id);
  } finally { cleanup(); }
});
