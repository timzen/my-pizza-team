/**
 * tests/default-model.test.ts — The team default model (`defaultModel`, per
 * harness; shared/model-aliases.ts, daemon/default-model.ts; docs/DESIGN.md
 * "Choosing a Model").
 *
 * The config parses, serializes (beside `modelAliases`) and saves through PUT
 * /api/config (set, keep, clear, refuse); an unpinned agent that registers —
 * teammate or assistant — is sent a `set-model` with source `default` for its
 * harness, while a pinned one, one whose harness can't switch models and one
 * with a user pick pending are left alone; clearing a pin sends the default;
 * and POST /api/agents/model/default ("Apply to all teammates now") sends the
 * saved default to every live unpinned agent (null where its harness has
 * none). `mpt doctor`'s team-model checks are covered at the end.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { assert, assertEquals } from "./_assert.ts";
import { withTeam, post, put, get, jsonInit, type App } from "./_team.ts";
import { teamDefaultModel, validateDefaultModel } from "../shared/model-aliases.ts";
import { applyTeamConfigDefaults, serializeTeamConfig } from "../shared/team-config.ts";
import { DEFAULT_CONFIG } from "../shared/types.ts";
import { SET_MODEL_CAPABILITY, type ApplyDefaultModelResponse } from "../shared/protocol.ts";
import { teamModelChecks, teamModelFacts } from "../cli/doctor.ts";

const MODELS = [
  { ref: "acme/base", id: "base", name: "Base", provider: "acme" },
  { ref: "acme/strong", id: "strong", name: "Strong", provider: "acme" },
];

/** Register `id`; `modern` declares set-model and reports MODELS. */
async function register(app: App, id: string, modern = true, name = id) {
  const res = await post(app, "/api/agents/register", {
    id, name, directory: "/tmp",
    ...(modern ? { capabilities: [SET_MODEL_CAPABILITY], models: MODELS } : {}),
  });
  assertEquals(res.status, 200);
}

type Pending = { id: string; action: string; params: Record<string, unknown> };
const pending = async (app: App, id: string) =>
  (await (await get(app, `/api/agents/${id}/directives`)).json() as { directives: Pending[] }).directives.filter((d) => d.action === "set-model");
const done = (app: App, agent: string, directiveId: string) => put(app, `/api/agents/${agent}/directives/${directiveId}`, { status: "done" });

// ─── Config ─────────────────────────────────────────────────────────

test("config: defaultModel loads, serializes beside modelAliases, and empty is omitted", () => {
  const config = applyTeamConfigDefaults({ defaultModel: { pi: "acme/base" }, modelAliases: { pi: { strong: "acme/strong" } } });
  assertEquals(config.defaultModel, { pi: "acme/base" });
  const out = serializeTeamConfig(config);
  assertEquals(out.defaultModel, { pi: "acme/base" });
  const keys = Object.keys(out);
  assertEquals(keys.indexOf("defaultModel") + 1, keys.indexOf("modelAliases"), "kept together");
  assert(!("defaultModel" in serializeTeamConfig({ ...DEFAULT_CONFIG, defaultModel: {} })), "an empty block is left out");
});

test("defaultModel: per-harness lookup and validation", () => {
  assertEquals(teamDefaultModel({ defaultModel: { pi: " acme/base " } }, "pi"), "acme/base");
  assertEquals(teamDefaultModel({ defaultModel: { pi: "acme/base" } }, "kiro"), null);
  assertEquals(teamDefaultModel({}, "pi"), null);
  assertEquals(validateDefaultModel({ pi: " acme/x ", kiro: "", claude: null }), { value: { pi: "acme/x" } });
  for (const bad of [[], "x", null, { pi: 3 }, { "": "m" }, { pi: "x".repeat(201) }]) {
    assert("error" in validateDefaultModel(bad), JSON.stringify(bad));
  }
});

test("PUT /api/config: sets, keeps, clears and refuses defaultModel", async () => {
  await withTeam({}, async ({ app, config, teamDir }) => {
    const current = await (await app.request("/api/config")).json();
    const save = (over: Record<string, unknown>) => app.request("/api/config", jsonInit("PUT", { ...current, ...over }));
    assertEquals((await save({ defaultModel: { pi: "acme/base" } })).status, 200);
    assertEquals(config.defaultModel, { pi: "acme/base" });
    const onDisk = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
    assertEquals(onDisk.defaultModel, { pi: "acme/base" });
    assertEquals((await (await app.request("/api/config")).json()).defaultModel, { pi: "acme/base" }, "GET returns it");
    // Absent keeps it; a blank id drops that harness; null clears.
    assertEquals((await save({})).status, 200);
    assertEquals(config.defaultModel, { pi: "acme/base" });
    assertEquals((await save({ defaultModel: { pi: "" } })).status, 200);
    assertEquals(config.defaultModel, undefined);
    assertEquals((await save({ defaultModel: { pi: "acme/base" } })).status, 200);
    assertEquals((await save({ defaultModel: null })).status, 200);
    assertEquals(config.defaultModel, undefined);
    assertEquals((await save({ defaultModel: { pi: 3 } })).status, 400);
    assertEquals((await save({ defaultModel: "acme/base" })).status, 400);
  });
});

// ─── Registration ───────────────────────────────────────────────────

test("register: an unpinned agent (teammate or assistant) is sent the default for its harness", async () => {
  await withTeam({ defaultModel: { pi: "acme/base" } }, async ({ app }) => {
    await register(app, "t1");
    await register(app, "leader", true, "leader");
    for (const id of ["t1", "leader"]) {
      const asks = await pending(app, id);
      assertEquals(asks.length, 1, id);
      assertEquals([asks[0]!.params.model, asks[0]!.params.source], ["acme/base", "default"], id);
    }
    // Realized: no pin (a default isn't the user's choice).
    const [ask] = await pending(app, "t1");
    assertEquals((await done(app, "t1", ask!.id)).status, 200);
    assertEquals((await (await get(app, "/api/agents/t1/model")).json()).pin, null);
    // A harness that can't switch models isn't sent one.
    await register(app, "old", false);
    assertEquals((await pending(app, "old")).length, 0);
  });
});

