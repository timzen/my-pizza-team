/**
 * tests/e2e/demo-tracker.test.ts — the demo-tracker Work Source plugin, end to end.
 *
 * Ported from mpt-demo-team's run-e2e.sh ("Demo-tracker plugin", "Demo-tracker: a
 * triage-mode issue", "Demo-tracker: settings from the UI"). The demo team
 * (tests/fixtures/demo/team, tests/e2e/_demo.ts) loads
 * tests/fixtures/demo/plugins/mpt-source-demo-tracker in place from config.json;
 * its "external system" is a JSON file of issues in the sandbox.
 *
 *   - Mirror, enqueue, write-back: the plugin loads, its three open issues are
 *     mirrored and enqueued, a thread comment and a canceled run's outcome reach
 *     the tracker file, and the canceled issue can be run again.
 *   - Triage mode (DEMO-3, `"mode": "triage"`; docs/DESIGN.md "External sources"):
 *     claimed by an unregistered agent id, it gets the triage prompt with the
 *     per-source triage persona; a propose_work analysis is pending until accepted;
 *     accepting creates a task that links back and never runs; a finished triage
 *     leaves the issue open.
 *   - Settings from Config → Sources: GET /api/sources lists the schema and toggle;
 *     Preview with a draft shows what it would pull and mirrors nothing (an invalid
 *     draft is refused); Save rewrites config.json and re-initializes the plugin
 *     live; switching it off is refused while it has mirrors, a disconnect archives
 *     them and gates its routes, and nothing syncs while it's off; restoring the
 *     settings and switching it on brings DEMO-1..3 back.
 *
 * The fixture syncs every second (intervalSeconds: 1), so "no sync while off" is
 * proven by outlasting a few timer periods rather than run-e2e.sh's 12s sleep.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "../_assert.ts";
import { sandbox } from "./_sandbox.ts";
import { api, type Api, configForPut, demoTeam, type DemoTeam, itemPersona, type Json, readyItem, TRACKER } from "./_demo.ts";

/** Wait for the tracker issue's comments to include `text`. */
async function commentLands(sb: { waitFor: (c: () => boolean) => Promise<boolean> }, team: DemoTeam, id: string, text: string): Promise<boolean> {
  return await sb.waitFor(() => (team.issue(id).comments ?? []).some((c) => c.body.includes(text)));
}

/** The source's mirrors as `externalId` (active) or `externalId:status` (`all`). */
async function defs(a: Api, all = false): Promise<string[]> {
  const r = await a.get(`/api/sources/${TRACKER}/defs${all ? "?status=all" : ""}`);
  return (r.body.defs as Json[]).map((d) => all ? `${d.externalId}:${d.status}` : d.externalId).sort();
}

/** demo-tracker's entry on GET /api/sources. */
async function sourceView(a: Api): Promise<Json> {
  return ((await a.get("/api/sources")).body.sources as Json[]).find((s) => s.id === TRACKER);
}

/** Wait until the three fixture issues are mirrored with a READY run each. */
async function trackerReady(sb: { waitFor: (c: () => Promise<boolean>, t?: number) => Promise<boolean> }, a: Api): Promise<boolean> {
  return await sb.waitFor(async () =>
    ((await a.get(`/api/sources/${TRACKER}/defs`)).body.defs as Json[] ?? []).filter((d) => d.latestState === "READY").length >= 3, 15_000);
}

