/**
 * tests/persona-aliases.test.ts — The deprecated `worker` spellings of the
 * `teammate` persona kind and built-in (DEPRECATED(worker→teammate): remove in
 * remove-worker-aliases, with daemon/personas/aliases.ts).
 *
 * Each alias keeps working and warns once per run: frontmatter `kinds: [worker]`
 * loads as `teammate` (the file isn't rewritten until it is saved, which writes
 * `teammate`), `GET /api/personas?kind=worker` sorts like `kind=teammate`, and
 * `builtin:worker` resolves to `builtin:teammate` wherever a persona id is read —
 * workflow states, tasks, schedules, sources, config — and in "Used by". The UI
 * (ui/src/lib/personas.ts) shows an old id as its replacement, not as missing.
 * See docs/DESIGN.md "Personas" ("`worker` became `teammate`").
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./_assert.ts";
import { withTeam, jsonInit } from "./_team.ts";
import { normalizePersonaId, normalizePersonaKind, resetPersonaAliasWarnings } from "../daemon/personas/aliases.ts";
import { getBuiltinPersona } from "../daemon/personas/builtins.ts";
import { normalizeKinds } from "../daemon/personas/library.ts";
import { personaUsage } from "../daemon/personas/resolve.ts";
import { canonicalPersonaId, canonicalPersonaKind } from "../shared/types.ts";
import { currentPersonaId, missingSelection, personaChip } from "../ui/src/lib/personas.ts";

/** Run `fn` with console.warn captured (and the one-time warnings reset first). */
async function captureWarnings(fn: () => unknown | Promise<unknown>): Promise<string[]> {
  resetPersonaAliasWarnings();
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return logs;
}

const KIND_WARNING = "[personas] 'worker' is deprecated; use 'teammate'";
const ID_WARNING = "[personas] 'builtin:worker' is deprecated; use 'builtin:teammate'";

// ─── The pure maps ───────────────────────────────────────────────────

test("canonicalPersonaKind / canonicalPersonaId: the old spellings map, everything else is kept", () => {
  assertEquals(["worker", "teammate", "triage", "assistant", "nonsense", 3].map(canonicalPersonaKind), ["teammate", "teammate", "triage", "assistant", null, null]);
  assertEquals(["builtin:worker", "builtin:teammate", "builtin:triage", "reviewer", "pkg/worker"].map(canonicalPersonaId),
    ["builtin:teammate", "builtin:teammate", "builtin:triage", "reviewer", "pkg/worker"]);
});

// ─── kinds: [worker] ─────────────────────────────────────────────────

test("kinds: 'worker' normalizes to 'teammate' (deduped), warning once", async () => {
  const logs = await captureWarnings(() => {
    assertEquals(normalizeKinds(["worker", "triage", "teammate"]), ["teammate", "triage"]);
    assertEquals(normalizePersonaKind("worker"), "teammate");
    assertEquals(normalizePersonaKind("teammate"), "teammate");
  });
  assertEquals(logs, [KIND_WARNING]);
});

test("a persona file with kinds: [worker] loads as teammate; it's only rewritten when saved", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    const file = path.join(teamDir, "personas", "old-coder.md");
    const raw = "---\ntitle: Old coder\ndescription: From before the rename\ntags: []\nkinds: [worker]\n---\nWrite code.";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);

    const logs = await captureWarnings(async () => {
      assertEquals(store.getPersona("old-coder")!.kinds, ["teammate"]);
      const listed = (await (await app.request("/api/personas")).json()).personas.find((p: { id: string }) => p.id === "old-coder");
      assertEquals(listed.kinds, ["teammate"]);
    });
    assertEquals(logs, [KIND_WARNING]);
    assertEquals(fs.readFileSync(file, "utf8"), raw, "reading never rewrites the file");

    // Saving it (as the UI does, sending back the kinds it was given) writes the new spelling.
    const persona = store.getPersona("old-coder")!;
    assertEquals((await app.request("/api/personas/old-coder", jsonInit("PUT", { title: "Old coder", kinds: persona.kinds }))).status, 200);
    assertStringIncludes(fs.readFileSync(file, "utf8"), "kinds: [teammate]\n");
    // A save body still naming the old kind is normalized too.
    assertEquals((await (await app.request("/api/personas/old-coder", jsonInit("PUT", { kinds: ["worker"] }))).json()).persona.kinds, ["teammate"]);
    assertStringIncludes(fs.readFileSync(file, "utf8"), "kinds: [teammate]\n");
  });
});

// ─── ?kind=worker ────────────────────────────────────────────────────

