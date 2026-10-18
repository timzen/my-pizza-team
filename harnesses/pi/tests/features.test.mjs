// Feature toggles on the Pi side (src/features.ts): which leader tools stay
// active for a team's `config.features`, and the prompt note naming what's off.
//
// The tools are registered once; these tests drive applyFeatureTools against a
// fake `pi` that records setActiveTools, the same calls the leader makes on
// session start, before each run, and on its status poll.
//
// Run: node --test --experimental-strip-types tests/features.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const {
  FEATURE_TOOLS, ANY_FEATURE_TOOLS, gatedToolNames, activeToolsFor, applyFeatureTools,
  featurePromptNote, featureForProposalKind,
} = await import("../src/features.ts");
const { featuresFromStatus, featureDisabledMessage, ALL_FEATURES_ON } = await import("../src/runtime/client.ts");

/** Every tool registerLeaderTools registers (kept in sync by the source check below). */
const LEADER_TOOLS = [
  "create_story", "edit_story", "add_task", "create_task", "create_schedule", "set_schedule_pending", "get_task", "edit_task",
  "activate_task", "list_workflows", "list_context", "team_status", "list_thought_groups", "list_thoughts",
  "get_thought", "create_thought", "edit_thought", "archive_thought", "group_thoughts",
];
const ALWAYS = ["team_status", "list_thought_groups", "list_thoughts", "get_thought", "create_thought", "edit_thought", "archive_thought", "group_thoughts"];

/** A fake ExtensionAPI with Pi's semantics: registering activates; setActiveTools ignores unknown names. */
function fakePi(extra = ["read", "bash"]) {
  const registered = [...extra, ...LEADER_TOOLS];
  let active = [...registered];
  const sets = [];
  return {
    sets,
    get active() { return active; },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((name) => ({ name })),
    setActiveTools: (names) => { sets.push(names); active = names.filter((n) => registered.includes(n)); },
  };
}

const on = (over) => ({ ...ALL_FEATURES_ON, ...over });

test("every gated tool is a real leader tool", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/tools.ts"), "utf-8");
  for (const t of LEADER_TOOLS) assert.ok(src.includes(`name: "${t}"`), t);
  for (const t of gatedToolNames()) assert.ok(LEADER_TOOLS.includes(t), t);
});

test("all on: nothing changes, and setActiveTools isn't called", () => {
  const pi = fakePi();
  assert.equal(applyFeatureTools(pi, ALL_FEATURES_ON), false);
  assert.equal(pi.sets.length, 0);
});

test("tasks only (a new team): story and schedule tools go, create_task and the pending tools stay", () => {
  const pi = fakePi();
  assert.equal(applyFeatureTools(pi, on({ stories: false, schedules: false })), true);
  for (const t of [...FEATURE_TOOLS.stories, ...FEATURE_TOOLS.schedules]) assert.ok(!pi.active.includes(t), t);
  for (const t of ["create_task", ...ANY_FEATURE_TOOLS, ...ALWAYS, "read", "bash"]) assert.ok(pi.active.includes(t), t);
});

test("stories off alone removes create_story / edit_story / add_task / list_workflows", () => {
  const pi = fakePi();
  applyFeatureTools(pi, on({ stories: false }));
  for (const t of ["create_story", "edit_story", "add_task", "list_workflows"]) assert.ok(!pi.active.includes(t), t);
  assert.ok(pi.active.includes("create_task") && pi.active.includes("create_schedule"));
});

test("all off leaves Thoughts, status and non-team tools; the WorkDef tools go too", () => {
  const pi = fakePi();
  applyFeatureTools(pi, { stories: false, tasks: false, schedules: false });
  assert.deepEqual([...pi.active].sort(), [...ALWAYS, "read", "bash"].sort());
});

test("turning a feature back on re-activates its tools", () => {
  const pi = fakePi();
  applyFeatureTools(pi, { stories: false, tasks: false, schedules: false });
  applyFeatureTools(pi, on({ stories: false }));
  assert.ok(pi.active.includes("create_task") && pi.active.includes("get_task"));
  assert.ok(!pi.active.includes("create_story"));
  applyFeatureTools(pi, ALL_FEATURES_ON);
  for (const t of LEADER_TOOLS) assert.ok(pi.active.includes(t), t);
});

test("doesn't re-activate an ungated tool someone else turned off, nor add unregistered ones", () => {
  // A teammate-like session has none of the leader tools registered.
  assert.deepEqual(activeToolsFor(["read"], ALL_FEATURES_ON, ["read", "bash"]), ["read"]);
});

test("featurePromptNote is empty when all on and names what's off otherwise", () => {
  assert.equal(featurePromptNote(ALL_FEATURES_ON), "");
  const note = featurePromptNote(on({ stories: false, schedules: false }));
  assert.match(note, /Stories, Schedules/);
  assert.match(note, /features\.stories, features\.schedules/);
  assert.doesNotMatch(note, /Tasks/);
  assert.match(featurePromptNote({ stories: false, tasks: false, schedules: false }), /Thoughts/);
});

test("proposal kinds map like the daemon's featureForProposalKind", () => {
  assert.equal(featureForProposalKind("task"), "tasks");
  assert.equal(featureForProposalKind("story"), "stories");
  assert.equal(featureForProposalKind("story-task"), "stories");
  assert.equal(featureForProposalKind("schedule"), "schedules");
  assert.equal(featureForProposalKind("nonsense"), null);
});

test("featuresFromStatus: absent (older daemon) or missing flags mean on", () => {
  assert.deepEqual(featuresFromStatus({}), ALL_FEATURES_ON);
  assert.deepEqual(featuresFromStatus(null), ALL_FEATURES_ON);
  assert.deepEqual(featuresFromStatus({ features: { stories: false } }), on({ stories: false }));
});

test("featureDisabledMessage says how to turn it back on", () => {
  assert.equal(featureDisabledMessage("stories"), "Stories are disabled — enable them in Config (features.stories)");
});

test("tools.ts: propose_work refuses disabled kinds, team_status hides disabled counts", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/tools.ts"), "utf-8");
  assert.ok(src.includes("disabledProposalFeatures(client"));
  assert.ok(src.includes("if (features.stories)"));
});

test("leader.ts applies the toggles at startup, before each run, and on the status poll", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/leader.ts"), "utf-8");
  assert.ok(src.includes("await syncFeatures();\n"), "startup sync");
  assert.match(src, /before_agent_start[\s\S]*?await syncFeatures\(\)[\s\S]*?featurePromptNote\(features\)/);
  assert.match(src, /updateWidget = async[\s\S]*?adoptFeatures\(featuresFromStatus\(status\)\)/);
});
