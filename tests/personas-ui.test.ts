/**
 * tests/personas-ui.test.ts — The UI's persona rules (ui/src/lib/personas.ts):
 * routes (ids encoded, package ids with `/`), origin badges, the library list's
 * filter and tag chips, picker grouping by kind hint and the flagged missing
 * selection, "Used by" labels/links and delete protection, the in-flight chip
 * (linked, or "deleted" and unlinked; fallback noted), and a source's
 * effective personas. See docs/DESIGN.md "Personas: One Library, Selected by
 * Reference".
 */

import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import {
  deleteBlockedReason, effectiveSourcePersonas, filterPersonas, missingSelection, optionLabel, originLabel, parseTags,
  personaChip, personaIdFromConfigPath, personaPath, personaTagCounts, pickerGroups, readOnlyReason, refOriginLabel,
  slugHint, usageHref, usageLabel, viaLabel, type Persona, type PersonaUsage,
} from "../ui/src/lib/personas.ts";

function persona(over: Partial<Persona> = {}): Persona {
  return { id: "reviewer", title: "Reviewer", description: "", tags: [], content: "", origin: { kind: "team" }, readOnly: false, ...over };
}

const TEAM = persona({ id: "reviewer", title: "Reviewer", tags: ["coding", "review"], kinds: ["worker"], description: "Checks the diff" });
const TRIAGER = persona({ id: "notes-triage", title: "Notes triage", tags: ["notes"], kinds: ["triage"], content: "Lean toward work." });
const BUILTIN = persona({ id: "builtin:worker", title: "Worker", origin: { kind: "builtin" }, readOnly: true });
const PKG = persona({ id: "@acme/mpt-personas/jira-worker", title: "Jira worker", tags: ["coding"], origin: { kind: "package", name: "@acme/mpt-personas", identity: "npm:@acme/mpt-personas" }, readOnly: true });
const LIBRARY = [TEAM, TRIAGER, BUILTIN, PKG];

test("personaPath / personaIdFromConfigPath: encoded ids round-trip, package ids included", () => {
  assertEquals(personaPath("reviewer"), "/config/personas/reviewer");
  assertEquals(personaPath("builtin:worker"), "/config/personas/builtin%3Aworker");
  assertEquals(personaPath(PKG.id), "/config/personas/%40acme%2Fmpt-personas%2Fjira-worker");
  for (const p of LIBRARY) assertEquals(personaIdFromConfigPath(personaPath(p.id)), p.id);
  // A hand-typed package id with raw slashes is the rest of the path.
  assertEquals(personaIdFromConfigPath("/config/personas/mpt-pack/reviewer"), "mpt-pack/reviewer");
  assertEquals(personaIdFromConfigPath("/config/personas"), null);
  assertEquals(personaIdFromConfigPath("/config/personas/"), null);
  assertEquals(personaIdFromConfigPath("/config/workflows/x"), null);
});

test("originLabel / refOriginLabel / readOnlyReason: team, built-in, the package's name", () => {
  assertEquals(LIBRARY.map((p) => originLabel(p.origin)), ["team", "team", "built-in", "@acme/mpt-personas"]);
  assertEquals(["team", "builtin", "package:mpt-pack"].map(refOriginLabel), ["team", "built-in", "mpt-pack"]);
  assertEquals(readOnlyReason(TEAM), null);
  assert(readOnlyReason(BUILTIN)!.includes("Built into MPT"));
  assert(readOnlyReason(PKG)!.includes("@acme/mpt-personas package"));
  assert(readOnlyReason(PKG)!.includes("Duplicate"));
});

test("parseTags / personaTagCounts / slugHint", () => {
  assertEquals(parseTags(" coding, review,, coding ,"), ["coding", "review"]);
  assertEquals(parseTags(""), []);
  assertEquals(personaTagCounts(LIBRARY), [["coding", 2], ["notes", 1], ["review", 1]]);
  assertEquals(slugHint("Careful Reviewer!"), "careful-reviewer");
  assertEquals(slugHint("  "), "");
});

test("filterPersonas: tag chip plus text over id, title, description, body, tags and origin", () => {
  const ids = (q: string, tag: string | null = null) => filterPersonas(LIBRARY, q, tag).map((p) => p.id);
  assertEquals(ids(""), LIBRARY.map((p) => p.id));
  assertEquals(ids("", "coding"), ["reviewer", PKG.id]);
  assertEquals(ids("diff"), ["reviewer"], "description");
  assertEquals(ids("lean toward"), ["notes-triage"], "body");
  assertEquals(ids("built-in"), ["builtin:worker"], "origin badge text");
  assertEquals(ids("acme"), [PKG.id], "package name");
  assertEquals(ids("WORKER"), ["builtin:worker", PKG.id], "case-insensitive, id and title");
  assertEquals(ids("review", "notes"), []);
});

