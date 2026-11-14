// The agent's model (src/model-choice.ts, src/persona-model.ts applyTarget /
// modelProblem, the set-model routing in src/teammate.ts and src/chat.ts):
// the effective model resolves pin ?? persona model ?? team default (failover
// on top), a `set-model` directive is realized between runs and marked done or
// failed, a pin survives work items and can be cleared, and the available
// models are Pi's `getAvailable()` (my-pizza-team docs/DESIGN.md "Choosing a
// Model").
//
// Run: node --test --experimental-strip-types tests/model-choice.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";

const { ModelListReporter, ModelPreferences, SetModelRealizer, availableModels } = await import("../src/model-choice.ts");
const { PersonaModelSwitch, modelName, modelProblem } = await import("../src/persona-model.ts");
const { TeammateLoop } = await import("../src/teammate.ts");
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT = { provider: "acme", id: "base", name: "Base" };
const STRONG = { provider: "acme", id: "strong-1", name: "Strong" };
const PINNED = { provider: "acme", id: "pinned", name: "Pinned" };
const NOAUTH = { provider: "nokey", id: "x" };
const MODELS = [DEFAULT, STRONG, PINNED, NOAUTH];

/** A fake Pi: MODELS in the registry (all but `nokey` available), a live model, setModel. */
function fakePi(start = DEFAULT) {
  const pi = {
    model: start,
    sets: [],
    async setModel(m) {
      pi.sets.push(modelName(m));
      pi.model = m;
      return true;
    },
  };
  const ctx = {
    get model() { return pi.model; },
    modelRegistry: {
      find: (provider, id) => MODELS.find((m) => m.provider === provider && m.id === id),
      getAll: () => MODELS,
      getAvailable: () => MODELS.filter((m) => m.provider !== "nokey"),
    },
  };
  return { pi, ctx };
}

const persona = (modelId) => ({ id: "implementer", model: "strong", modelId });

/** The pieces as index.ts wires them for a teammate, with `held` standing in for the loop's item and persona. */
function wired() {
  const { pi, ctx } = fakePi();
  const prefs = new ModelPreferences();
  const sw = new PersonaModelSwitch(pi, ctx);
  const held = { workItemId: null, persona: null };
  const apply = async () => {
    const target = prefs.resolve(held.persona ? held.workItemId : null, held.persona);
    return { origin: target?.origin ?? null, problem: await sw.applyTarget(target) };
  };
  const completed = [];
  const realizer = new SetModelRealizer({
    prefs,
    check: (id) => modelProblem(ctx.modelRegistry, id),
    apply,
    complete: async (id, status, error) => { completed.push(error ? { id, status, error } : { id, status }); },
  });
  return { pi, ctx, prefs, held, apply, realizer, completed };
}

const setModel = (id, model, source = "user") => ({ id, params: { model, source } });

test("resolve: failover ?? pin ?? persona model ?? team default ?? Pi's default", () => {
  const prefs = new ModelPreferences();
  assert.strictEqual(prefs.resolve("wi-1", null), null, "nothing set: Pi's default");
  prefs.teamDefault = "acme/base";
  assert.strictEqual(prefs.resolve("wi-1", persona(null)).origin, "default");
  assert.strictEqual(prefs.resolve("wi-1", persona("acme/strong-1")).modelId, "acme/strong-1", "the persona's beats the team default");
  assert.strictEqual(prefs.resolve(null, persona("acme/strong-1")).origin, "default", "no item held: the persona's doesn't apply");
  prefs.pin = "acme/pinned";
  const pinned = prefs.resolve("wi-1", persona("acme/strong-1"));
  assert.deepStrictEqual([pinned.origin, pinned.modelId], ["pin", "acme/pinned"], "the pin beats the persona's");
  assert.strictEqual(prefs.resolve("wi-2", persona("acme/strong-1")).key, pinned.key, "a pin's key is the same across items");
  prefs.failover = "acme/base";
  assert.strictEqual(prefs.resolve("wi-1", persona("acme/strong-1")).origin, "failover", "failover substitutes on top");
  prefs.set("failover", null);
  prefs.set("user", null);
  assert.strictEqual(prefs.resolve("wi-1", persona("acme/strong-1")).origin, "persona");
});

test("set-model while idle: switched at once and marked done", async () => {
  const { pi, prefs, realizer, completed } = wired();
  await realizer.offer(setModel("d1", "acme/pinned"));
  assert.strictEqual(modelName(pi.model), "acme/pinned");
  assert.strictEqual(prefs.pin, "acme/pinned");
  assert.deepStrictEqual(completed, [{ id: "d1", status: "done" }]);
  await realizer.offer(setModel("d1", "acme/pinned"));
  assert.strictEqual(completed.length, 1, "a repeat offer (the next poll) is ignored");
});

