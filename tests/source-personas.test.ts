/**
 * tests/source-personas.test.ts — Work Source personas: which persona a
 * mirrored item runs with, the per-source and per-mirror settings, and the
 * triage-mode requirement. See docs/DESIGN.md "Work Source personas: default +
 * per-WorkDef override".
 *
 * Covers: the pure chain (daemon/sources/persona.ts); a work-mode mirror's
 * prompt and claim snapshot at each link — none, the source's `defaultPersona`,
 * the per-source setting (`PUT /api/sources/:id/persona`), the item's
 * suggestion (`ExternalDef.persona`), and a person's override (`PUT
 * /api/work-defs/:id/persona`, which survives a re-sync) — and the fallback for
 * a stale id; `GET /api/sources`' persona fields and the route's validation
 * (and that it never re-inits the source); a triage-mode source without a
 * triage persona not syncing until one is set, and the team's note-triage
 * persona not standing in; a work-mode source's triage item held (and Run
 * refused) until one is set; the startup seed for triage plugins (migration
 * step 3) and the declared-persona warnings; "Used by" for source settings
 * and mirror overrides.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { TEST_CONFIG } from "./_config.ts";
import { Store } from "../daemon/store.ts";
import { buildApp } from "../daemon/server.ts";
import { FixtureSource, type FixtureSourceOptions } from "../daemon/sources/fixture.ts";
import { mirroredWorkDefId } from "../daemon/sources/mirror.ts";
import { mirrorPersonaKey, mirrorPersonaPick, sourcePersonaPick, triagePersonaProblem } from "../daemon/sources/persona.ts";
import { fileSourceKv } from "../daemon/store/source-kv.ts";
import { DEFAULT_TRIAGE_INSTRUCTIONS } from "../daemon/prompt.ts";
import type { TeamConfig } from "../shared/types.ts";
import type { SourceView } from "../shared/protocol.ts";

const SOURCE = "jira";
const json = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A team with the fixture source registered as `jira`; `source` adds its options (mode, personas). */
function setup(source: Partial<FixtureSourceOptions> = {}, configOverride: Partial<TeamConfig> = {}) {
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpt-source-personas-"));
  fs.mkdirSync(path.join(teamDir, "stories"), { recursive: true });
  const folder = path.join(teamDir, "external");
  fs.mkdirSync(folder);
  // Cloned: the per-source setting is written into the Store's config object.
  const config: TeamConfig = { ...structuredClone(TEST_CONFIG), ...configOverride };
  const store = new Store(teamDir, config);
  let inits = 0;
  const fixture = new FixtureSource({ dir: folder, id: SOURCE, label: "Jira", syncEveryMs: null, ...source });
  Object.assign(fixture, { init: () => { inits++; } });
  store.registerWorkSource(fixture);
  const app = buildApp(store, config, teamDir);
  store.registerMember("a1", "swift-neo", "/tmp");
  const persona = (id: string, title: string, content: string) => assertEquals(store.createPersona({ id, title, content }).ok, true);
  return {
    store, app, teamDir, folder, config, persona, inits: () => inits,
    cleanup: () => { store.close(); fs.rmSync(teamDir, { recursive: true, force: true }); },
  };
}

function writeItem(folder: string, externalId: string, title: string, extra: { mode?: string; persona?: string; goal?: string } = {}): void {
  const fm = [`title: ${title}`];
  if (extra.mode) fm.push(`mode: ${extra.mode}`);
  if (extra.persona) fm.push(`persona: ${extra.persona}`);
  fs.writeFileSync(path.join(folder, `${externalId}.md`), `---\n${fm.join("\n")}\n---\n## Goal\n\n${extra.goal ?? "Fix it."}\n`);
}

type App = ReturnType<typeof buildApp>;

/** Claim the READY item for `defId` as a1: its prompt and the recorded persona. */
async function claim(app: App, store: Store, defId: string) {
  const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === defId);
  assert(item, `a READY item for ${defId}`);
  const body = await (await app.request(`/api/agents/claim/${item.id}`, json("POST", { agentId: "a1" }))).json();
  assertEquals(body.success, true);
  return { prompt: body.prompt as string, persona: store.getWorkItem(item.id)!.persona };
}

/** Finish the in-flight item for `defId` so the next revision can enqueue. */
function finish(store: Store, defId: string): void {
  const item = store.getWorkItems({ states: ["IN_PROGRESS"] }).items.find((wi) => wi.ref.workDefId === defId);
  if (item) store.setWorkItemState(item.id, "COMPLETE");
}