test("pickerGroups / optionLabel: hinted first, the rest after, exclusions dropped", () => {
  const g = pickerGroups(LIBRARY, "triage");
  assertEquals(g.hinted.map((p) => p.id), ["notes-triage"]);
  assertEquals(g.rest.map((p) => p.id), ["reviewer", "builtin:worker", PKG.id]);
  const none = pickerGroups(LIBRARY, undefined, ["builtin:worker"]);
  assertEquals([none.hinted.length, none.rest.map((p) => p.id)], [0, ["reviewer", "notes-triage", PKG.id]]);
  assertEquals(optionLabel(TEAM), "Reviewer");
  assertEquals(optionLabel(BUILTIN), "Worker (built-in)");
  assertEquals(optionLabel({ ...BUILTIN, title: "Worker (built-in)" }), "Worker (built-in)", "not said twice");
  assertEquals(optionLabel(PKG), "Jira worker (@acme/mpt-personas)");
});

test("missingSelection: a selected id the library lacks is flagged (not while loading)", () => {
  assertEquals(missingSelection("gone", LIBRARY), "gone");
  assertEquals(missingSelection("reviewer", LIBRARY), null);
  assertEquals(missingSelection(null, LIBRARY), null);
  assertEquals(missingSelection("", LIBRARY), null);
  assertEquals(missingSelection("gone", null), null);
});

test("usageLabel / usageHref: each reference names itself and links to where it's set", () => {
  const cases: Array<[PersonaUsage, string, string]> = [
    [{ kind: "workflow-state", workflow: "default", state: "review" }, "Workflow default — state review", "/config/workflows/default"],
    [{ kind: "triage" }, "Note triage", "/config/triage"],
    [{ kind: "assistant" }, "The assistant", "/config"],
    [{ kind: "workdef", workDefId: "wd 1", title: "Nightly" }, "Task “Nightly”", "/work-defs/wd%201"],
    [{ kind: "mirror-override", workDefId: "ext-1", source: "jira" }, "Item ext-1 from jira (override)", "/work-defs/ext-1"],
    [{ kind: "source-setting", source: "jira", field: "triagePersona" }, "Source jira — triage persona", "/config/sources/jira"],
    [{ kind: "source-setting", source: "jira", field: "persona" }, "Source jira — work persona", "/config/sources/jira"],
  ];
  for (const [u, label, href] of cases) {
    assertEquals(usageLabel(u), label);
    assertEquals(usageHref(u), href);
  }
});

test("deleteBlockedReason: read-only never; a team persona only when unused", () => {
  assert(deleteBlockedReason(BUILTIN, []) !== null);
  assert(deleteBlockedReason(PKG, null) !== null);
  assertEquals(deleteBlockedReason(TEAM, []), null);
  assertEquals(deleteBlockedReason(TEAM, undefined), null);
  assert(deleteBlockedReason(TEAM, [{ kind: "triage" }])!.includes("In use by 1 thing"));
  assert(deleteBlockedReason(TEAM, [{ kind: "triage" }, { kind: "assistant" }])!.includes("2 things"));
});

test("personaChip: the recorded title, linked; 'deleted' and unlinked once gone; fallback noted", () => {
  const ref = { id: "reviewer", title: "Reviewer (old name)", origin: "team", via: "workflow-state" as const };
  const live = personaChip(ref, LIBRARY);
  assertEquals([live.label, live.href, live.deleted], ["Reviewer (old name)", "/config/personas/reviewer", false]);
  assert(live.title.includes("from the workflow state"));
  assert(live.title.includes("(team)"));

  const gone = personaChip({ ...ref, id: "gone", title: "Gone" }, LIBRARY);
  assertEquals([gone.label, gone.href, gone.deleted], ["Gone (deleted)", null, true]);
  assert(gone.title.includes("deleted"));

  // While the library loads, assume it's there (no flash of "deleted").
  assertEquals(personaChip({ ...ref, id: "gone" }, null).href, "/config/personas/gone");

  const fallback = personaChip({ id: "builtin:worker", title: "Worker", origin: "builtin", via: "task", fallbackFrom: "reviewr" }, LIBRARY);
  assertEquals(fallback.href, "/config/personas/builtin%3Aworker");
  assert(fallback.title.includes("stands in for missing “reviewr”"));
  assert(fallback.title.includes("(built-in)"));

  const pkg = personaChip({ id: PKG.id, title: "Jira worker", origin: "package:@acme/mpt-personas", via: "source-default" }, LIBRARY);
  assert(pkg.title.includes("(@acme/mpt-personas)"));
  assert(pkg.title.includes("its source's default"));
});

test("viaLabel: every way a run can choose its persona has words", () => {
  for (const v of ["workflow-state", "task", "schedule", "workdef", "source-setting", "source-default", "triage", "assistant"] as const) {
    assert(viaLabel(v).length > 0, v);
  }
});

test("effectiveSourcePersonas: the team's setting, else the declared default, else none", () => {
  const base = { persona: null, defaultPersona: null, triagePersona: null, defaultTriagePersona: null };
  assertEquals(effectiveSourcePersonas(base), { work: null, triage: null });
  assertEquals(effectiveSourcePersonas({ ...base, defaultPersona: "pkg/w", defaultTriagePersona: "builtin:triage" }), {
    work: { id: "pkg/w", from: "declared" }, triage: { id: "builtin:triage", from: "declared" },
  });
  assertEquals(effectiveSourcePersonas({ ...base, persona: "reviewer", defaultPersona: "pkg/w", triagePersona: "t" }), {
    work: { id: "reviewer", from: "setting" }, triage: { id: "t", from: "setting" },
  });
});
