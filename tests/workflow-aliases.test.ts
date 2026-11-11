/**
 * tests/workflow-aliases.test.ts — The deprecated `agent` spelling of the
 * `teammate` workflow state type (DEPRECATED(worker→teammate): remove in
 * remove-worker-aliases, with daemon/workflow-aliases.ts).
 *
 * The alias keeps working and warns once per run: a `workflow.json` state with
 * `"type": "agent"` loads as `teammate` (the file isn't rewritten until it is
 * saved, which writes `teammate`), a write body (`PUT /api/config`) may still say
 * `agent`, and the state persona PUT works on such a state. `GET /api/workflows`
 * counts teammate states as `teammateCount`, with `agentCount` as a deprecated
 * duplicate. See docs/DESIGN.md "The Work Model".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assertEquals } from "./_assert.ts";
import { withTeam, jsonInit } from "./_team.ts";
import { normalizeWorkflowStateTypes, resetWorkflowAliasWarnings } from "../daemon/workflow-aliases.ts";
import { personaUsage } from "../daemon/personas/resolve.ts";
import { readPersonaUsageInput } from "../daemon/personas/usage-disk.ts";
import { canonicalWorkflowStateType } from "../shared/types.ts";

/** Run `fn` with console.warn captured (and the one-time warnings reset first). */
async function captureWarnings(fn: () => unknown | Promise<unknown>): Promise<string[]> {
  resetWorkflowAliasWarnings();
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

const WARNING = "[workflows] state type 'agent' is deprecated; use 'teammate'";

/** A legacy workflow.json: two `agent` states around a manual one. */
const LEGACY_RAW = JSON.stringify({
  states: [{ name: "build", type: "agent" }, { name: "review", type: "manual" }, { name: "ship", type: "agent" }],
}, null, 2) + "\n";

/**
 * Write `raw` as workflows/<name>/workflow.json and return its path. A canonical
 * `default` workflow goes beside it, since once workflows/ has any workflow the
 * built-in default no longer fills in (and the config's defaultWorkflow needs one).
 */
function writeWorkflowFile(teamDir: string, name: string, raw: string): string {
  const write = (n: string, text: string): string => {
    const file = path.join(teamDir, "workflows", n, "workflow.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  write("default", JSON.stringify({ states: [{ name: "in_progress", type: "teammate" }, { name: "review", type: "manual" }] }));
  return write(name, raw);
}

// ─── The pure map ────────────────────────────────────────────────────

test("canonicalWorkflowStateType: 'agent' maps to 'teammate', everything else is kept or null", () => {
  assertEquals(["agent", "teammate", "manual", "worker", 3, undefined].map(canonicalWorkflowStateType),
    ["teammate", "teammate", "manual", null, null, null]);
});

test("normalizeWorkflowStateTypes: maps 'agent' (warning once), leaves a canonical workflow untouched", async () => {
  const canonical = { states: [{ name: "a", type: "teammate" }, { name: "b", type: "manual" }] };
  const logs = await captureWarnings(() => {
    assertEquals(normalizeWorkflowStateTypes(JSON.parse(LEGACY_RAW)).states.map((s: { type: string }) => s.type), ["teammate", "manual", "teammate"]);
    assertEquals(normalizeWorkflowStateTypes({ states: [{ name: "x", type: "agent", persona: "p" }] }), { states: [{ name: "x", type: "teammate", persona: "p" }] });
    assertEquals(normalizeWorkflowStateTypes(canonical) === canonical, true, "nothing to map: the same object");
    // Not a workflow (or an unknown type): left for validateWorkflow to refuse.
    assertEquals(normalizeWorkflowStateTypes(null), null);
    assertEquals(normalizeWorkflowStateTypes({ states: [{ name: "x", type: "robot" }] }), { states: [{ name: "x", type: "robot" }] });
  });
  assertEquals(logs, [WARNING]);
});

// ─── workflow.json on disk ───────────────────────────────────────────

test("a workflow.json with type 'agent' loads as teammate, warns once, and isn't rewritten until saved", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    const file = writeWorkflowFile(teamDir, "legacy", LEGACY_RAW);
    const logs = await captureWarnings(async () => {
      store.reloadWorkflows();
      store.reloadWorkflows(); // a second load doesn't warn again
      assertEquals(store.getWorkflows()["legacy"]!.states.map((s) => s.type), ["teammate", "manual", "teammate"]);
      const body = await (await app.request("/api/workflows/legacy")).json();
      assertEquals(body.states[0].type, "teammate");
    });
    assertEquals(logs, [WARNING]);
    assertEquals(fs.readFileSync(file, "utf8"), LEGACY_RAW, "loading never rewrites the file");

    // Saving it (as the UI does: PUT /api/config with the workflows GET /api/config gave it) writes `teammate`.
    const config = await (await app.request("/api/config")).json();
    assertEquals(config.workflows.legacy.states[0].type, "teammate");
    assertEquals((await app.request("/api/config", jsonInit("PUT", config))).status, 200);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assertEquals(saved.states.map((s: { type: string }) => s.type), ["teammate", "manual", "teammate"]);
  });
});

