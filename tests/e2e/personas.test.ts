/**
 * tests/e2e/personas.test.ts — the demo team's persona library, persona packages,
 * and the personas each tracker item runs with.
 *
 * Ported from mpt-demo-team's run-e2e.sh ("Personas: the library, packages, and
 * the tracker's personas"); docs/DESIGN.md "Personas: One Library, Selected by
 * Reference". The demo team (tests/fixtures/demo/team, tests/e2e/_demo.ts) has one
 * team persona (demo-coder, selected by the in_progress state), two packages
 * shipping personas (mpt-personas-demo: personas only; the demo-tracker: its own
 * tracker-worker, its defaultPersona), a Solitary task with a package persona, and a
 * per-source triage persona for the tracker (config.json sourcePersonas).
 *
 *   - The library lists built-in, team and package personas; package ones are
 *     read-only (duplicate to edit); a persona in use can't be deleted; "Used by"
 *     names the state, the task and the source; GET /api/sources shows the
 *     tracker's default and triage personas.
 *   - Each tracker item's run gets the persona its chain selects, in its prompt and
 *     recorded on the WorkItem: DEMO-1 a per-item override ("workdef"), DEMO-2 the
 *     source's default ("source-default"). The override survives a re-sync of a
 *     reopened issue, and a finished run keeps the persona it ran with. (DEMO-3's
 *     "source-setting" triage persona is in demo-tracker.test.ts.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";
import { sandbox } from "./_sandbox.ts";
import { api, type Api, demoTeam, itemPersona, type Json, readyItem, TRACKER } from "./_demo.ts";

const REVIEWER = "mpt-personas-demo%2Fcareful-reviewer";
const IMPLEMENTER = "mpt-personas-demo/careful-implementer";

/** A persona's "Used by", as sorted `kind:what` strings. */
async function usedBy(a: Api, id: string): Promise<string[]> {
  const usage = (await a.get(`/api/personas/${id}`)).body.usedBy as Json[];
  return usage.map((u) => `${u.kind}:${u.state ?? u.workDefId ?? u.source ?? ""}`).sort();
}

test("personas: the library lists team, built-in and package personas; package ones are read-only; Used by", async () => {
  await using sb = await sandbox("demo-personas");
  demoTeam(sb);
  await sb.startDaemon("source");
  const a = api(sb);

  const library = ((await a.get("/api/personas")).body.personas as Json[]).map((p) => `${p.id}:${p.origin.kind}:${p.readOnly}`).sort();
  assertEquals(library, [
    "builtin:assistant:builtin:true",
    "builtin:teammate:builtin:true",
    "builtin:triage:builtin:true",
    "demo-coder:team:false",
    "mpt-personas-demo/careful-implementer:package:true",
    "mpt-personas-demo/careful-reviewer:package:true",
    "mpt-personas-demo/tracker-triager:package:true",
    "mpt-source-demo-tracker/tracker-worker:package:true",
  ]);
  // The demo's personas say `kinds: [teammate]`, except tracker-worker, which keeps the deprecated
  // `kinds: [worker]` on purpose (DEPRECATED(worker→teammate): remove in remove-worker-aliases): it loads as teammate too.
  const kinds = Object.fromEntries(((await a.get("/api/personas")).body.personas as Json[]).map((p) => [p.id, p.kinds]));
  assertEquals([kinds["demo-coder"], kinds["mpt-personas-demo/careful-implementer"], kinds["mpt-source-demo-tracker/tracker-worker"]],
    [["teammate"], ["teammate"], ["teammate"]]);
  const plugins = (await a.get("/api/sources")).body.plugins as Json[];
  const personasOnly = plugins.filter((p) => String(p.spec).endsWith("mpt-personas-demo")).map((p) => [p.state, p.sources.length, p.personas.length]);
  assertEquals(personasOnly, [["loaded", 0, 3]], "mpt-personas-demo should load as a persona-only package");

  // Package personas are read-only: edit and delete refused; a duplicate is an editable team copy.
  assertEquals((await a.put(`/api/personas/${REVIEWER}`, { content: "edited" })).status, 409);
  assertEquals((await a.del(`/api/personas/${REVIEWER}`)).status, 409);
  const copy = (await a.post(`/api/personas/${REVIEWER}/duplicate`, {})).body.persona;
  assertEquals([copy.id, copy.readOnly, copy.duplicatedFrom], ["careful-reviewer", false, "mpt-personas-demo/careful-reviewer"]);
  assertEquals((await a.del("/api/personas/careful-reviewer")).status, 200);
  // A persona in use can't be deleted.
  assertEquals((await a.del("/api/personas/demo-coder")).status, 409);

  assertEquals(await usedBy(a, "demo-coder"), ["workflow-state:in_progress"]);
  assertEquals(await usedBy(a, REVIEWER), ["workdef:audit-project-dependencies"]);
  assertEquals(await usedBy(a, "mpt-personas-demo%2Ftracker-triager"), [`source-setting:${TRACKER}`]);
  const tracker = ((await a.get("/api/sources")).body.sources as Json[]).find((s) => s.id === TRACKER);
  assertEquals(
    [tracker.defaultPersona, tracker.triagePersona, tracker.personaError ?? null],
    ["mpt-source-demo-tracker/tracker-worker", "mpt-personas-demo/tracker-triager", null],
  );
  assertEquals(fs.existsSync(path.join(sb.teamDir, "context.migrated")), false, "the persona-layout fixture was migrated");
});