test("demo-tracker: loads, mirrors and enqueues its issues, and writes comments and outcomes back", async () => {
  await using sb = await sandbox("demo-tracker");
  const team = demoTeam(sb);
  await sb.startDaemon("source");
  const a = api(sb);

  const plugins = (await a.get("/api/sources")).body.plugins as Json[];
  const plugin = plugins.find((p) => p.sources.includes(TRACKER));
  assertEquals(plugin?.state, "loaded", JSON.stringify(plugins));

  assert(await trackerReady(sb, a), `tracker issues weren't mirrored + enqueued: ${JSON.stringify(await defs(a, true))}`);
  assertEquals(await defs(a), ["DEMO-1", "DEMO-2", "DEMO-3"]);

  // A thread comment is written back to the issue.
  assertEquals((await a.post(`/api/work-defs/${TRACKER}~DEMO-1/comment`, { from: "e2e", body: "e2e write-back check" })).status, 200);
  assert(await commentLands(sb, team, "DEMO-1", "e2e write-back check"), JSON.stringify(team.issue("DEMO-1")));

  // A canceled run's outcome is written back; the issue can be run again.
  const demo2 = await readyItem(a, `${TRACKER}~DEMO-2`);
  assert(demo2, "no READY run for DEMO-2");
  assertEquals((await a.post(`/api/work-items/${demo2}/cancel`)).status, 200);
  assert(await commentLands(sb, team, "DEMO-2", "ended CANCELED"), JSON.stringify(team.issue("DEMO-2")));
  assertEquals(team.issue("DEMO-2").status, "open", "a canceled run closed the issue");
  const rerun = await a.post(`/api/work-defs/${TRACKER}~DEMO-2/enqueue`);
  assert(rerun.status < 300, `re-running DEMO-2 failed: ${JSON.stringify(rerun.body)}`);
  assert(await readyItem(a, `${TRACKER}~DEMO-2`), "DEMO-2 wasn't re-queued");
});

test("demo-tracker: a triage-mode issue is triaged with the per-source persona, and its proposal accepted", async () => {
  await using sb = await sandbox("demo-triage");
  const team = demoTeam(sb);
  await sb.startDaemon("source");
  const a = api(sb);
  assert(await trackerReady(sb, a), "tracker issues weren't mirrored + enqueued");

  const def = `${TRACKER}~DEMO-3`;
  const triager = "e2e-triager";
  const mirror = ((await a.get(`/api/sources/${TRACKER}/defs`)).body.defs as Json[]).find((d) => d.id === def);
  assertEquals(mirror?.mode, "triage");
  const item = ((await a.get("/api/work-items?state=READY")).body.items as Json[]).find((i) => i.ref.workDefId === def);
  assert(item && String(item.title).startsWith("Triage: "), `no 'Triage: …' WorkItem for DEMO-3: ${JSON.stringify(item)}`);

  // Claimed as an unregistered agent (never a member): the triage prompt, with the triage persona.
  const claim = await a.post(`/api/agents/claim/${item.id}`, { agentId: triager });
  assertEquals(claim.status, 200, JSON.stringify(claim.body));
  const prompt = claim.body.prompt as string;
  for (const text of ["## Your Role: Triage", "You are the **tracker triager**", "DEMO-3", "due date"]) assertStringIncludes(prompt, text);
  assertEquals(await itemPersona(a, item.id), ["mpt-personas-demo/tracker-triager", "package:mpt-personas-demo", "source-setting"]);

  // A propose_work-style analysis, pending until someone decides.
  const proposed = await a.post(`/api/agents/work-items/${item.id}/proposals`, {
    agentId: triager,
    outcome: "proposals",
    body: "One small task covers it: an optional dueDate plus an overdue filter. No schedule needed yet.",
    proposals: [{
      id: "p1", kind: "task", title: "Add due dates and GET /todos?overdue=true",
      goal: "Accept an optional ISO dueDate on POST /todos and list overdue todos with ?overdue=true.",
      directory: sb.projectDir,
    }],
  });
  assertEquals(proposed.status, 200, JSON.stringify(proposed.body));
  const triage = async () => (await a.get(`/api/work-defs/${def}/triage`)).body;
  assertEquals([(await triage()).badge, (await triage()).pending.length], ["proposal", 1]);

  // Finishing the triage writes the outcome back and leaves the issue open.
  assertEquals((await a.post(`/api/agents/work-items/${item.id}/state`, { agentId: triager, state: "COMPLETE" })).status, 200);
  assert(await commentLands(sb, team, "DEMO-3", "ended COMPLETE"), JSON.stringify(team.issue("DEMO-3")));
  assertEquals(team.issue("DEMO-3").status, "open", "a finished triage closed the issue");

  // Accepting creates a task that links back to DEMO-3 — and never runs it.
  const accepted = await a.post(`/api/work-defs/${def}/triage/proposals/p1/accept`);
  const created = accepted.body?.decision?.workDefId as string | undefined;
  assert(created, `accepting created nothing: ${JSON.stringify(accepted.body)}`);
  const workdef = fs.readFileSync(path.join(sb.teamDir, "tasks", created, "workdef.md"), "utf8");
  assert(new RegExp(`originWorkDef: .*${def.replace("~", "\\~")}`).test(workdef), workdef);
  const createdRuns = ((await a.get("/api/work-items")).body.items as Json[]).filter((i) => i.ref.workDefId === created);
  assertEquals(createdRuns.length, 0, "accepting a proposal started its work");
  assertEquals([(await triage()).badge, (await triage()).pending.length], ["none", 0]);

  // Triage now: queued again.
  const again = await a.post(`/api/work-defs/${def}/enqueue`);
  assert(again.status < 300, JSON.stringify(again.body));
  assert(await readyItem(a, def), "DEMO-3 wasn't re-queued");
});