test("GET /api/workflows counts teammate states (teammateCount, and the deprecated agentCount)", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    writeWorkflowFile(teamDir, "legacy", LEGACY_RAW);
    await captureWarnings(() => store.reloadWorkflows());
    const summaries = await (await app.request("/api/workflows")).json();
    const legacy = summaries.find((w: { name: string }) => w.name === "legacy");
    assertEquals(legacy, { name: "legacy", stateCount: 3, teammateCount: 2, agentCount: 2, manualCount: 1, isDefault: false });
  });
});

// ─── Writes ──────────────────────────────────────────────────────────

test("PUT /api/config accepts type 'agent' in a workflow and saves it as 'teammate'", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    const base = await (await app.request("/api/config")).json();
    const body = { ...base, workflows: { ...base.workflows, legacy: JSON.parse(LEGACY_RAW) } };
    const logs = await captureWarnings(async () => {
      assertEquals((await app.request("/api/config", jsonInit("PUT", body))).status, 200);
    });
    assertEquals(logs, [WARNING]);
    assertEquals(store.getWorkflows()["legacy"]!.states.map((s) => s.type), ["teammate", "manual", "teammate"]);
    const saved = JSON.parse(fs.readFileSync(path.join(teamDir, "workflows", "legacy", "workflow.json"), "utf8"));
    assertEquals(saved.states.map((s: { type: string }) => s.type), ["teammate", "manual", "teammate"]);
    // An unknown type is still refused, naming the new spelling.
    const bad = { ...base, workflows: { ...base.workflows, bad: { states: [{ name: "x", type: "robot" }] } } };
    const res = await app.request("/api/config", jsonInit("PUT", bad));
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, `Workflow "bad": State "x" needs type "teammate" or "manual"`);
  });
});

test("the state persona PUT works on an 'agent' state; the save writes 'teammate'", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    const file = writeWorkflowFile(teamDir, "legacy", LEGACY_RAW);
    await captureWarnings(() => store.reloadWorkflows());
    const res = await app.request("/api/workflows/legacy/states/build", jsonInit("PUT", { persona: "builtin:teammate" }));
    assertEquals(res.status, 200);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assertEquals(saved.states[0], { name: "build", type: "teammate", persona: "builtin:teammate" });
    assertEquals(saved.states[2].type, "teammate");
    // A manual state still has no persona.
    assertEquals((await app.request("/api/workflows/legacy/states/review", jsonInit("PUT", { persona: "builtin:teammate" }))).status, 400);
  });
});

test("'Used by' counts a persona on an 'agent' state read from disk", async () => {
  await withTeam({}, async ({ app, store, teamDir }) => {
    writeWorkflowFile(teamDir, "legacy", JSON.stringify({ states: [{ name: "build", type: "agent", persona: "builtin:triage" }] }));
    let usedBy: unknown;
    await captureWarnings(async () => {
      store.reloadWorkflows();
      usedBy = (await (await app.request("/api/personas/builtin:triage/usage")).json()).usedBy;
    });
    assertEquals((usedBy as Array<{ kind: string; workflow?: string }>).some((u) => u.kind === "workflow-state" && u.workflow === "legacy"), true);
    // The Store-less scan (`mpt plugins remove`'s in-use warning) reads the raw file the same way.
    const input = readPersonaUsageInput(teamDir, {});
    assertEquals(personaUsage("builtin:triage", input), [{ kind: "workflow-state", workflow: "legacy", state: "build" }]);
  });
});