/** Wait for a sync the daemon kicked off itself (fire-and-forget) to finish. */
async function settled(store: Store): Promise<void> {
  for (let i = 0; i < 200 && store.getSyncStatus(SOURCE).running; i++) await new Promise((r) => setTimeout(r, 5));
}

async function sourceView(app: App): Promise<SourceView> {
  const { sources } = await (await app.request("/api/sources")).json() as { sources: SourceView[] };
  return sources.find((s) => s.id === SOURCE)!;
}

// ─── The chain (pure) ────────────────────────────────────────────────

test("chain: override → suggestion → per-source setting → declared → none, per mode", () => {
  const source = { defaultPersona: "declared-work", triagePersona: "declared-triage" };
  const setting = { persona: "team-work", triagePersona: "team-triage" };
  assertEquals(mirrorPersonaPick({ mode: "work", override: "mine", suggestion: "theirs", setting, source }), { ref: "mine", via: "workdef" });
  assertEquals(mirrorPersonaPick({ mode: "work", suggestion: "theirs", setting, source }), { ref: "theirs", via: "workdef" });
  assertEquals(mirrorPersonaPick({ mode: "work", setting, source }), { ref: "team-work", via: "source-setting" });
  assertEquals(mirrorPersonaPick({ mode: "triage", setting, source }), { ref: "team-triage", via: "source-setting" });
  assertEquals(mirrorPersonaPick({ mode: "work", source }), { ref: "declared-work", via: "source-default" });
  assertEquals(mirrorPersonaPick({ mode: "triage", source }), { ref: "declared-triage", via: "source-default" });
  assertEquals(mirrorPersonaPick({ mode: "work", override: " ", source: {} }), null);
  // A work setting never serves triage, nor the reverse.
  assertEquals(sourcePersonaPick("triage", { persona: "team-work" }, { defaultPersona: "declared-work" }), null);
});

test("triagePersonaProblem: missing, unresolvable, or fine", () => {
  const none = triagePersonaProblem("simt", undefined, {}, () => true);
  assertStringIncludes(none!, "triage-mode source simt needs a triage persona");
  assertStringIncludes(none!, "Config → Sources");
  const stale = triagePersonaProblem("simt", { triagePersona: "gone" }, {}, () => false);
  assertStringIncludes(stale!, `"gone" doesn't exist`);
  assertEquals(triagePersonaProblem("simt", undefined, { triagePersona: "builtin:triage" }, () => true), null);
});

// ─── Work mode ───────────────────────────────────────────────────────

test("work mode: no persona anywhere → no persona block, nothing recorded", async () => {
  const { store, app, folder, cleanup } = setup();
  try {
    writeItem(folder, "J-1", "Plain");
    await store.syncWorkSource(SOURCE);
    const { prompt, persona } = await claim(app, store, mirroredWorkDefId(SOURCE, "J-1"));
    assertEquals(prompt.includes("## Your Role"), false);
    assertEquals(persona, undefined);
  } finally { cleanup(); }
});