test("register: no default configured, or one for another harness only, sends nothing", async () => {
  await withTeam({ defaultModel: { kiro: "kiro-x" } }, async ({ app }) => {
    await register(app, "t1");
    assertEquals((await pending(app, "t1")).length, 0);
  });
});

test("register: a pinned agent is left untouched, and one with a user pick pending keeps it", async () => {
  await withTeam({}, async ({ app, config }) => {
    await register(app, "t1");
    await register(app, "t2");
    const pin = await (await post(app, "/api/agents/t1/model", { model: "acme/strong" })).json() as { directive: { id: string } };
    assertEquals((await done(app, "t1", pin.directive.id)).status, 200);
    const pick = await (await post(app, "/api/agents/t2/model", { model: "acme/strong" })).json() as { directive: { id: string } };

    config.defaultModel = { pi: "acme/base" };
    await register(app, "t1"); // a new session of a pinned agent
    assertEquals((await pending(app, "t1")).length, 0, "the pin wins: no default sent");
    await register(app, "t2"); // its user pick is still pending
    assertEquals((await pending(app, "t2")).map((d) => d.id), [pick.directive.id], "not superseded by the default");
  });
});

test("clearing a pin sends the team default", async () => {
  await withTeam({}, async ({ app, config }) => {
    await register(app, "t1");
    const pin = await (await post(app, "/api/agents/t1/model", { model: "acme/strong" })).json() as { directive: { id: string } };
    await done(app, "t1", pin.directive.id);
    config.defaultModel = { pi: "acme/base" };
    const clear = await (await post(app, "/api/agents/t1/model", { model: null })).json() as { directive: { id: string } };
    assertEquals((await pending(app, "t1")).length, 1, "only the clear, until it's done");
    await done(app, "t1", clear.directive.id);
    const asks = await pending(app, "t1");
    assertEquals(asks.map((d) => [d.params.model, d.params.source]), [["acme/base", "default"]]);
  });
});

// ─── Apply now ──────────────────────────────────────────────────────

test("POST /api/agents/model/default: the saved default to every live unpinned agent", async () => {
  await withTeam({}, async ({ app, config, store }) => {
    await register(app, "t1");
    await register(app, "t2");
    await register(app, "leader", true, "leader");
    await register(app, "old", false);
    await register(app, "gone");
    store.updateMemberStatus("gone", "offline");
    const pin = await (await post(app, "/api/agents/t2/model", { model: "acme/strong" })).json() as { directive: { id: string } };
    await done(app, "t2", pin.directive.id);

    config.defaultModel = { pi: "acme/base" };
    const res = await post(app, "/api/agents/model/default", {});
    assertEquals(res.status, 200);
    const body = await res.json() as ApplyDefaultModelResponse;
    assertEquals(body.directives.map((d) => [d.memberId, d.model]).sort(), [["leader", "acme/base"], ["t1", "acme/base"]]);
    assertEquals(body.pinned, ["t2"]);
    assertEquals(body.unsupported, ["old"]);
    assertEquals((await pending(app, "t2")).length, 0, "the pinned agent is untouched");
    assertEquals((await pending(app, "gone")).length, 0, "offline agents are skipped");
    const [ask] = await pending(app, "t1");
    assertEquals([ask!.params.model, ask!.params.source], ["acme/base", "default"]);

    // Cleared: unpinned agents are told to drop it (model null), superseding the pending ask.
    delete config.defaultModel;
    const cleared = await (await post(app, "/api/agents/model/default", {})).json() as ApplyDefaultModelResponse;
    assertEquals(cleared.directives.find((d) => d.memberId === "t1")?.model, null);
    assertEquals((await pending(app, "t1")).map((d) => d.params.model), [null]);
  });
});

// ─── mpt doctor ─────────────────────────────────────────────────────

test("doctor: reports the default and aliases; warns about a model no live agent lists", () => {
  const config = { defaultModel: { pi: "acme/base" }, modelAliases: { pi: { strong: "acme/huge", fast: "acme/base" } } };
  const agents = [
    { status: "idle", harness: "pi", models: MODELS },
    { status: "offline", harness: "pi", models: [{ ref: "acme/huge" }] }, // offline: doesn't count
  ];
  const checks = teamModelChecks(teamModelFacts(config, agents));
  assertEquals(checks.find((c) => c.name === "Default model")?.detail, "pi: acme/base");
  assertEquals(checks.find((c) => c.name === "Model aliases")?.detail, "pi: fast → acme/base, strong → acme/huge");
  const warns = checks.filter((c) => c.status === "warn");
  assertEquals(warns.map((c) => c.name), ['Model "acme/huge"']);
  assert(warns[0]!.detail.includes('alias "strong"'), warns[0]!.detail);

  // Daemon down: reported, nothing to compare against.
  assertEquals(teamModelChecks(teamModelFacts(config, null)).filter((c) => c.status === "warn"), []);
  // No live agent of that harness reported models: no warning either.
  assertEquals(teamModelChecks(teamModelFacts({ defaultModel: { kiro: "k" } }, agents)).filter((c) => c.status === "warn"), []);
  // Nothing set: one ok line.
  const none = teamModelChecks(teamModelFacts({}, agents));
  assertEquals(none.map((c) => [c.name, c.status]), [["Default model", "ok"]]);
});
