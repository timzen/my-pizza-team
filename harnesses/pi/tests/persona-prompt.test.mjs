// The teammate's persona in the system prompt (src/persona-prompt.ts, the
// persona handling in src/teammate.ts, the hook in src/index.ts): the claim's
// persona becomes its own prompt section while its work item is held, is
// swapped by the next claim, and is removed once the item ends — including a
// session error's retry — so a reused Pi session never carries an earlier
// item's persona (my-pizza-team docs/DESIGN.md "The persona in the system prompt").
//
// Run: node --test --experimental-strip-types tests/persona-prompt.test.mjs

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const { PERSONA_SECTION, applyPersonaSection, personaSystemPromptText } = await import("../src/persona-prompt.ts");
const { TeammateLoop } = await import("../src/teammate.ts");

/** A claim persona as the daemon sends it to a capable harness. */
function persona(id, body, extra = {}) {
  return { id, title: id, body, prompt: `## Your Role: in_progress\n\n${body}`, inline: false, state: "in_progress", ...extra };
}

/** A `before_agent_start` event with Pi's structured prompt options. */
function event(sections = {}) {
  return { systemPrompt: "BASE", systemPromptOptions: { sections } };
}

/** Run the hook the way index.ts does, for `loop`'s current state. */
function beforeAgentStart(loop, ev) {
  return applyPersonaSection(ev, personaSystemPromptText(loop.persona));
}

/**
 * A running, autonomous loop whose daemon hands out `claims` in order, with
 * fakes recording the prompts Pi was sent.
 */
function loopWith(claims) {
  const sent = [];
  const queue = [...claims];
  const pi = { sendUserMessage: (text) => sent.push(text) };
  const client = {
    heartbeat: async () => ({}),
    postComment: async () => ({}),
    setWorkItemState: async () => ({ success: true, completed: true }),
    failWorkItemForSessionError: async () => ({ success: true }),
    getNextWork: async () => (queue.length ? { workItem: { id: queue[0].id, title: "t" } } : { workItem: null }),
    claimWorkItem: async () => {
      const c = queue.shift();
      return { success: true, prompt: c.prompt ?? `## Task: ${c.id}`, persona: c.persona };
    },
  };
  const loop = new TeammateLoop(pi, client);
  loop["running"] = true;
  loop["autonomous"] = true;
  loop.requestFreshSession = () => {};
  /** Claim the next item and start its run. */
  const claimNext = async () => { await loop["pollForWork"](); loop.handleAgentStart(); };
  return { loop, sent, claimNext };
}

test("applyPersonaSection: sets the section in place, and removes it with no persona", () => {
  const ev = event({ other: "kept" });
  assert.strictEqual(applyPersonaSection(ev, "## Your Role\n\nBe careful."), undefined, "no systemPrompt replacement");
  assert.deepStrictEqual(ev.systemPromptOptions.sections, { other: "kept", [PERSONA_SECTION]: "## Your Role\n\nBe careful." });
  applyPersonaSection(ev, null);
  assert.deepStrictEqual(ev.systemPromptOptions.sections, { other: "kept" });
});

test("applyPersonaSection: a Pi without prompt sections gets the text appended to the system prompt", () => {
  assert.deepStrictEqual(applyPersonaSection({ systemPrompt: "BASE" }, "ROLE"), { systemPrompt: "BASE\n\nROLE" });
  assert.strictEqual(applyPersonaSection({ systemPrompt: "BASE" }, null), undefined);
});

test("personaSystemPromptText: nothing for no persona, or one the daemon kept inline", () => {
  assert.strictEqual(personaSystemPromptText(null), null);
  assert.strictEqual(personaSystemPromptText(undefined), null);
  assert.strictEqual(personaSystemPromptText(persona("p", "x", { inline: true })), null);
  assert.strictEqual(personaSystemPromptText(persona("p", "x")), "## Your Role: in_progress\n\nx");
});