test("work mode: each link of the chain leads the prompt and is recorded with how it was chosen", async () => {
  const { store, app, teamDir, folder, persona, cleanup } = setup({ defaultPersona: "declared" });
  try {
    persona("declared", "Declared", "From the source.");
    persona("team-pick", "Team Pick", "From the team.");
    persona("suggested", "Suggested", "From the item.");
    persona("mine", "Mine", "From a person.");
    const defId = mirroredWorkDefId(SOURCE, "J-1");

    // 1. The source's declaration.
    writeItem(folder, "J-1", "Chain", { goal: "rev 1" });
    await store.syncWorkSource(SOURCE);
    let run = await claim(app, store, defId);
    assert(run.prompt.startsWith("## Your Role\n\nFrom the source."), run.prompt.slice(0, 80));
    assertEquals(run.persona, { id: "declared", title: "Declared", origin: "team", via: "source-default" });
    finish(store, defId);

    // 2. The team's per-source setting wins over the declaration.
    const put = await app.request(`/api/sources/${SOURCE}/persona`, json("PUT", { persona: "team-pick" }));
    assertEquals(put.status, 200);
    writeItem(folder, "J-1", "Chain", { goal: "rev 2" });
    await store.syncWorkSource(SOURCE);
    run = await claim(app, store, defId);
    assertStringIncludes(run.prompt, "From the team.");
    assertEquals(run.persona?.via, "source-setting");
    finish(store, defId);

    // 3. The item's own suggestion (ExternalDef.persona → mirror frontmatter).
    writeItem(folder, "J-1", "Chain", { goal: "rev 3", persona: "suggested" });
    await store.syncWorkSource(SOURCE);
    assertEquals(store.getWorkDef(defId)!.persona, "suggested");
    run = await claim(app, store, defId);
    assertStringIncludes(run.prompt, "From the item.");
    assertEquals(run.persona, { id: "suggested", title: "Suggested", origin: "team", via: "workdef" });
    finish(store, defId);

    // 4. A person's override wins over all of it — and survives a re-sync.
    const over = await app.request(`/api/work-defs/${encodeURIComponent(defId)}/persona`, json("PUT", { persona: "mine" }));
    assertEquals(over.status, 200);
    assertEquals((await over.json()).workDef.mirror.personaOverride, "mine");
    assertEquals(fileSourceKv(teamDir, SOURCE).get(mirrorPersonaKey(defId)), "mine");
    writeItem(folder, "J-1", "Chain", { goal: "rev 4", persona: "suggested" });
    await store.syncWorkSource(SOURCE);
    run = await claim(app, store, defId);
    assertStringIncludes(run.prompt, "From a person.");
    assertEquals(run.persona?.id, "mine");
    finish(store, defId);

    // Clearing the override falls back to the suggestion.
    assertEquals((await app.request(`/api/work-defs/${encodeURIComponent(defId)}/persona`, json("PUT", { persona: null }))).status, 200);
    assertEquals(store.resolveMirrorPersona(store.getWorkDef(defId)!)?.id, "suggested");
  } finally { cleanup(); }
});

test("work mode: a stale id falls back to builtin:worker with fallbackFrom", async () => {
  const { store, app, folder, cleanup } = setup({ defaultPersona: "uninstalled-pkg/worker" });
  try {
    writeItem(folder, "J-1", "Stale");
    await store.syncWorkSource(SOURCE);
    const { persona } = await claim(app, store, mirroredWorkDefId(SOURCE, "J-1"));
    assertEquals(persona, { id: "builtin:worker", title: persona!.title, origin: "builtin", via: "source-default", fallbackFrom: "uninstalled-pkg/worker" });
  } finally { cleanup(); }
});

test("PUT /api/work-defs/:id/persona: only mirrors, only ids that resolve", async () => {
  const { store, app, folder, cleanup } = setup();
  try {
    writeItem(folder, "J-1", "One");
    await store.syncWorkSource(SOURCE);
    const defId = encodeURIComponent(mirroredWorkDefId(SOURCE, "J-1"));
    assertEquals((await app.request(`/api/work-defs/${defId}/persona`, json("PUT", { persona: "nope" }))).status, 400);
    assertEquals((await app.request(`/api/work-defs/${defId}/persona`, json("PUT", {}))).status, 400);
    assertEquals((await app.request(`/api/work-defs/missing/persona`, json("PUT", { persona: null }))).status, 404);
    const solo = store.createWorkDef({ title: "Solo", goal: "g", acceptanceCriteria: "" }, false);
    assertEquals((await app.request(`/api/work-defs/${solo.id}/persona`, json("PUT", { persona: "builtin:worker" }))).status, 409);
  } finally { cleanup(); }
});

// ─── The per-source setting ──────────────────────────────────────────

