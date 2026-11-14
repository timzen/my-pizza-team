/**
 * tests/persona-models.test.ts — Persona model aliases (shared/model-aliases.ts;
 * docs/DESIGN.md "Persona settings"): the team config's `modelAliases` /
 * `personaModels` parse, save and validate (PUT /api/config); a persona's
 * `model` alias is resolved for the claiming harness — mapped, unknown (no
 * model, one thread comment per claim) and switched off — and for the
 * leader's assistant persona; persona lint warns about an alias the config
 * doesn't define; and `mpt doctor` lists aliases in use with no mapping.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import { withTeam, jsonInit } from "./_team.ts";
import { modelAliasNames, personaModelsEnabled, resolvePersonaModel, validateModelAliases } from "../shared/model-aliases.ts";
import { applyTeamConfigDefaults, serializeTeamConfig } from "../shared/team-config.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import { PERSONA_SYSTEM_PROMPT_CAPABILITY, type AgentClaimResponse } from "../shared/protocol.ts";
import { PackagePersonas } from "../daemon/personas/packages.ts";
import { personaModelChecks, personaModelFacts } from "../cli/doctor.ts";
import type { Store } from "../daemon/store.ts";

const ALIASES = { pi: { strong: "acme/strong-1", fast: "acme/fast-1" }, kiro: { strong: "kiro-strong" } };

// ─── Config ─────────────────────────────────────────────────────────

test("config: modelAliases and personaModels load and serialize; empty aliases are omitted", () => {
  const config = applyTeamConfigDefaults({ modelAliases: ALIASES, personaModels: false });
  assertEquals(config.modelAliases, ALIASES);
  assertEquals(config.personaModels, false);
  const out = serializeTeamConfig(config);
  assertEquals(out.modelAliases, ALIASES);
  assertEquals(out.personaModels, false);
  assert(!("modelAliases" in serializeTeamConfig({ ...DEFAULT_CONFIG, modelAliases: {} })), "an empty block is left out");
  assert(!("personaModels" in serializeTeamConfig(DEFAULT_CONFIG)));
});

test("aliases: names across harnesses, the switch, and validation", () => {
  assertEquals(modelAliasNames({ modelAliases: ALIASES }), ["fast", "strong"]);
  assertEquals(modelAliasNames({}), []);
  assertEquals(personaModelsEnabled({}), true);
  assertEquals(personaModelsEnabled({ personaModels: false }), false);
  assertEquals(validateModelAliases({ pi: { strong: " acme/x " }, kiro: {} }), { value: { pi: { strong: "acme/x" } } });
  for (const bad of [[], "x", { pi: "x" }, { pi: { "two words": "m" } }, { pi: { strong: "" } }, { pi: { strong: 3 } }]) {
    assert("error" in validateModelAliases(bad), JSON.stringify(bad));
  }
});

test("resolve: mapped for the harness, unknown (with the key to add), and switched off", () => {
  assertEquals(resolvePersonaModel({ modelAliases: ALIASES }, "strong", "pi"), { modelId: "acme/strong-1", problem: null });
  assertEquals(resolvePersonaModel({ modelAliases: ALIASES }, "strong", "kiro").modelId, "kiro-strong");
  const unknown = resolvePersonaModel({ modelAliases: ALIASES }, "fast", "kiro");
  assertEquals(unknown.modelId, null);
  assert(unknown.problem!.includes("modelAliases.kiro.fast"), unknown.problem!);
  assertEquals(resolvePersonaModel({}, "strong", "pi").modelId, null);
  assertEquals(resolvePersonaModel({ modelAliases: ALIASES, personaModels: false }, "strong", "pi"), { modelId: null, problem: null });
});

test("PUT /api/config: sets, keeps, clears and refuses modelAliases and personaModels", async () => {
  await withTeam({}, async ({ app, config, teamDir }) => {
    const current = await (await app.request("/api/config")).json();
    const save = (over: Record<string, unknown>) => app.request("/api/config", jsonInit("PUT", { ...current, ...over }));
    assertEquals((await save({ modelAliases: ALIASES, personaModels: false })).status, 200);
    assertEquals(config.modelAliases, ALIASES);
    assertEquals(config.personaModels, false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
    assertEquals(onDisk.modelAliases, ALIASES);
    // Absent keeps both; true (the default) is stored as unset; null clears.
    assertEquals((await save({})).status, 200);
    assertEquals(config.modelAliases, ALIASES);
    assertEquals((await save({ personaModels: true })).status, 200);
    assertEquals(config.personaModels, undefined);
    assertEquals((await save({ modelAliases: null })).status, 200);
    assertEquals(config.modelAliases, undefined);
    const bad = await save({ modelAliases: { pi: { "no good": "x" } } });
    assertEquals(bad.status, 400);
    assertEquals((await save({ personaModels: "no" })).status, 400);
  });
});

// ─── Claim ──────────────────────────────────────────────────────────

/** Register `agent` (as `harness`), make a WorkDef with `persona`, claim it; the response and its thread. */
async function claimAs(app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }, store: Store, agent: string, persona: string, harness?: string) {
  await app.request("/api/agents/register", jsonInit("POST", {
    id: agent, name: agent, directory: "/tmp", capabilities: [PERSONA_SYSTEM_PROMPT_CAPABILITY], ...(harness ? { harness } : {}),
  }));
  const def = store.createWorkDef({ title: `Work for ${agent}`, goal: "Do it.", acceptanceCriteria: "Done.", persona });
  const item = store.getWorkItems({ states: ["READY"] }).items.find((wi) => wi.ref.workDefId === def.id)!;
  const res = await (await app.request(`/api/agents/claim/${item.id}`, jsonInit("POST", { agentId: agent }))).json() as AgentClaimResponse;
  const notes = store.getCommentsForRef({ workDefId: def.id }).filter((c) => c.body.startsWith("[persona model]"));
  return { res, notes };
}