test("demo-tracker settings from Config → Sources: preview, save, switch off, disconnect, restore", async () => {
  await using sb = await sandbox("demo-settings");
  const team = demoTeam(sb);
  await sb.startDaemon("source");
  const a = api(sb);
  assert(await trackerReady(sb, a), "tracker issues weren't mirrored + enqueued");

  // A scratch copy of the tracker with one more issue, for the draft settings.
  const scratch = path.join(sb.root, "tracker", "e2e-scratch.json");
  const data = { issues: team.issues() };
  data.issues.push({ id: "E2E-1", title: "E2E settings check", body: "Mirrored only while demo-tracker points here.", status: "open", updatedAt: "2024-07-01T00:00:00Z", comments: [] });
  fs.writeFileSync(scratch, JSON.stringify(data, null, 2));

  // 1. GET /api/sources: a plugin source with its configSchema and its own toggle.
  const view = await sourceView(a);
  assertEquals(
    [view.kind, view.configScope, Object.keys(view.configSchema?.properties ?? {}).sort(), view.previewable, view.toggle],
    ["plugin", "package", ["directory", "file", "intervalSeconds", "mode", "urlBase"], true, { feature: TRACKER, enabled: true }],
  );
  const saved = view.options as Record<string, unknown>;
  const draft = { ...saved, file: "../../tracker/e2e-scratch.json" };

  // 2. Preview: what the draft would pull, and nothing mirrored; an invalid draft is refused.
  const before = await defs(a, true);
  const preview = await a.post(`/api/sources/${TRACKER}/preview`, { options: draft });
  assertEquals(
    [preview.body.success, preview.body.via, (preview.body.items as Json[]).map((i) => i.externalId).sort()],
    [true, "preview", ["DEMO-1", "DEMO-2", "DEMO-3", "E2E-1"]],
    JSON.stringify(preview.body),
  );
  assertEquals(await defs(a, true), before, "preview changed the mirrors");
  assertEquals((await a.post(`/api/sources/${TRACKER}/preview`, { options: { mode: "sometimes" } })).status, 400);

  // 3. Save: config.json rewritten, the plugin re-initialized live, the next sync mirrors E2E-1.
  const save = await a.put(`/api/sources/${TRACKER}/config`, { options: draft });
  assertEquals([save.body.success, save.body.reinit], [true, [{ id: TRACKER, ok: true }]], JSON.stringify(save.body));
  const packages = team.config().packages as Json[];
  assert(packages.some((p) => typeof p === "object" && p.config?.file === "../../tracker/e2e-scratch.json"), JSON.stringify(packages));
  await a.post(`/api/sources/${TRACKER}/sync`); // a 409 "in flight" is fine: the re-init's own sync is running
  assert(await sb.waitFor(async () => (await defs(a)).join(" ") === "DEMO-1 DEMO-2 DEMO-3 E2E-1", 10_000), `after Save: ${await defs(a)}`);
  // While on, the timer syncs every period — the window the "off" check below waits out.
  const lastOn = (await sourceView(a)).sync?.last?.at;
  assert(lastOn, JSON.stringify((await sourceView(a)).sync));
  assert(await sb.waitFor(async () => (await sourceView(a)).sync?.last?.at !== lastOn, 3500), "the 1s sync timer isn't running");

  // 4. Switching it off with active mirrors is refused; a disconnect archives them and switches it off.
  const off = await a.put("/api/config", { ...await configForPut(a), features: { [TRACKER]: false } });
  assertEquals(off.status, 409, JSON.stringify(off.body));
  const disconnect = await a.post(`/api/sources/${TRACKER}/disconnect`);
  assertEquals([disconnect.body.success, disconnect.body.feature, disconnect.body.archived?.length], [true, TRACKER, 4], JSON.stringify(disconnect.body));
  const mirrors = fs.readdirSync(path.join(sb.teamDir, "tasks")).filter((d) => d.startsWith(`${TRACKER}~`));
  const stillActive = mirrors.filter((d) => !/^status: archived/m.test(fs.readFileSync(path.join(sb.teamDir, "tasks", d, "workdef.md"), "utf8")));
  assertEquals(stillActive, [], "disconnect left active mirrors");
  assertEquals((await a.get(`/api/sources/${TRACKER}/defs`)).status, 403, "its Work routes aren't gated while it's off");
  assertEquals((await sourceView(a)).toggle.enabled, false);

  // While off, a new issue isn't pulled: a forced sync is refused, and the timer doesn't sync.
  const withE2E2 = JSON.parse(fs.readFileSync(scratch, "utf8"));
  withE2E2.issues.push({ id: "E2E-2", title: "Must not be pulled while off", status: "open", updatedAt: "2024-07-02T00:00:00Z", comments: [] });
  fs.writeFileSync(scratch, JSON.stringify(withE2E2, null, 2));
  const lastSync = (await sourceView(a)).sync?.last?.at ?? null;
  assert(lastSync !== null, "no last sync recorded");
  assert((await a.post(`/api/sources/${TRACKER}/sync`)).status !== 200, "a switched-off demo-tracker still synced");
  // Three sync periods (intervalSeconds: 1): a timer sync would have moved `last.at`.
  const synced = await sb.waitFor(async () => ((await sourceView(a)).sync?.last?.at ?? null) !== lastSync, 3500);
  assertEquals(synced, false, "demo-tracker synced while switched off");
  assertEquals(fs.existsSync(path.join(sb.teamDir, "tasks", `${TRACKER}~E2E-2`)), false, "E2E-2 was pulled while off");

  // 5. Restore: the fixture settings, switched back on; DEMO-1..3 come back and can be re-queued.
  const restore = await a.put(`/api/sources/${TRACKER}/config`, { options: saved });
  assertEquals(restore.body.success, true, JSON.stringify(restore.body));
  const on = await a.put("/api/config", { ...await configForPut(a), features: { [TRACKER]: true } });
  assertEquals(on.status, 200, JSON.stringify(on.body));
  await a.post(`/api/sources/${TRACKER}/sync`);
  assert(await sb.waitFor(async () => (await defs(a)).join(" ") === "DEMO-1 DEMO-2 DEMO-3", 10_000), `after switching back on: ${await defs(a)}`);
  for (const issue of ["DEMO-1", "DEMO-2", "DEMO-3"]) {
    const r = await a.post(`/api/work-defs/${TRACKER}~${issue}/enqueue`);
    assert(r.status < 300, `re-queuing ${issue}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert((await defs(a, true)).includes("E2E-1:archived"), `E2E-1 should stay archived: ${await defs(a, true)}`);
});