test("GET /api/sources shows the personas; PUT /persona validates, persists, and never re-inits", async () => {
  const { store, app, teamDir, config, persona, inits, cleanup } = setup({ defaultPersona: "builtin:worker", triagePersona: "builtin:triage" });
  try {
    persona("reviewer", "Reviewer", "Review.");
    let view = await sourceView(app);
    assertEquals([view.persona, view.defaultPersona, view.triagePersona, view.defaultTriagePersona], [null, "builtin:worker", null, "builtin:triage"]);
    assertEquals(view.initError, undefined);
    const initsBefore = inits();

    assertEquals((await app.request(`/api/sources/nope/persona`, json("PUT", { persona: "reviewer" }))).status, 404);
    assertEquals((await app.request(`/api/sources/${SOURCE}/persona`, json("PUT", { persona: "ghost" }))).status, 400);
    assertEquals((await app.request(`/api/sources/${SOURCE}/persona`, json("PUT", {}))).status, 400);

    const res = await app.request(`/api/sources/${SOURCE}/persona`, json("PUT", { persona: "reviewer", triagePersona: "reviewer" }));
    assertEquals(res.status, 200);
    view = (await res.json()).source;
    assertEquals([view.persona, view.triagePersona], ["reviewer", "reviewer"]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
    assertEquals(onDisk.sourcePersonas, { [SOURCE]: { persona: "reviewer", triagePersona: "reviewer" } });

    // Absent keeps a field; null clears it; the entry stays (even empty).
    await app.request(`/api/sources/${SOURCE}/persona`, json("PUT", { triagePersona: null }));
    assertEquals(config.sourcePersonas?.[SOURCE], { persona: "reviewer" });
    await app.request(`/api/sources/${SOURCE}/persona`, json("PUT", { persona: "" }));
    assertEquals(config.sourcePersonas?.[SOURCE], {});
    assertEquals(inits(), initsBefore);

    // "Used by" sees the setting, so the persona can't be deleted out from under it.
    await app.request(`/api/sources/${SOURCE}/persona`, json("PUT", { persona: "reviewer" }));
    assertEquals(store.getPersonaUsage("reviewer"), [{ kind: "source-setting", source: SOURCE, field: "persona" }]);
    assertEquals((await app.request("/api/personas/reviewer", { method: "DELETE" })).status, 409);
  } finally { cleanup(); }
});

// ─── Triage mode ─────────────────────────────────────────────────────

test("triage mode: no triage persona → no sync (initError says how to fix); setting one syncs and runs with it", async () => {
  const { store, app, folder, config, persona, cleanup } = setup({ mode: "triage" }, { triage: { enabled: true, persona: "notes-triage" } });
  try {
    persona("notes-triage", "Notes triage", "For personal notes.");
    persona("ticket-triage", "Ticket triage", "Read the ticket and propose work.");
    writeItem(folder, "T-1", "Webhooks flake");

    // The notes' triage persona is not a fallback: still refused.
    const refused = await store.syncWorkSource(SOURCE);
    assertEquals(refused.skipped, "misconfigured");
    assertStringIncludes(refused.error!, "triage-mode source jira needs a triage persona");
    assertEquals(store.getWorkDef(mirroredWorkDefId(SOURCE, "T-1")), null);
    const view = await sourceView(app);
    assertStringIncludes(view.initError!, "needs a triage persona — set one on Config → Sources, or declare triagePersona");
    assertEquals(view.personaError, view.initError);
    // Refused without counting as a failure (no backoff).
    assertEquals(store.syncFailures(SOURCE), 0);

    // A stale id is refused too.
    config.sourcePersonas = { [SOURCE]: { triagePersona: "gone" } };
    assertStringIncludes((await store.syncWorkSource(SOURCE)).error!, `"gone" doesn't exist`);

    // Setting one (the route kicks a sync) enqueues the item; the claim uses it.
    assertEquals((await app.request(`/api/sources/${SOURCE}/persona`, json("PUT", { triagePersona: "ticket-triage" }))).status, 200);
    await settled(store);
    assertEquals(store.getSyncStatus(SOURCE).last?.enqueued, 1);
    assertEquals((await sourceView(app)).initError, undefined);
    const defId = mirroredWorkDefId(SOURCE, "T-1");
    const { prompt, persona: recorded } = await claim(app, store, defId);
    assertStringIncludes(prompt, "## Your Role: Triage");
    assertStringIncludes(prompt, "Read the ticket and propose work.");
    assertEquals(prompt.includes("For personal notes."), false);
    assertEquals(recorded, { id: "ticket-triage", title: "Ticket triage", origin: "team", via: "source-setting" });
  } finally { cleanup(); }
});

test("triage mode: a declared triagePersona is enough; a per-item override applies to triage mirrors", async () => {
  const { store, app, folder, persona, cleanup } = setup({ mode: "triage", triagePersona: "builtin:triage" });
  try {
    persona("special", "Special triage", "Special rules.");
    writeItem(folder, "T-1", "One");
    const out = await store.syncWorkSource(SOURCE);
    assertEquals(out.enqueued.length, 1);
    const defId = mirroredWorkDefId(SOURCE, "T-1");
    await app.request(`/api/work-defs/${encodeURIComponent(defId)}/persona`, json("PUT", { persona: "special" }));
    const { prompt, persona: recorded } = await claim(app, store, defId);
    assertStringIncludes(prompt, "Special rules.");
    assertEquals(prompt.includes(DEFAULT_TRIAGE_INSTRUCTIONS.slice(0, 40)), false);
    assertEquals(recorded?.via, "workdef");
  } finally { cleanup(); }
});

test("work-mode source: a triage item without a triage persona is mirrored, not enqueued, and Run refuses", async () => {
  const { store, app, folder, cleanup } = setup();
  try {
    writeItem(folder, "T-1", "Triage me", { mode: "triage" });
    writeItem(folder, "J-2", "Work me");
    const out = await store.syncWorkSource(SOURCE);
    const defId = mirroredWorkDefId(SOURCE, "T-1");
    assertEquals(out.needsPersona, [defId]);
    assertEquals(out.enqueued.length, 1); // only the work item
    assert(store.getWorkDef(defId), "mirrored anyway");
    assertStringIncludes((await sourceView(app)).initError!, "1 triage-mode item waiting for a triage persona");
    const run = await app.request(`/api/work-defs/${encodeURIComponent(defId)}/enqueue`, { method: "POST" });
    assertEquals(run.status, 409);

    // Its own suggestion is enough on the next sync, nothing stamped meanwhile.
    writeItem(folder, "T-1", "Triage me", { mode: "triage", persona: "builtin:triage" });
    const next = await store.syncWorkSource(SOURCE);
    assertEquals(next.needsPersona, []);
    assertEquals(next.enqueued.length, 1);
    assertEquals((await sourceView(app)).initError, undefined);
  } finally { cleanup(); }
});

// ─── Startup: the seed and the warnings ──────────────────────────────

test("seedSourceTriagePersonas: seeds a triage plugin once with the team's triage persona", () => {
  const { store, config, persona, cleanup } = setup({ mode: "triage" }, { triage: { enabled: true, persona: "notes-triage" } });
  try {
    persona("notes-triage", "Notes triage", "Migrated triage.md");
    // Not a package source: left alone (the requirement applies; the seed doesn't).
    assertEquals(store.seedSourceTriagePersonas(), []);
    store.setPluginStatuses([{ identity: "/p", spec: "/p", state: "loaded", sources: [SOURCE] }]);
    assertEquals(store.seedSourceTriagePersonas(), [SOURCE]);
    assertEquals(config.sourcePersonas?.[SOURCE], { triagePersona: "notes-triage" });
    assertEquals(store.sourcePersonaProblem(SOURCE), null);
    // Idempotent, and a person's cleared entry is never refilled.
    config.sourcePersonas = { [SOURCE]: {} };
    assertEquals(store.seedSourceTriagePersonas(), []);
    assertEquals(config.sourcePersonas[SOURCE], {});
  } finally { cleanup(); }
});

test("seedSourceTriagePersonas: builtin:triage without a team triage persona; nothing for a declared one", () => {
  const a = setup({ mode: "triage" });
  try {
    a.store.setPluginStatuses([{ identity: "/p", spec: "/p", state: "loaded", sources: [SOURCE] }]);
    assertEquals(a.store.seedSourceTriagePersonas(), [SOURCE]);
    assertEquals(a.config.sourcePersonas?.[SOURCE], { triagePersona: "builtin:triage" });
  } finally { a.cleanup(); }
  const b = setup({ mode: "triage", triagePersona: "builtin:triage" });
  try {
    b.store.setPluginStatuses([{ identity: "/p", spec: "/p", state: "loaded", sources: [SOURCE] }]);
    assertEquals(b.store.seedSourceTriagePersonas(), []);
  } finally { b.cleanup(); }
});

test("checkDeclaredSourcePersonas: an unknown declared persona is a package warning", () => {
  const { store, cleanup } = setup({ defaultPersona: "missing-pkg/worker", triagePersona: "builtin:triage" });
  try {
    store.setPluginStatuses([{ identity: "/p", spec: "/p", state: "loaded", sources: [SOURCE] }]);
    store.checkDeclaredSourcePersonas();
    const status = store.getPluginStatuses()[0]!;
    assertEquals(status.state, "loaded");
    assertEquals(status.warnings, [`source "${SOURCE}": defaultPersona "missing-pkg/worker" doesn't exist (no such team, built-in, or package persona)`]);
  } finally { cleanup(); }
});