test("GET /api/personas?kind=worker sorts exactly like kind=teammate, warning once", async () => {
  await withTeam({}, async ({ app, store }) => {
    store.createPersona({ title: "Zed triager", kinds: ["triage"], content: "Triage." });
    store.createPersona({ title: "Zz coder", kinds: ["teammate"], content: "Code." });
    const ids = async (kind: string) => (await (await app.request(`/api/personas?kind=${kind}`)).json()).personas.map((p: { id: string }) => p.id);
    const teammate = await ids("teammate");
    assertEquals(teammate.slice(0, 2), ["zz-coder", "builtin:teammate"], "hinted first");
    const logs = await captureWarnings(async () => {
      assertEquals(await ids("worker"), teammate);
      assertEquals(await ids("worker"), teammate);
    });
    assertEquals(logs, [KIND_WARNING]);
  });
});

// ─── builtin:worker ──────────────────────────────────────────────────

test("builtin:worker resolves to builtin:teammate, warning once", async () => {
  const logs = await captureWarnings(() => {
    assertEquals(getBuiltinPersona("builtin:worker")!.id, "builtin:teammate");
    assertEquals(getBuiltinPersona("builtin:worker")!.kinds, ["teammate"]);
    assertEquals(normalizePersonaId("builtin:worker"), "builtin:teammate");
    assertEquals(normalizePersonaId("reviewer"), "reviewer");
  });
  assertEquals(logs, [ID_WARNING]);
});

test("builtin:worker resolves wherever a persona id is read: workflow state, task, schedule, config, API", async () => {
  await withTeam({}, async ({ app, store }) => {
    resetPersonaAliasWarnings();
    // Workflow state.
    const wf = store.getWorkflows()["default"]!;
    const agentState = wf.states.find((s) => s.type === "teammate")!.name;
    store.saveWorkflow("default", { states: wf.states.map((s) => s.name === agentState ? { ...s, persona: "builtin:worker" } : s) });
    const st = store.resolveStatePersona("default", agentState)!;
    assertEquals([st.id, st.fallbackFrom, st.via], ["builtin:teammate", undefined, "workflow-state"]);

    // Task and schedule (accepted by the routes, which check the id resolves).
    const task = (await (await app.request("/api/work-defs", jsonInit("POST", { title: "T", goal: "g", persona: "builtin:worker", enqueue: false }))).json()).workDef;
    assertEquals(task.persona, "builtin:worker", "the stored reference is left as written");
    const t = store.resolveWorkPersona(store.getWorkDef(task.id)!)!;
    assertEquals([t.id, t.fallbackFrom, t.via], ["builtin:teammate", undefined, "task"]);
    const sched = (await (await app.request("/api/work-defs", jsonInit("POST", { title: "S", goal: "g", type: "Scheduled", cron: "0 3 * * *", persona: "builtin:worker" }))).json()).workDef;
    const s = store.resolveWorkPersona(store.getWorkDef(sched.id)!)!;
    assertEquals([s.id, s.fallbackFrom, s.via], ["builtin:teammate", undefined, "schedule"]);

    // Config (the assistant's persona).
    store.setAssistantPersonaId("builtin:worker");
    assertEquals(store.resolveAssistantPersona().id, "builtin:teammate");

    // The API reads it too, and "Used by" counts the old references as uses of the new id.
    assertEquals((await (await app.request(`/api/personas/${encodeURIComponent("builtin:worker")}`)).json()).persona.id, "builtin:teammate");
    const usedBy = store.getPersonaUsage("builtin:teammate");
    assertEquals(usedBy.some((u) => u.kind === "workflow-state" && u.state === agentState), true);
    assertEquals(usedBy.some((u) => u.kind === "assistant"), true);
    assertEquals(usedBy.filter((u) => u.kind === "workdef").length, 2);
  });
});

test("personaUsage: references to builtin:worker (sources, mirrors, triage) count for builtin:teammate", () => {
  const usedBy = personaUsage("builtin:teammate", {
    workflows: {},
    config: { triage: { persona: "builtin:worker" }, sourcePersonas: { jira: { persona: "builtin:worker" } } },
    workDefs: [],
    mirrorOverrides: [{ workDefId: "m1", source: "jira", persona: "builtin:worker" }],
  });
  assertEquals(usedBy, [
    { kind: "triage" },
    { kind: "mirror-override", workDefId: "m1", source: "jira" },
    { kind: "source-setting", source: "jira", field: "persona" },
  ]);
});

// ─── The UI ──────────────────────────────────────────────────────────

test("UI: an old builtin:worker reference shows as builtin:teammate, not missing or deleted", () => {
  const library = [{ id: "builtin:teammate" }, { id: "reviewer" }];
  assertEquals(currentPersonaId("builtin:worker"), "builtin:teammate");
  assertEquals(missingSelection("builtin:worker", library), null);
  const chip = personaChip({ id: "builtin:worker", title: "Worker (built-in)", origin: "builtin", via: "task" }, library);
  assertEquals([chip.deleted, chip.href, chip.label], [false, "/config/personas/builtin%3Ateammate", "Worker (built-in)"]);
});
