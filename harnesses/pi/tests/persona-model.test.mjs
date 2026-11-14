// The persona's model (src/persona-model.ts, its wiring in src/index.ts and
// src/leader.ts, the awaited persona hook in src/teammate.ts): the claim's
// resolved `modelId` is switched in before the work prompt is sent, kept for
// the item (a manual change within it stands), put back when the item ends,
// and a model this Pi can't use keeps the current one and is reported
// (my-pizza-team docs/DESIGN.md "Persona settings").
//
// Run: node --test --experimental-strip-types tests/persona-model.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const { ModelPreferences } = await import("../src/model-choice.ts");
const { PersonaModelSwitch, findModel, modelName } = await import("../src/persona-model.ts");
const { TeammateLoop } = await import("../src/teammate.ts");

const DEFAULT = { provider: "acme", id: "base" };
const STRONG = { provider: "acme", id: "strong-1" };
const OTHER = { provider: "other", id: "strong-1" };
const LOCKED = { provider: "locked", id: "x" };
const MODELS = [DEFAULT, STRONG, OTHER, LOCKED, { provider: "acme", id: "fast" }];

/** A fake Pi: a registry of MODELS, a live `model`, and setModel (refused for `locked`). */
function fakePi(start = DEFAULT) {
  const pi = {
    model: start,
    sets: [],
    async setModel(m) {
      pi.sets.push(modelName(m));
      if (m.provider === "locked") return false;
      pi.model = m;
      return true;
    },
  };
  const ctx = {
    get model() { return pi.model; },
    modelRegistry: {
      find: (provider, id) => MODELS.find((m) => m.provider === provider && m.id === id),
      getAll: () => MODELS,
    },
  };
  return { pi, ctx };
}

const persona = (modelId, extra = {}) => ({ id: "implementer", model: "strong", modelId, ...extra });