test("personas: each tracker item's run gets its chain's persona — per-item override, source default — kept across a re-sync", async () => {
  await using sb = await sandbox("demo-item-personas");
  const team = demoTeam(sb);
  await sb.startDaemon("source");
  const a = api(sb);
  const agent = "e2e-persona-check";
  assert(await sb.waitFor(async () => !!(await readyItem(a, `${TRACKER}~DEMO-1`)) && !!(await readyItem(a, `${TRACKER}~DEMO-2`)), 15_000), "tracker issues weren't enqueued");

  // A per-item override naming a missing persona is refused; a real one is set.
  assertEquals((await a.put(`/api/work-defs/${TRACKER}~DEMO-1/persona`, { persona: "no-such-persona" })).status, 400);
  assertEquals((await a.put(`/api/work-defs/${TRACKER}~DEMO-1/persona`, { persona: IMPLEMENTER })).status, 200);

  /** Claim the issue's READY run, check its prompt and recorded persona, complete it. */
  const claimCheck = async (issue: string, text: string, persona: [string, string, string]): Promise<string> => {
    const item = await readyItem(a, `${TRACKER}~${issue}`);
    assert(item, `no READY WorkItem for ${issue}`);
    const claim = await a.post(`/api/agents/claim/${item}`, { agentId: agent });
    assertEquals(claim.status, 200, JSON.stringify(claim.body));
    const prompt = claim.body.prompt as string;
    assert(prompt.startsWith("## Your Role"), prompt.slice(0, 200));
    assertStringIncludes(prompt, text);
    assertEquals(await itemPersona(a, item), persona, `${issue}'s recorded persona`);
    assertEquals((await a.post(`/api/agents/work-items/${item}/state`, { agentId: agent, state: "COMPLETE" })).status, 200);
    return item;
  };
  const demo1Run = await claimCheck("DEMO-1", "You are a **careful implementer**", [IMPLEMENTER, "package:mpt-personas-demo", "workdef"]);
  await claimCheck("DEMO-2", "You are working an issue from the **Demo Tracker**",
    ["mpt-source-demo-tracker/tracker-worker", "package:mpt-source-demo-tracker", "source-default"]);

  // Both completions are written back; reopen them (a new revision) and sync: both queued again.
  assert(await sb.waitFor(() => team.issue("DEMO-1").status === "done" && team.issue("DEMO-2").status === "done"),
    JSON.stringify(team.issues().map((i) => [i.id, i.status])));
  team.editTracker((data) => {
    for (const issue of data.issues) {
      if (issue.id === "DEMO-1" || issue.id === "DEMO-2") {
        issue.status = "open";
        issue.updatedAt = issue.updatedAt!.replace("2024-06-01", "2024-06-02");
      }
    }
  });
  await a.post(`/api/sources/${TRACKER}/sync`);
  assert(await sb.waitFor(async () => !!(await readyItem(a, `${TRACKER}~DEMO-1`)) && !!(await readyItem(a, `${TRACKER}~DEMO-2`)), 15_000),
    "reopened DEMO-1/DEMO-2 weren't queued again");
  const mirror = (await a.get(`/api/work-defs/${TRACKER}~DEMO-1`)).body.workDef.mirror;
  assertEquals(mirror.personaOverride, IMPLEMENTER, "DEMO-1's override didn't survive the re-sync");
  // The finished run keeps the persona it ran with.
  assertEquals(await itemPersona(a, demo1Run), [IMPLEMENTER, "package:mpt-personas-demo", "workdef"]);
});