test("set-model mid-run waits for the run to settle (between runs)", async () => {
  const { pi, realizer, completed } = wired();
  realizer.runStarted();
  await realizer.offer(setModel("d1", "acme/pinned"));
  assert.deepStrictEqual(pi.sets, [], "no switch while the run is in flight");
  assert.deepStrictEqual(completed, [], "still pending");
  assert.strictEqual(realizer.pending, 1);
  await realizer.runSettled();
  assert.strictEqual(modelName(pi.model), "acme/pinned");
  assert.deepStrictEqual(completed, [{ id: "d1", status: "done" }]);
  assert.strictEqual(realizer.pending, 0);
});

test("an unknown or unavailable model fails the directive with the reason and changes nothing", async () => {
  const { pi, prefs, realizer, completed } = wired();
  await realizer.offer(setModel("d1", "acme/nope"));
  await realizer.offer(setModel("d2", "nokey/x"));
  await realizer.offer({ id: "d3", params: { model: "acme/base", source: "someone" } });
  assert.deepStrictEqual(completed.map((c) => [c.id, c.status]), [["d1", "failed"], ["d2", "failed"], ["d3", "failed"]]);
  assert.match(completed[0].error, /"acme\/nope" isn't a model this Pi knows/);
  assert.match(completed[1].error, /isn't available here \(no credentials for nokey\?\)/);
  assert.match(completed[2].error, /set-model needs/);
  assert.deepStrictEqual(pi.sets, []);
  assert.strictEqual(prefs.pin, null);
});

test("the pin wins over the persona's model, holds across items, and clearing it falls back", async () => {
  const { pi, held, apply, realizer } = wired();
  await realizer.offer(setModel("d1", "acme/pinned"));
  // A claim whose persona asks for another model: the pin stands.
  Object.assign(held, { workItemId: "wi-1", persona: persona("acme/strong-1") });
  await apply();
  assert.strictEqual(modelName(pi.model), "acme/pinned");
  // The item ends, the next is claimed: no switching back and forth.
  const before = pi.sets.length;
  Object.assign(held, { workItemId: null, persona: null });
  await apply();
  Object.assign(held, { workItemId: "wi-2", persona: persona("acme/strong-1") });
  await apply();
  assert.strictEqual(pi.sets.length, before);
  // Cleared (model: null): back to the persona's model for the held item…
  await realizer.offer(setModel("d2", null));
  assert.strictEqual(modelName(pi.model), "acme/strong-1");
  // …and to Pi's default once nothing is held.
  Object.assign(held, { workItemId: null, persona: null });
  await apply();
  assert.strictEqual(modelName(pi.model), "acme/base");
});

test("a fresh session applies the registration's pin before any work", async () => {
  const { pi, prefs, apply } = wired();
  prefs.pin = "acme/pinned"; // as setupTeammate seeds it from `modelPin`
  await apply();
  assert.strictEqual(modelName(pi.model), "acme/pinned");
});

test("stop(): a directive offered after shutdown is left for the next instance", async () => {
  const { pi, realizer, completed } = wired();
  realizer.runStarted();
  await realizer.offer(setModel("d1", "acme/pinned"));
  realizer.stop();
  await realizer.runSettled();
  await realizer.offer(setModel("d2", "acme/pinned"));
  assert.deepStrictEqual([pi.sets, completed], [[], []]);
});

test("availableModels: Pi's available models (not the whole catalogue), with ref provider/id", () => {
  const { ctx } = fakePi();
  assert.deepStrictEqual(availableModels(ctx.modelRegistry), [
    { ref: "acme/base", id: "base", name: "Base", provider: "acme" },
    { ref: "acme/pinned", id: "pinned", name: "Pinned", provider: "acme" },
    { ref: "acme/strong-1", id: "strong-1", name: "Strong", provider: "acme" },
  ]);
  assert.deepStrictEqual(availableModels(undefined), []);
  const sent = [];
  const reporter = new ModelListReporter((m) => sent.push(m), availableModels(ctx.modelRegistry));
  reporter.check(ctx.modelRegistry);
  assert.strictEqual(sent.length, 0, "unchanged: not re-sent");
  MODELS.push({ provider: "acme", id: "new" });
  try {
    reporter.check(ctx.modelRegistry);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].some((m) => m.ref === "acme/new"));
  } finally {
    MODELS.pop();
  }
});

test("the teammate loop hands set-model to onModelDirective and keeps polling (no session roll)", async () => {
  const marked = [];
  const client = {
    getSelfDirectives: async () => ({ directives: [
      { id: "d1", action: "set-model", params: { model: "acme/pinned", source: "user" } },
      { id: "d2", action: "something-else", params: {} },
    ] }),
    completeSelfDirective: async (id, status) => { marked.push([id, status]); },
  };
  const loop = new TeammateLoop({}, client);
  loop["running"] = true;
  const offered = [];
  let rolled = false;
  loop.onSessionDirective = () => { rolled = true; };
  loop.onModelDirective = (d) => { offered.push(d.id); };
  await loop["pollSessionDirectives"]();
  assert.deepStrictEqual(offered, ["d1"]);
  assert.deepStrictEqual(marked, [["d2", "failed"]], "the realizer marks set-model itself");
  assert.strictEqual(rolled, false);
});