test("claim: the persona carries the alias and the model id for the claiming harness", async () => {
  // Kiro registers only with experimental harnesses on.
  await withTeam({ modelAliases: ALIASES, experimental: { harnesses: true } }, async ({ app, store }) => {
    store.createPersona({ title: "Strong", content: "Think hard.", model: "strong" });
    store.createPersona({ title: "Fast", content: "Be quick.", model: "fast" });
    store.createPersona({ title: "Plain", content: "Just do it." });

    const pi = await claimAs(app, store, "pi-1", "strong");
    assertEquals(pi.res.persona?.model, "strong");
    assertEquals(pi.res.persona?.modelId, "acme/strong-1");
    assertEquals(pi.notes.length, 0);
    const kiro = await claimAs(app, store, "kiro-1", "strong", "kiro");
    assertEquals(kiro.res.persona?.modelId, "kiro-strong", "resolved for the agent's own harness");

    // Unknown for this harness: no model, and the thread says so once.
    const unknown = await claimAs(app, store, "kiro-2", "fast", "kiro");
    assertEquals(unknown.res.persona?.model, "fast");
    assertEquals(unknown.res.persona?.modelId, null);
    assertEquals(unknown.notes.length, 1);
    assert(unknown.notes[0]!.from === "daemon" && unknown.notes[0]!.body.includes("modelAliases.kiro.fast"), JSON.stringify(unknown.notes));

    // No model in the persona: no model fields at all (the payload is as before).
    const plain = await claimAs(app, store, "pi-2", "plain");
    assert(!("model" in plain.res.persona!) && !("modelId" in plain.res.persona!), JSON.stringify(plain.res.persona));
  });
});

test("claim: personaModels false sends no model id and posts nothing", async () => {
  await withTeam({ modelAliases: ALIASES, personaModels: false }, async ({ app, store }) => {
    store.createPersona({ title: "Strong", content: "Think hard.", model: "strong" });
    const { res, notes } = await claimAs(app, store, "pi-1", "strong");
    assertEquals(res.persona?.model, "strong");
    assertEquals(res.persona?.modelId, null);
    assertEquals(notes.length, 0);
  });
});