test("the section is added for the claimed item, swapped by the next claim, and removed after", async () => {
  const { loop, sent, claimNext } = loopWith([
    { id: "wi-1", persona: persona("implementer", "Small diffs.") },
    { id: "wi-2", persona: persona("reviewer", "Never edit code.") },
  ]);
  const sections = {};
  await claimNext();
  assert.strictEqual(sent[0], "## Task: wi-1", "the work prompt is delivered as is");
  assert.strictEqual(loop.personaId, "implementer");
  beforeAgentStart(loop, event(sections));
  assert.strictEqual(sections[PERSONA_SECTION], "## Your Role: in_progress\n\nSmall diffs.");

  loop.handleAgentEnd();
  await loop.handleAgentComplete("done");
  assert.strictEqual(loop.persona, null);
  assert.strictEqual(loop.personaId, null);
  // A run after the item ended (the fresh-session request, anything foreign): no section.
  beforeAgentStart(loop, event(sections));
  assert.strictEqual(PERSONA_SECTION in sections, false);

  await claimNext();
  beforeAgentStart(loop, event(sections));
  assert.strictEqual(sections[PERSONA_SECTION], "## Your Role: in_progress\n\nNever edit code.");
  assert.strictEqual(loop.personaId, "reviewer");
  loop.stop();
  assert.strictEqual(loop.persona, null, "stop drops it too");
});

test("a session error's retry never carries the failed attempt's persona", async () => {
  const { loop, claimNext } = loopWith([
    { id: "wi-1", persona: persona("implementer", "Small diffs.") },
    // The daemon's retry is a new item, here worked with no persona.
    { id: "wi-2", persona: null },
  ]);
  const sections = {};
  await claimNext();
  beforeAgentStart(loop, event(sections));
  assert.ok(sections[PERSONA_SECTION]);
  loop.handleAgentEnd();
  await loop.handleAgentComplete("", "Service unavailable");
  beforeAgentStart(loop, event(sections));
  assert.strictEqual(PERSONA_SECTION in sections, false, "cleared once the attempt failed");
  await claimNext();
  beforeAgentStart(loop, event(sections));
  assert.strictEqual(PERSONA_SECTION in sections, false, "the retry has no persona, so none leaks in");
  loop.stop();
});

test("the persona stays for the item's own later runs (a resume nudge), and goes when it's failed or waited", async () => {
  const { loop, sent, claimNext } = loopWith([{ id: "wi-1", persona: persona("implementer", "Small diffs.") }]);
  const sections = {};
  await claimNext();
  loop.handleAgentEnd();
  // Paired, then released with resume: a nudge run on the same item keeps it.
  loop.pause();
  await loop.releasePairing("resume", "");
  assert.ok(sent.at(-1).startsWith("You're back on autonomous work"));
  loop.handleAgentStart();
  beforeAgentStart(loop, event(sections));
  assert.strictEqual(sections[PERSONA_SECTION], "## Your Role: in_progress\n\nSmall diffs.");
  // The agent ends the item itself (fail / wait tool): gone after its run.
  loop.markReturned("wi-1");
  loop.handleAgentEnd();
  await loop.handleAgentComplete("");
  beforeAgentStart(loop, event(sections));
  assert.strictEqual(PERSONA_SECTION in sections, false);
  loop.stop();
});

test("a claim from an older daemon (no persona) adds nothing", async () => {
  const { loop, claimNext } = loopWith([{ id: "wi-1", prompt: "## Your Role: in_progress\n\nInline.\n\n## Task: x" }]);
  await claimNext();
  const ev = event();
  assert.strictEqual(beforeAgentStart(loop, ev), undefined);
  assert.deepStrictEqual(ev.systemPromptOptions.sections, {});
  loop.stop();
});

const index = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf-8");

test("index.ts declares the capability at both registrations and wires the hook to the loop's persona", () => {
  assert.match(index, /const capabilities = \[PERSONA_SYSTEM_PROMPT_CAPABILITY, SET_MODEL_CAPABILITY\]/);
  assert.strictEqual((index.match(/client\.register\(\{[^}]*capabilities/gs) ?? []).length, 2);
  assert.match(index, /pi\.on\("before_agent_start"[\s\S]*?applyPersonaSection\(event, personaSystemPromptText\(loop\.persona\)\)/);
});