// chat.ts imports runtime modules by their `.js` names, so it doesn't load under
// plain Node; its routing is checked in its source, as chat.test.mjs does.
test("the chat mirror hands set-model to onModelDirective before the session handler", () => {
  const chat = fs.readFileSync(path.join(import.meta.dirname, "../src/chat.ts"), "utf-8");
  const poll = chat.slice(chat.indexOf("private async pollSessionDirectives()"));
  assert.match(poll, /if \(directive\.action === "set-model" && this\.onModelDirective\) \{[\s\S]*?continue;[\s\S]*?this\.rollingSession = true/);
  const leader = fs.readFileSync(path.join(import.meta.dirname, "../src/leader.ts"), "utf-8");
  assert.match(leader, /chat\.onModelDirective = \(directive\) => modelRealizer\.offer\(directive\)/);
  assert.match(leader, /capabilities: \[SET_MODEL_CAPABILITY, MODEL_FAILOVER_CAPABILITY\]/);
  assert.match(leader, /pi\.on\("agent_settled"[\s\S]*?modelRealizer\.runSettled\(\)/);
  const index = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf-8");
  assert.match(index, /loop\.onModelDirective = \(directive\) => modelRealizer\.offer\(directive\)/);
  assert.match(index, /pi\.on\("agent_settled"[\s\S]*?modelRealizer\.runSettled\(\)/);
  assert.match(index, /modelRealizer\.runStarted\(\)/);
});

// ─── Failover substitution (my-pizza-team docs/DESIGN.md "Model Failover") ───

test("failover with `replaces`: substitutes only a failed model — pin, persona, default or Pi's own", () => {
  const prefs = new ModelPreferences();
  prefs.set("failover", "acme/base", ["acme/strong-1", "acme/pinned"]);
  assert.strictEqual(prefs.resolve("wi-1", persona("acme/other")).origin, "persona", "a healthy persona model is kept");
  const sub = prefs.resolve("wi-1", persona("acme/strong-1"));
  assert.deepStrictEqual([sub.origin, sub.modelId], ["failover", "acme/base"], "a failed persona model is substituted");
  prefs.pin = "acme/pinned";
  assert.strictEqual(prefs.resolve("wi-1", null).origin, "failover", "a failed pin is substituted");
  prefs.pin = null;
  prefs.teamDefault = "acme/strong-1";
  assert.strictEqual(prefs.resolve(null, null).origin, "failover", "a failed team default is substituted");
  prefs.teamDefault = null;
  assert.strictEqual(prefs.resolve(null, null, { harnessModel: "acme/pinned" }).origin, "failover", "a failed Pi default is substituted");
  assert.strictEqual(prefs.resolve(null, null, { harnessModel: "acme/fine" }), null, "a healthy Pi default is kept");
  prefs.set("failover", null);
  assert.strictEqual(prefs.failoverReplaces, null, "clearing the substitute clears its list");
});

test("failover without `replaces` (an older daemon) wins outright; a probe wins over everything", () => {
  const prefs = new ModelPreferences();
  prefs.pin = "acme/pinned";
  prefs.set("failover", "acme/base");
  assert.strictEqual(prefs.resolve("wi-1", persona("acme/strong-1")).modelId, "acme/base");
  const probe = prefs.resolve("wi-1", persona("acme/strong-1"), { probe: "acme/strong-1" });
  assert.deepStrictEqual([probe.origin, probe.modelId, probe.who], ["failover", "acme/strong-1", "failover probe"]);
  assert.notStrictEqual(probe.key, prefs.resolve("wi-1", null).key, "the probe has its own switch key");
});

test("a failover set-model's `replaces` is read from the directive, and restored with it on failure", async () => {
  const { prefs, realizer, completed } = wired();
  await realizer.offer({ id: "f1", params: { model: "acme/base", source: "failover", replaces: ["acme/strong-1", 3, ""] } });
  assert.deepStrictEqual(prefs.failoverReplaces, ["acme/strong-1"]);
  await realizer.offer({ id: "f2", params: { model: "acme/nope", source: "failover", replaces: ["x"] } });
  assert.deepStrictEqual([prefs.failover, prefs.failoverReplaces], ["acme/base", ["acme/strong-1"]], "a refused one leaves the last");
  await realizer.offer({ id: "f3", params: { model: null, source: "failover" } });
  assert.deepStrictEqual([prefs.failover, prefs.failoverReplaces], [null, null]);
  assert.deepStrictEqual(completed.map((c) => c.status), ["done", "failed", "done"]);
});

test("PersonaModelSwitch.baseModel is the model before any switch", async () => {
  const { pi, ctx } = fakePi();
  const sw = new PersonaModelSwitch(pi, ctx);
  assert.strictEqual(sw.baseModel, "acme/base");
  await sw.applyTarget({ modelId: "acme/strong-1", key: "k", who: "w", label: "l" });
  assert.strictEqual(modelName(pi.model), "acme/strong-1");
  assert.strictEqual(sw.baseModel, "acme/base", "still the one it started on");
});