test("findModel: provider/id, a unique bare id, and why not otherwise", () => {
  const { ctx } = fakePi();
  assert.deepStrictEqual(findModel(ctx.modelRegistry, "acme/strong-1"), { model: STRONG });
  assert.deepStrictEqual(findModel(ctx.modelRegistry, "fast"), { model: MODELS[4] });
  assert.match(findModel(ctx.modelRegistry, "strong-1").problem, /several providers \(acme\/strong-1, other\/strong-1\)/);
  assert.match(findModel(ctx.modelRegistry, "acme/nope").problem, /isn't a model this Pi knows/);
  assert.match(findModel(ctx.modelRegistry, "nope").problem, /isn't a model this Pi knows/);
});

test("apply switches once per key; restore puts the previous model back", async () => {
  const { pi, ctx } = fakePi();
  const sw = new PersonaModelSwitch(pi, ctx);
  assert.strictEqual(await sw.apply("wi-1", persona("acme/strong-1")), null);
  assert.deepStrictEqual(pi.model, STRONG);
  assert.ok(sw.switched);
  // Someone pairing picks another model: a later run of the same item doesn't fight it.
  pi.model = MODELS[4];
  assert.strictEqual(await sw.apply("wi-1", persona("acme/strong-1")), null);
  assert.deepStrictEqual(pi.model, MODELS[4]);
  await sw.restore();
  assert.deepStrictEqual(pi.model, DEFAULT, "restored to the model before the persona's");
  assert.ok(!sw.switched);
  assert.deepStrictEqual(pi.sets, ["acme/strong-1", "acme/base"]);
});

test("apply: no persona model restores; a new key restores before switching", async () => {
  const { pi, ctx } = fakePi();
  const sw = new PersonaModelSwitch(pi, ctx);
  await sw.apply("wi-1", persona("acme/strong-1"));
  await sw.apply("wi-2", persona("acme/fast"));
  assert.deepStrictEqual(pi.model, MODELS[4]);
  await sw.apply("wi-3", persona(null)); // unmapped / switched off: the daemon sent null
  assert.deepStrictEqual(pi.model, DEFAULT);
  await sw.apply("wi-4", null);
  assert.deepStrictEqual(pi.model, DEFAULT);
  assert.deepStrictEqual(pi.sets, ["acme/strong-1", "acme/base", "acme/fast", "acme/base"]);
});

test("apply: the model already active switches nothing", async () => {
  const { pi, ctx } = fakePi(STRONG);
  const sw = new PersonaModelSwitch(pi, ctx);
  assert.strictEqual(await sw.apply("wi-1", persona("acme/strong-1")), null);
  await sw.restore();
  assert.deepStrictEqual(pi.sets, []);
});

test("apply: an unknown or unusable model keeps the current one and says why", async () => {
  const { pi, ctx } = fakePi();
  const sw = new PersonaModelSwitch(pi, ctx);
  const unknown = await sw.apply("wi-1", persona("acme/nope"));
  assert.match(unknown, /^persona implementer: model "strong" \(acme\/nope\) can't be used: "acme\/nope" isn't a model this Pi knows; keeping acme\/base\.$/);
  const refused = await sw.apply("wi-2", persona("locked/x"));
  assert.match(refused, /Pi couldn't switch to it \(no credentials for locked\?\); keeping acme\/base/);
  assert.deepStrictEqual(pi.model, DEFAULT);
  assert.ok(!sw.switched);
  assert.strictEqual(await sw.apply("wi-2", persona("locked/x")), null, "reported once per key");
});

/** A running loop whose daemon hands out `claims` in order. */
function loopWith(claims, pi, sent) {
  const queue = [...claims];
  pi.sendUserMessage = (text) => { sent.push({ text, model: modelName(pi.model) }); };
  const client = {
    heartbeat: async () => ({}),
    postComment: async () => ({}),
    setWorkItemState: async () => ({ success: true, completed: true }),
    getNextWork: async () => (queue.length ? { workItem: { id: queue[0].id, title: "t" } } : { workItem: null }),
    claimWorkItem: async () => {
      const c = queue.shift();
      return { success: true, prompt: `## Task: ${c.id}`, persona: c.persona, ...(c.failoverProbe ? { failoverProbe: c.failoverProbe } : {}) };
    },
  };
  const loop = new TeammateLoop(pi, client);
  loop["running"] = true;
  loop["autonomous"] = true;
  loop.requestFreshSession = () => {};
  return { loop, claimNext: async () => { await loop["pollForWork"](); loop.handleAgentStart(); } };
}

test("teammate: the claim's model is in place before the prompt is sent, and restored after the item", async () => {
  const { pi, ctx } = fakePi();
  const sent = [];
  const { loop, claimNext } = loopWith([
    { id: "wi-1", persona: { id: "implementer", title: "i", body: "b", prompt: "I", inline: false, model: "strong", modelId: "acme/strong-1" } },
    { id: "wi-2", persona: { id: "plain", title: "p", body: "b", prompt: "P", inline: false } },
  ], pi, sent);
  const sw = new PersonaModelSwitch(pi, ctx);
  loop.onPersonaChange = async (p) => { await sw.apply(p ? loop.currentTask : null, p); }; // as index.ts wires it
  await claimNext();
  assert.deepStrictEqual(sent, [{ text: "## Task: wi-1", model: "acme/strong-1" }], "switched before the work prompt");
  loop.handleAgentEnd();
  await loop.handleAgentComplete("done");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(pi.model, DEFAULT, "restored when the item ended");
  await claimNext();
  assert.strictEqual(sent[1].model, "acme/base", "a persona without a model runs on the default");
  loop.stop();
});

test("teammate: a claim's failover probe runs that item on the primary, above the failover substitute", async () => {
  const { pi, ctx } = fakePi();
  const sent = [];
  const { loop, claimNext } = loopWith([
    { id: "wi-1", persona: null, failoverProbe: { modelId: "acme/strong-1" } },
    { id: "wi-2", persona: null },
  ], pi, sent);
  const prefs = new ModelPreferences();
  prefs.set("failover", "acme/fast", ["acme/base", "acme/strong-1"]);
  const sw = new PersonaModelSwitch(pi, ctx);
  // As index.ts wires applyModel.
  loop.onPersonaChange = async (p) => {
    const id = loop.currentTask;
    const probe = id ? loop.failoverProbe : null;
    await sw.applyTarget(prefs.resolve(p || probe ? id : null, p, { probe, harnessModel: sw.baseModel }));
  };
  // Stop the loop even when an assertion fails: its poll timer would keep the process alive.
  try {
    await claimNext();
    assert.strictEqual(loop.failoverProbe, "acme/strong-1");
    assert.deepStrictEqual(sent, [{ text: "## Task: wi-1", model: "acme/strong-1" }], "the probe runs on the primary");
    loop.handleAgentEnd();
    await loop.handleAgentComplete("done");
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(loop.failoverProbe, null, "the probe is the item's alone");
    await claimNext();
    assert.strictEqual(sent[1].model, "acme/fast", "the next item gets the substitute for the failed Pi default");
  } finally {
    loop.stop();
  }
});

const index = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf-8");
const leader = fs.readFileSync(path.join(import.meta.dirname, "../src/leader.ts"), "utf-8");

test("index.ts and leader.ts wire the model switch", () => {
  assert.match(index, /new PersonaModelSwitch\(pi, ctx\)/);
  assert.match(index, /loop\.onPersonaChange = async \(persona\) => \{[\s\S]*?await applyModel\(loop\.currentTask, persona\)/);
  assert.match(index, /pi\.on\("before_agent_start"[\s\S]*?await applyModel\(workItemId, persona\)/);
  assert.match(index, /reportScopeOnce\(reportedModel, workItemId, \[problem\],[\s\S]*?client\.postComment\(workItemId, text\)/);
  assert.match(leader, /new PersonaModelSwitch\(pi, ctx\)/);
  // Both apply the effective model (model-choice.ts), of which the persona's is one input.
  // ... with a failover probe (teammate only) and the base model a failover may substitute.
  assert.match(index, /modelPrefs\.resolve\(persona \|\| probe \? workItemId : null, persona, \{ probe, harnessModel: modelSwitch\.baseModel \}\)[\s\S]*?modelSwitch\.applyTarget\(target\)/);
  assert.match(leader, /modelPrefs\.resolve\(persona \? persona\.id \?\? "" : null, persona, \{ harnessModel: modelSwitch\.baseModel \}\)[\s\S]*?modelSwitch\.applyTarget\(target\)/);
});