test("assistant persona: modelId resolved for the leader's harness, with the problem when unmapped", async () => {
  await withTeam({ modelAliases: { pi: { strong: "acme/strong-1" } } }, async ({ app, store }) => {
    store.createPersona({ title: "Strong", content: "Think hard.", model: "strong" });
    store.createPersona({ title: "Fast", content: "Be quick.", model: "fast" });
    await app.request("/api/assistant/persona", jsonInit("PUT", { personaId: "strong" }));
    const strong = await (await app.request("/api/assistant/persona")).json();
    assertEquals([strong.modelId, strong.modelProblem], ["acme/strong-1", null]);
    await app.request("/api/assistant/persona", jsonInit("PUT", { personaId: "fast" }));
    const fast = await (await app.request("/api/assistant/persona")).json();
    assertEquals(fast.modelId, null);
    assert(String(fast.modelProblem).includes("modelAliases.pi.fast"), fast.modelProblem);
    await app.request("/api/assistant/persona", jsonInit("PUT", { personaId: null }));
    const none = await (await app.request("/api/assistant/persona")).json();
    assert(!("modelId" in none), "a persona with no model sends no model fields");
  });
});

// ─── Lint and doctor ────────────────────────────────────────────────

test("lint: a persona model naming no configured alias warns (routes and packages)", async () => {
  await withTeam({ modelAliases: ALIASES }, async ({ app }) => {
    const known = await (await app.request("/api/personas", jsonInit("POST", { title: "Known", content: "x", model: "strong" }))).json();
    assert(!known.warnings.some((w: string) => w.includes("not a model alias")), JSON.stringify(known.warnings));
    const typo = await (await app.request("/api/personas", jsonInit("POST", { title: "Typo", content: "x", model: "strnog" }))).json();
    assert(typo.warnings.some((w: string) => w.includes("\"strnog\" is not a model alias")), JSON.stringify(typo.warnings));
    const edited = await (await app.request("/api/personas/known", jsonInit("PUT", { model: "huge" }))).json();
    assert(edited.warnings.some((w: string) => w.includes("\"huge\" is not a model alias")), JSON.stringify(edited.warnings));
  });
  const pkg = new PackagePersonas().register({ name: "pkg", identity: "/p" }, [{ name: "big", raw: "---\ntitle: Big\nmodel: huge\n---\nGo.\n" }], { modelAliases: ["strong"] });
  assert(pkg.warnings.some((w) => w.includes("persona pkg/big") && w.includes("\"huge\" is not a model alias")), JSON.stringify(pkg.warnings));
});

test("doctor: lists aliases in use with no mapping for the default harness", () => {
  const personas = [{ id: "a", model: "strong" }, { id: "b", model: "huge" }, { id: "c", model: "huge" }, { id: "d" }];
  const facts = personaModelFacts(personas, { modelAliases: ALIASES });
  assertEquals(facts, { harness: "pi", off: false, inUse: 3, unmapped: [{ alias: "huge", personas: ["b", "c"] }] });
  const checks = personaModelChecks(facts);
  assertEquals(checks.length, 1);
  assertEquals(checks[0]!.status, "warn");
  assert(checks[0]!.detail.includes("b, c") && checks[0]!.fix!.includes("\"pi\": { \"huge\""), JSON.stringify(checks[0]));
  // The default harness decides; mapped everywhere is one ok line; none in use is nothing.
  assertEquals(personaModelFacts([{ id: "a", model: "fast" }], { modelAliases: ALIASES, defaultHarness: "kiro" }).unmapped, [{ alias: "fast", personas: ["a"] }]);
  assertEquals(personaModelChecks(personaModelFacts([{ id: "a", model: "strong" }], { modelAliases: ALIASES }))[0]!.status, "ok");
  assertEquals(personaModelChecks(personaModelFacts([{ id: "d" }], {})), []);
  const off = personaModelChecks(personaModelFacts(personas, { personaModels: false }));
  assertEquals(off.length, 1);
  assert(off[0]!.status === "ok" && off[0]!.detail.includes("personaModels: false"), JSON.stringify(off));
});
